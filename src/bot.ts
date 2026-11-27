// MA-бот для Bybit Spot: конфиг, состояние, брокеры, уведомления, проверка сигнала.

import * as fs from "node:fs";
import * as path from "node:path";
import ccxt from "ccxt";
import { buyBudget, closedCandles, computeSignal, DAY_MS, type Candle } from "./strategy";

// --------------------------------------------------------------------------
// Конфиг
// --------------------------------------------------------------------------

export interface Config {
  mode: "paper" | "testnet" | "live";
  apiKey: string;
  apiSecret: string;
  symbol: string;
  maPeriod: number;
  sizing: "all" | "fixed";
  fixedAmountQuote: number;
  reservePct: number;
  maxOrderQuote: number;
  minPositionQuote: number;
  checkIntervalMinutes: number;
  executionDelayMinutes: number;
  paperStartQuote: number;
  feePct: number;
  execution: "market" | "limit";
  limitOffsetPct: number;
  limitTimeoutHours: number;
  telegramToken: string;
  telegramChatId: string;
  telegramDailyReport: boolean;
  dataDir: string;
}

export const DEFAULT_CONFIG: Config = {
  mode: "paper",
  apiKey: "",
  apiSecret: "",
  symbol: "BTC/USDT",
  maPeriod: 50,
  sizing: "all",
  fixedAmountQuote: 1000,
  reservePct: 0.5,
  maxOrderQuote: 3000,
  minPositionQuote: 10,
  checkIntervalMinutes: 15,
  executionDelayMinutes: 5,
  paperStartQuote: 1000,
  feePct: 0.1,
  execution: "market",
  limitOffsetPct: 0.3,
  limitTimeoutHours: 4,
  telegramToken: "",
  telegramChatId: "",
  telegramDailyReport: true,
  dataDir: "data",
};

export function loadConfig(file: string): Config {
  let fromFile: Partial<Config> = {};
  if (fs.existsSync(file)) fromFile = JSON.parse(fs.readFileSync(file, "utf8"));
  else console.warn(`Файл ${file} не найден - использую настройки по умолчанию (режим paper).`);
  const cfg: Config = { ...DEFAULT_CONFIG, ...fromFile };
  // ключи лучше хранить в переменных окружения (.env), а не в config.json
  const env = process.env;
  cfg.apiKey = env.BYBIT_API_KEY || cfg.apiKey;
  cfg.apiSecret = env.BYBIT_API_SECRET || cfg.apiSecret;
  cfg.telegramToken = env.TELEGRAM_TOKEN || cfg.telegramToken;
  cfg.telegramChatId = env.TELEGRAM_CHAT_ID || cfg.telegramChatId;
  if (env.BOT_MODE) cfg.mode = env.BOT_MODE as Config["mode"];
  validateConfig(cfg);
  cfg.dataDir = path.resolve(path.dirname(path.resolve(file)), cfg.dataDir);
  fs.mkdirSync(cfg.dataDir, { recursive: true });
  return cfg;
}

export function validateConfig(cfg: Config) {
  const fail = (m: string) => {
    throw new Error(`Ошибка в настройках: ${m}`);
  };
  if (!["paper", "testnet", "live"].includes(cfg.mode)) fail("mode должен быть paper, testnet или live");
  if (!["all", "fixed"].includes(cfg.sizing)) fail("sizing должен быть all или fixed");
  if (!Number.isInteger(cfg.maPeriod) || cfg.maPeriod < 2 || cfg.maPeriod > 500) fail("maPeriod должен быть от 2 до 500");
  if (cfg.reservePct < 0 || cfg.reservePct >= 50) fail("reservePct должен быть от 0 до 50");
  if (cfg.checkIntervalMinutes < 1) fail("checkIntervalMinutes должен быть не меньше 1");
  if (cfg.mode !== "paper" && !(cfg.apiKey && cfg.apiSecret)) fail("для testnet/live нужны BYBIT_API_KEY и BYBIT_API_SECRET");
  if (!/^[A-Z0-9]+\/[A-Z0-9]+$/.test(cfg.symbol)) fail("symbol должен быть вида BTC/USDT");
  if (!["market", "limit"].includes(cfg.execution)) fail("execution должен быть market или limit");
  if (!(cfg.limitOffsetPct > 0 && cfg.limitOffsetPct <= 5)) fail("limitOffsetPct должен быть больше 0 и не больше 5");
  if (!(cfg.limitTimeoutHours >= 0.25 && cfg.limitTimeoutHours <= 20)) fail("limitTimeoutHours должен быть от 0.25 до 20");
}

