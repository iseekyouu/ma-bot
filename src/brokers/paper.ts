import type { Config } from "../config";
import type { ExchangeLike } from "../exchange";
import type { State } from "../storage";
import type { Candle } from "../strategy";
import type { Broker, Fill, LimitStatus, Pending, Side } from "./types";

/** Бумажная торговля: реальные цены, виртуальный баланс, ордеров нет. */
export class PaperBroker implements Broker {
  base: string;
  quote: string;
  constructor(private cfg: Config, private ex: ExchangeLike, private state: State) {
    [this.base, this.quote] = cfg.symbol.split("/");
    state.paper ??= {};
    state.paper[this.quote] ??= cfg.paperStartQuote;
    state.paper[this.base] ??= 0;
  }
  private get fee() { return this.cfg.feePct / 100; }
  async price() {
    const t = await this.ex.fetchTicker(this.cfg.symbol);
    if (!t.last) throw new Error("Биржа не вернула цену");
    return t.last;
  }
  async balances() {
    return { base: this.state.paper![this.base], quote: this.state.paper![this.quote] };
  }
  async buy(cost: number): Promise<Fill> {
    const price = await this.price();
    const amount = (cost * (1 - this.fee)) / price;
    this.state.paper![this.quote] -= cost;
    this.state.paper![this.base] += amount;
    return { id: "paper", price, amount, cost };
  }
  async sellAll(): Promise<Fill> {
    const price = await this.price();
    const amount = this.state.paper![this.base];
    const proceeds = amount * price * (1 - this.fee);
    this.state.paper![this.base] = 0;
    this.state.paper![this.quote] += proceeds;
    return { id: "paper", price, amount, cost: proceeds };
  }
  async placeLimit(_side: Side, price: number, amount: number) {
    return { id: "paper-limit", price, amount };
  }
  /** Лимитка считается исполненной, если минутные свечи после выставления дотянулись до цены. */
  async limitStatus(p: Pending, nowMs: number): Promise<LimitStatus> {
    const from = Math.floor(p.placedAt / 60_000) * 60_000;
    const candles = (await this.ex.fetchOHLCV(this.cfg.symbol, "1m", from, 1000)) as Candle[];
    const touched = candles.some((c) => c[0] >= from && c[0] + 60_000 <= nowMs && (p.side === "buy" ? c[3] <= p.price : c[2] >= p.price));
    if (!touched) return "open";
    const paper = this.state.paper!;
    if (p.side === "buy") {
      paper[this.quote] -= p.amount * p.price;
      paper[this.base] += p.amount * (1 - this.fee);
    } else {
      const amount = Math.min(p.amount, paper[this.base]);
      paper[this.base] -= amount;
      paper[this.quote] += amount * p.price * (1 - this.fee);
    }
    return "filled";
  }
  async cancelLimit(_p: Pending) {}
}
