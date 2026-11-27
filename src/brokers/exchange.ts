import type { Config } from "../config";
import type { ExchangeLike } from "../exchange";
import type { Broker, Fill, LimitStatus, Pending, Side } from "./types";

/** Реальные ордера (testnet или live). */
export class ExchangeBroker implements Broker {
  base: string;
  quote: string;
  private market: any;
  constructor(private cfg: Config, private ex: ExchangeLike, private settleMs = 2000) {
    this.market = ex.market(cfg.symbol);
    this.base = this.market.base;
    this.quote = this.market.quote;
  }
  async price() {
    const t = await this.ex.fetchTicker(this.cfg.symbol);
    if (!t.last) throw new Error("Биржа не вернула цену");
    return t.last;
  }
  async balances() {
    const bal = await this.ex.fetchBalance();
    const free = bal.free ?? {};
    return { base: Number(free[this.base] ?? 0), quote: Number(free[this.quote] ?? 0) };
  }
  minCost(price: number) {
    const lim = this.market.limits ?? {};
    return Math.max(Number(lim.cost?.min ?? 0), Number(lim.amount?.min ?? 0) * price, 1);
  }
  private settle() { return new Promise((r) => setTimeout(r, this.settleMs)); }
  /** Итог сделки считаем по изменению балансов - это надёжнее, чем разбирать ответ биржи. */
  private async summarize(order: any, before: { base: number; quote: number }, fallbackPrice: number): Promise<Fill> {
    await this.settle();
    const after = await this.balances();
    const dBase = Math.abs(after.base - before.base);
    const dQuote = Math.abs(after.quote - before.quote);
    return { id: String(order?.id ?? ""), price: dBase > 0 ? dQuote / dBase : fallbackPrice, amount: dBase, cost: dQuote };
  }
  async buy(cost: number): Promise<Fill> {
    const price = await this.price();
    cost = Number(this.ex.costToPrecision(this.cfg.symbol, cost));
    if (cost < this.minCost(price)) throw new Error(`Сумма покупки ${cost} ${this.quote} меньше минимального ордера биржи`);
    const before = await this.balances();
    let order;
    if (this.ex.has["createMarketBuyOrderWithCost"] && this.ex.createMarketBuyOrderWithCost) {
      order = await this.ex.createMarketBuyOrderWithCost(this.cfg.symbol, cost);
    } else {
      const amount = Number(this.ex.amountToPrecision(this.cfg.symbol, cost / price));
      order = await this.ex.createOrder(this.cfg.symbol, "market", "buy", amount, price);
    }
    return this.summarize(order, before, price);
  }
  async sellAll(): Promise<Fill> {
    const price = await this.price();
    const before = await this.balances();
    const amount = Number(this.ex.amountToPrecision(this.cfg.symbol, before.base));
    if (amount * price < this.minCost(price)) throw new Error(`Остаток ${amount} ${this.base} меньше минимального ордера биржи`);
    const order = await this.ex.createOrder(this.cfg.symbol, "market", "sell", amount);
    return this.summarize(order, before, price);
  }
  async placeLimit(side: Side, price: number, amount: number) {
    const px = Number(this.ex.priceToPrecision(this.cfg.symbol, price));
    const qty = Number(this.ex.amountToPrecision(this.cfg.symbol, amount));
    if (qty * px < this.minCost(px)) throw new Error(`Лимитный ордер ${qty} ${this.base} меньше минимального ордера биржи`);
    const order = await this.ex.createOrder(this.cfg.symbol, "limit", side, qty, px);
    return { id: String(order.id), price: px, amount: qty };
  }
  async limitStatus(p: Pending): Promise<LimitStatus> {
    const o = await this.ex.fetchOrder(p.id, this.cfg.symbol, { acknowledged: true });
    if (o?.status === "closed") return "filled";
    if (o?.status === "canceled" || o?.status === "rejected" || o?.status === "expired") return "gone";
    return "open";
  }
  async cancelLimit(p: Pending) {
    try {
      await this.ex.cancelOrder(p.id, this.cfg.symbol);
    } catch (e) {
      // ордер мог успеть исполниться или уже быть отменён - проверим статус
      const st = await this.limitStatus(p).catch(() => "open" as LimitStatus);
      if (st === "open") throw e;
    }
    await this.settle();
  }
}