// --------------------------------------------------------------------------
// Логи, состояние, журнал сделок
// --------------------------------------------------------------------------

export class Logger {
  constructor(private file: string | null) {}
  private write(level: string, msg: string) {
    const line = `${new Date().toISOString().replace("T", " ").slice(0, 19)} ${level} ${msg}`;
    (level === "ERROR" ? console.error : console.log)(line);
    if (this.file) fs.appendFileSync(this.file, line + "\n");
  }
  info(m: string) { this.write("INFO", m); }
  warn(m: string) { this.write("WARN", m); }
  error(m: string) { this.write("ERROR", m); }
}

export interface State {
  lastCandleTs?: number;
  lastCheck?: string;
  lastSignal?: { day: string; close: number; ma: number; want: string; action: string };
  paper?: Record<string, number>;
  pending?: Pending;
}

export function loadState(cfg: Config): State {
  const f = path.join(cfg.dataDir, `state-${cfg.mode}.json`);
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : {};
}

export function saveState(cfg: Config, state: State) {
  const f = path.join(cfg.dataDir, `state-${cfg.mode}.json`);
  fs.writeFileSync(f + ".tmp", JSON.stringify(state, null, 2));
  fs.renameSync(f + ".tmp", f); // атомарная запись
}

function recordTrade(cfg: Config, row: (string | number)[]) {
  const f = path.join(cfg.dataDir, "trades.csv");
  if (!fs.existsSync(f)) fs.writeFileSync(f, "time_utc,mode,side,price,amount_base,cost_quote,order_id,reason\n");
  fs.appendFileSync(f, row.join(",") + "\n");
}

export const fmtDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
export const fmtTime = (ms: number) => new Date(ms).toISOString().replace("T", " ").slice(0, 16) + " UTC";
const stopFile = (cfg: Config) => path.join(cfg.dataDir, "..", "STOP");

// --------------------------------------------------------------------------
// Уведомления в Telegram
// --------------------------------------------------------------------------

export class Notifier {
  constructor(private cfg: Config, private log: Logger) {}
  async send(text: string) {
    const prefix = this.cfg.mode === "live" ? "" : `[${this.cfg.mode.toUpperCase()}] `;
    this.log.info(`Уведомление: ${text.replace(/\n/g, " | ")}`);
    if (!this.cfg.telegramToken || !this.cfg.telegramChatId) return;
    try {
      await fetch(`https://api.telegram.org/bot${this.cfg.telegramToken}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: this.cfg.telegramChatId, text: prefix + text }),
        signal: AbortSignal.timeout(15000),
      });
    } catch (e) {
      this.log.warn(`Не удалось отправить в Telegram: ${(e as Error).message}`);
    }
  }
}

// --------------------------------------------------------------------------
// Биржа и брокеры
// --------------------------------------------------------------------------

/** Минимальный набор методов ccxt, которые использует бот (удобно подменять в тестах). */
export interface ExchangeLike {
  has: Record<string, unknown>;
  milliseconds(): number;
  loadMarkets(): Promise<unknown>;
  market(symbol: string): any;
  fetchOHLCV(symbol: string, timeframe: string, since?: number, limit?: number): Promise<any[]>;
  fetchTicker(symbol: string): Promise<{ last?: number }>;
  fetchBalance(): Promise<any>;
  createOrder(symbol: string, type: string, side: string, amount: number, price?: number): Promise<any>;
  createMarketBuyOrderWithCost?(symbol: string, cost: number): Promise<any>;
  fetchOrder(id: string, symbol?: string, params?: Record<string, unknown>): Promise<any>;
  cancelOrder(id: string, symbol?: string): Promise<any>;
  amountToPrecision(symbol: string, amount: number): string;
  costToPrecision(symbol: string, cost: number): string;
  priceToPrecision(symbol: string, price: number): string;
}

export async function makeExchange(cfg: Config, publicOnly = false): Promise<ExchangeLike> {
  const opts: any = { enableRateLimit: true, options: { defaultType: "spot" } };
  if (!publicOnly && cfg.mode !== "paper") {
    opts.apiKey = cfg.apiKey;
    opts.secret = cfg.apiSecret;
  }
  const ex = new ccxt.bybit(opts);
  if (cfg.mode === "testnet") ex.setSandboxMode(true);
  await ex.loadMarkets();
  if (!ex.markets?.[cfg.symbol]) throw new Error(`Пара ${cfg.symbol} не найдена на Bybit Spot`);
  return ex as unknown as ExchangeLike;
}

export interface Fill { id: string; price: number; amount: number; cost: number }
export type Side = "buy" | "sell";
export type LimitStatus = "open" | "filled" | "gone";

/** Открытый лимитный ордер, который бот ведёт между проверками (хранится в state). */
export interface Pending {
  side: Side;
  id: string;
  price: number;
  amount: number;
  budget: number; // для покупки: сколько USDT собирались потратить
  placedAt: number;
  deadline: number;
  before: { base: number; quote: number }; // балансы до выставления ордера
  day: string;
  close: number;
  ma: number;
  note: string; // пометки (опоздание, лимит суммы) для итогового уведомления
}

export interface Broker {
  base: string;
  quote: string;
  price(): Promise<number>;
  balances(): Promise<{ base: number; quote: number }>;
  buy(cost: number): Promise<Fill>;
  sellAll(): Promise<Fill>;
  /** Выставить лимитный ордер. Возвращает id и цену/количество после округления. */
  placeLimit(side: Side, price: number, amount: number): Promise<{ id: string; price: number; amount: number }>;
  limitStatus(p: Pending, nowMs: number): Promise<LimitStatus>;
  cancelLimit(p: Pending): Promise<void>;
}

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

export function makeBroker(cfg: Config, ex: ExchangeLike, state: State): Broker {
  return cfg.mode === "paper" ? new PaperBroker(cfg, ex, state) : new ExchangeBroker(cfg, ex);
}

// --------------------------------------------------------------------------
// Одна проверка сигнала и исполнение
// --------------------------------------------------------------------------

export async function fetchClosedDaily(ex: ExchangeLike, symbol: string, count: number, nowMs: number): Promise<Candle[]> {
  const raw = (await ex.fetchOHLCV(symbol, "1d", undefined, count + 2)) as Candle[];
  return closedCandles(raw, nowMs, count);
}

export type Action =
  | "wait" | "already_processed" | "hold" | "buy" | "sell" | "stopped"
  | "limit_placed" | "limit_pending" | "limit_filled" | "limit_timeout";

const sideRu = (s: Side) => (s === "buy" ? "ПОКУПКА" : "ПРОДАЖА");

/** Ведём открытую лимитку: исполнилась / ждём / по таймауту отменяем и добиваем остаток по рынку. */
async function processPending(
  cfg: Config, broker: Broker, state: State, notifier: Notifier, log: Logger, nowMs: number,
): Promise<Action | null> {
  const p = state.pending;
  if (!p) return null;

  if (fs.existsSync(stopFile(cfg))) {
    await broker.cancelLimit(p);
    state.pending = undefined;
    await notifier.send(`Найден файл STOP - лимитный ордер ${sideRu(p.side).toLowerCase()} отменён. Если он исполнился частично, остаток не добирается.`);
    return "stopped";
  }

  let status = await broker.limitStatus(p, nowMs);
  let how = `лимитным ордером по ${p.price.toFixed(2)}`;
  let action: Action = "limit_filled";

  if (status === "open" && nowMs < p.deadline) return "limit_pending";

  if (status !== "filled") {
    // таймаут или ордер отменён на бирже: снимаем остаток и добиваем по рынку
    if (status === "open") await broker.cancelLimit(p);
    action = "limit_timeout";
    const bal = await broker.balances();
    const price = await broker.price();
    if (p.side === "buy") {
      const spent = Math.max(0, p.before.quote - bal.quote);
      const remaining = p.budget - spent;
      if (remaining >= Math.max(cfg.minPositionQuote, p.budget * 0.01)) {
        try {
          await broker.buy(Math.min(remaining, bal.quote));
        } catch (e) {
          log.warn(`Остаток покупки не добран: ${(e as Error).message}`);
        }
      }
      how = spent > 1 ? `частично лимиткой, остаток по рынку` : `по рынку (лимитка ${p.price.toFixed(2)} не исполнилась за ${cfg.limitTimeoutHours} ч)`;
    } else {
      if (bal.base * price >= cfg.minPositionQuote) await broker.sellAll();
      const sold = Math.max(0, p.before.base - bal.base);
      how = sold > 0 ? `частично лимиткой, остаток по рынку` : `по рынку (лимитка ${p.price.toFixed(2)} не исполнилась за ${cfg.limitTimeoutHours} ч)`;
    }
  }

  const after = await broker.balances();
  const amount = Math.abs(after.base - p.before.base);
  const cost = Math.abs(after.quote - p.before.quote);
  const avg = amount > 0 ? cost / amount : p.price;
  recordTrade(cfg, [fmtTime(nowMs), cfg.mode, p.side, avg.toFixed(2), amount.toFixed(8), cost.toFixed(2), p.id,
    `${p.side === "buy" ? "close>" : "close<="}MA${cfg.maPeriod} ${action}`]);
  await notifier.send(
    `${sideRu(p.side)} ${cfg.symbol} исполнена ${how}\n` +
    `Средняя цена ~${avg.toFixed(2)}, ${p.side === "buy" ? "потрачено" : "получено"} ${cost.toFixed(2)} ${broker.quote}\n` +
    `Закрытие ${p.day}: ${p.close.toFixed(2)} ${p.side === "buy" ? ">" : "<="} MA${cfg.maPeriod} ${p.ma.toFixed(2)}` + p.note,
  );
  state.pending = undefined;
  return action;
}

export async function checkAndTrade(
  cfg: Config, ex: ExchangeLike, broker: Broker, state: State, notifier: Notifier, log: Logger,
  opts: { nowMs?: number; force?: boolean } = {},
): Promise<Action> {
  const nowMs = opts.nowMs ?? ex.milliseconds();

  // 1. Если висит лимитный ордер - сначала разбираемся с ним
  const pendingAction = await processPending(cfg, broker, state, notifier, log, nowMs);
  if (pendingAction) {
    state.lastCheck = fmtTime(nowMs);
    saveState(cfg, state);
    if (pendingAction === "limit_pending" || pendingAction === "stopped") return pendingAction;
  }

  // 2. Новый дневной сигнал
  const sig = computeSignal(await fetchClosedDaily(ex, cfg.symbol, cfg.maPeriod, nowMs), cfg.maPeriod);

  // действуем один раз на каждую новую закрытую дневную свечу, с небольшой задержкой после 00:00 UTC
  const readyAt = sig.candleTs + DAY_MS + cfg.executionDelayMinutes * 60_000;
  if (!opts.force && nowMs < readyAt) return pendingAction ?? "wait";
  if (!opts.force && state.lastCandleTs === sig.candleTs) return pendingAction ?? "already_processed";

  const price = await broker.price();
  const bal = await broker.balances();
  const inPos = bal.base * price >= cfg.minPositionQuote;
  const day = fmtDay(sig.candleTs);
  const p = cfg.maPeriod;
  // если бот был выключен и проверяет день с опозданием больше 2 часов - отметим это в уведомлении
  const lateHours = (nowMs - (sig.candleTs + DAY_MS)) / 3_600_000;
  const lateNote = lateHours > 2 ? `\nИсполнено с опозданием: ${lateHours.toFixed(1)} ч после закрытия дня.` : "";
  log.info(
    `Свеча ${day}: закрытие ${sig.close.toFixed(2)}, MA${p} ${sig.ma.toFixed(2)} -> держать ${sig.wantBase ? broker.base : broker.quote}; ` +
    `баланс ${bal.base.toFixed(8)} ${broker.base} / ${bal.quote.toFixed(2)} ${broker.quote}; позиция: ${inPos ? "да" : "нет"}`,
  );

  let action: Action = "hold";
  const useLimit = cfg.execution === "limit";
  const offset = cfg.limitOffsetPct / 100;
  const sigInfo = { day, close: sig.close, ma: sig.ma };

  if (fs.existsSync(stopFile(cfg))) {
    action = "stopped";
    await notifier.send("Найден файл STOP - торговля приостановлена, сигнал не исполнен.");
  } else if (sig.wantBase && !inPos) {
    const budget = buyBudget(cfg, bal.quote);
    const uncapped = buyBudget({ ...cfg, maxOrderQuote: 0 }, bal.quote);
    const capNote = uncapped > budget + 1
      ? `\nСработал лимит ${cfg.maxOrderQuote} ${broker.quote}: ~${(uncapped - budget).toFixed(2)} ${broker.quote} остались не вложены.`
      : "";
    if (useLimit) {
      const lim = await broker.placeLimit("buy", price * (1 - offset), (budget * (1 - cfg.feePct / 100)) / (price * (1 - offset)));
      state.pending = { side: "buy", id: lim.id, price: lim.price, amount: lim.amount, budget, placedAt: nowMs,
        deadline: nowMs + cfg.limitTimeoutHours * 3_600_000, before: bal, ...sigInfo, note: lateNote + capNote };
      action = "limit_placed";
      await notifier.send(`Сигнал на ПОКУПКУ ${cfg.symbol}: выставлен лимитный ордер ${lim.amount} ${broker.base} по ${lim.price.toFixed(2)} ` +
        `(на ${cfg.limitOffsetPct}% ниже рынка). Если не исполнится за ${cfg.limitTimeoutHours} ч - докуплю по рынку.`);
    } else {
      const fill = await broker.buy(budget);
      action = "buy";
      recordTrade(cfg, [fmtTime(nowMs), cfg.mode, "buy", fill.price.toFixed(2), fill.amount.toFixed(8), fill.cost.toFixed(2), fill.id, `close>MA${p}`]);
      await notifier.send(
        `ПОКУПКА ${cfg.symbol}\nЦена ~${fill.price.toFixed(2)}, потрачено ${fill.cost.toFixed(2)} ${broker.quote}\n` +
        `Закрытие ${day}: ${sig.close.toFixed(2)} > MA${p} ${sig.ma.toFixed(2)}` + lateNote + capNote,
      );
    }
  } else if (!sig.wantBase && inPos) {
    if (useLimit) {
      const lim = await broker.placeLimit("sell", price * (1 + offset), bal.base);
      state.pending = { side: "sell", id: lim.id, price: lim.price, amount: lim.amount, budget: 0, placedAt: nowMs,
        deadline: nowMs + cfg.limitTimeoutHours * 3_600_000, before: bal, ...sigInfo, note: lateNote };
      action = "limit_placed";
      await notifier.send(`Сигнал на ПРОДАЖУ ${cfg.symbol}: выставлен лимитный ордер ${lim.amount} ${broker.base} по ${lim.price.toFixed(2)} ` +
        `(на ${cfg.limitOffsetPct}% выше рынка). Если не исполнится за ${cfg.limitTimeoutHours} ч - продам остаток по рынку.`);
    } else {
      const fill = await broker.sellAll();
      action = "sell";
      recordTrade(cfg, [fmtTime(nowMs), cfg.mode, "sell", fill.price.toFixed(2), fill.amount.toFixed(8), fill.cost.toFixed(2), fill.id, `close<=MA${p}`]);
      await notifier.send(
        `ПРОДАЖА ${cfg.symbol}\nЦена ~${fill.price.toFixed(2)}, получено ~${fill.cost.toFixed(2)} ${broker.quote}\n` +
        `Закрытие ${day}: ${sig.close.toFixed(2)} <= MA${p} ${sig.ma.toFixed(2)}` + lateNote,
      );
    }
  } else if (cfg.telegramDailyReport) {
    const total = bal.quote + bal.base * price;
    await notifier.send(
      `${day}: без изменений, держим ${inPos ? broker.base : broker.quote}.\n` +
      `Закрытие ${sig.close.toFixed(2)}, MA${p} ${sig.ma.toFixed(2)}. Баланс ~${total.toFixed(2)} ${broker.quote}`,
    );
  }

  if (action !== "stopped") state.lastCandleTs = sig.candleTs;
  state.lastCheck = fmtTime(nowMs);
  state.lastSignal = { day, close: sig.close, ma: Math.round(sig.ma * 100) / 100, want: sig.wantBase ? broker.base : broker.quote, action };
  saveState(cfg, state);
  return action;
}
