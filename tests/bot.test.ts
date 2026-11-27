import { describe, expect, test, beforeEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  checkAndTrade, DEFAULT_CONFIG, ExchangeBroker, Logger, Notifier, PaperBroker, validateConfig,
  type Config, type ExchangeLike, type State,
} from "../src/bot";
import { backtest, buyBudget, computeSignal, DAY_MS, type Candle } from "../src/strategy";

const T0 = Date.UTC(2026, 0, 1);

/** Дневные свечи с заданными ценами закрытия (open = предыдущее закрытие). */
function makeCandles(closes: number[]): Candle[] {
  return closes.map((c, i) => [T0 + i * DAY_MS, i ? closes[i - 1] : c, c * 1.01, c * 0.99, c, 1]);
}

/** Фейковая биржа: свечи, цена, балансы, рыночные и лимитные ордера. */
class MockExchange implements ExchangeLike {
  has: Record<string, unknown> = { createMarketBuyOrderWithCost: true };
  candles: Candle[] = [];
  minute: Candle[] = [];
  now = 0;
  last = 100;
  bal = { BTC: 0, USDT: 0 };
  orders: any[] = [];
  fee = 0.001;
  milliseconds() { return this.now; }
  async loadMarkets() { return {}; }
  market() { return { base: "BTC", quote: "USDT", limits: { cost: { min: 5 }, amount: { min: 0.000001 } } }; }
  async fetchOHLCV(_s: string, tf: string, since?: number, limit = 100) {
    if (tf === "1m") return this.minute.filter((c) => c[0] >= (since ?? 0) && c[0] <= this.now).slice(0, limit);
    // как настоящая биржа: возвращаем и текущую незакрытую свечу
    return this.candles.filter((c) => c[0] <= this.now).slice(-limit);
  }
  async fetchTicker() { return { last: this.last }; }
  async fetchBalance() { return { free: { ...this.bal } }; }
  async createMarketBuyOrderWithCost(_s: string, cost: number) {
    if (cost > this.bal.USDT + 1e-9) throw new Error("insufficient");
    this.bal.USDT -= cost;
    this.bal.BTC += (cost / this.last) * (1 - this.fee);
    const o = { id: `b${this.orders.length}`, type: "market", side: "buy", cost, status: "closed" };
    this.orders.push(o);
    return o;
  }
  async createOrder(_s: string, type: string, side: string, amount: number, price?: number) {
    if (type === "limit") {
      // как на бирже: средства блокируются под ордер
      if (side === "buy") { if (amount * price! > this.bal.USDT + 1e-9) throw new Error("insufficient"); this.bal.USDT -= amount * price!; }
      else { if (amount > this.bal.BTC + 1e-12) throw new Error("insufficient"); this.bal.BTC -= amount; }
      const o = { id: `l${this.orders.length}`, type, side, amount, price, filled: 0, status: "open" };
      this.orders.push(o);
      return o;
    }
    if (side !== "sell" || amount > this.bal.BTC + 1e-12) throw new Error("bad order");
    this.bal.BTC -= amount;
    this.bal.USDT += amount * this.last * (1 - this.fee);
    const o = { id: `s${this.orders.length}`, type, side, amount, status: "closed" };
    this.orders.push(o);
    return o;
  }
  /** Тестовый помощник: исполнить долю лимитного ордера. */
  fillLimit(id: string, frac: number) {
    const o = this.orders.find((x) => x.id === id);
    const q = o.amount * frac;
    o.filled += q;
    if (o.side === "buy") this.bal.BTC += q * (1 - this.fee);
    else this.bal.USDT += q * o.price * (1 - this.fee);
    if (o.filled >= o.amount - 1e-12) o.status = "closed";
  }
  async fetchOrder(id: string) { return this.orders.find((x) => x.id === id); }
  async cancelOrder(id: string) {
    const o = this.orders.find((x) => x.id === id);
    if (o.status !== "open") throw new Error("order not open");
    const rest = o.amount - o.filled;
    if (o.side === "buy") this.bal.USDT += rest * o.price; else this.bal.BTC += rest;
    o.status = "canceled";
    return o;
  }
  amountToPrecision(_s: string, a: number) { return (Math.floor(a * 1e6) / 1e6).toFixed(6); }
  costToPrecision(_s: string, c: number) { return (Math.floor(c * 100) / 100).toFixed(2); }
  priceToPrecision(_s: string, p: number) { return p.toFixed(2); }
}

let dir: string;
let cfg: Config;
const log = new Logger(null);

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mabot-"));
  cfg = { ...DEFAULT_CONFIG, maPeriod: 5, dataDir: path.join(dir, "data"), telegramDailyReport: false };
  fs.mkdirSync(cfg.dataDir);
});

// 10 дней роста, потом 10 дней падения
const UP_DOWN = [100, 101, 102, 103, 104, 105, 106, 107, 108, 110, 105, 100, 95, 90, 85, 80, 78, 76, 74, 72];

describe("стратегия", () => {
  test("сигнал MA", () => {
    const s = computeSignal(makeCandles([10, 10, 10, 10, 12]), 5);
    expect(s.ma).toBeCloseTo(10.4);
    expect(s.wantBase).toBe(true);
    expect(computeSignal(makeCandles([12, 12, 12, 12, 10]), 5).wantBase).toBe(false);
    expect(() => computeSignal(makeCandles([1, 2]), 5)).toThrow();
  });

  test("размер покупки: весь баланс, фикс и лимит", () => {
    const base = { sizing: "all" as const, fixedAmountQuote: 1000, reservePct: 0.5, maxOrderQuote: 0 };
    expect(buyBudget(base, 2000)).toBeCloseTo(1990);
    expect(buyBudget({ ...base, sizing: "fixed" }, 2000)).toBe(1000);
    expect(buyBudget({ ...base, maxOrderQuote: 3000 }, 5000)).toBe(3000);
    expect(buyBudget({ ...base, maxOrderQuote: 3000 }, 1000)).toBeCloseTo(995);
  });

  test("бэктест: вход на росте, выход на падении", () => {
    const r = backtest(makeCandles(UP_DOWN), 5, 100, 0.1, 1000);
    expect(r.entries).toBe(1);
    expect(r.trades[0].sellTs).toBeDefined();
    expect(r.inPosition).toBe(false);
  });

  test("валидация настроек", () => {
    expect(() => validateConfig({ ...DEFAULT_CONFIG, mode: "live" })).toThrow(/BYBIT_API_KEY/);
    expect(() => validateConfig({ ...DEFAULT_CONFIG, maPeriod: 1 })).toThrow();
    expect(() => validateConfig({ ...DEFAULT_CONFIG })).not.toThrow();
  });
});

describe("цикл бота на фейковой бирже", () => {
  function setup(mode: "paper" | "live", extra: Partial<Config> = {}) {
    const ex = new MockExchange();
    ex.candles = makeCandles(UP_DOWN);
    ex.bal = { BTC: 0, USDT: 5000 };
    const state: State = {};
    const c = { ...cfg, mode, paperStartQuote: 1000, ...extra };
    const broker = mode === "paper" ? new PaperBroker(c, ex, state) : new ExchangeBroker(c, ex, 0);
    const notes: string[] = [];
    const notifier = new Notifier(c, log);
    notifier.send = async (t: string) => { notes.push(t); };
    // "сейчас" = начало дня idx + 00:06 UTC, т.е. день idx-1 только что закрылся
    const at = (idx: number) => {
      ex.now = T0 + idx * DAY_MS + 6 * 60_000;
      ex.last = ex.candles[idx - 1][4];
    };
    return { ex, state, c, broker, notes, notifier, at };
  }

  test("live: покупка с лимитом 3000, повтор не торгует, затем продажа", async () => {
    const { ex, state, c, broker, notes, notifier, at } = setup("live");
    at(6); // закрылся день 5 (105) > MA5 -> покупка
    expect(await checkAndTrade(c, ex, broker, state, notifier, log)).toBe("buy");
    expect(ex.orders[0].cost).toBe(3000); // лимит сработал при балансе 5000
    expect(ex.bal.USDT).toBeCloseTo(2000);
    expect(notes[0]).toContain("Сработал лимит");

    expect(await checkAndTrade(c, ex, broker, state, notifier, log)).toBe("already_processed");
    expect(ex.orders.length).toBe(1);

    // день ещё не закрылся + задержка не прошла -> ждём
    ex.now = T0 + 7 * DAY_MS + 60_000;
    expect(await checkAndTrade(c, ex, broker, state, notifier, log)).toBe("wait");

    at(8);
    expect(await checkAndTrade(c, ex, broker, state, notifier, log)).toBe("hold");

    at(13); // падение: закрытие ниже MA -> продаём всё
    expect(await checkAndTrade(c, ex, broker, state, notifier, log)).toBe("sell");
    expect(ex.bal.BTC).toBeLessThan(1e-6);
    expect(notes.some((n) => n.startsWith("ПРОДАЖА"))).toBe(true);

    at(15);
    expect(await checkAndTrade(c, ex, broker, state, notifier, log)).toBe("hold");
    const csv = fs.readFileSync(path.join(c.dataDir, "trades.csv"), "utf8").trim().split("\n");
    expect(csv.length).toBe(3); // заголовок + покупка + продажа
  });

  test("бот был выключен: исполняет текущий сигнал с пометкой об опоздании", async () => {
    const { ex, state, c, broker, notes, notifier } = setup("live");
    ex.now = T0 + 7 * DAY_MS + 9 * 3_600_000; // 09:00 UTC, день 6 закрыт давно
    ex.last = ex.candles[6][4];
    expect(await checkAndTrade(c, ex, broker, state, notifier, log)).toBe("buy");
    expect(notes[0]).toContain("с опозданием");
  });

  test("paper: виртуальный баланс, реальных ордеров нет", async () => {
    const { ex, state, c, broker, notifier, at } = setup("paper");
    at(6);
    expect(await checkAndTrade(c, ex, broker, state, notifier, log)).toBe("buy");
    expect(ex.orders.length).toBe(0);
    expect(state.paper!.USDT).toBeCloseTo(5); // 1000 - 995 (запас 0,5%)
    at(13);
    expect(await checkAndTrade(c, ex, broker, state, notifier, log)).toBe("sell");
    expect(state.paper!.BTC).toBe(0);
    // состояние сохранено на диск и читается обратно
    const saved = JSON.parse(fs.readFileSync(path.join(c.dataDir, "state-paper.json"), "utf8"));
    expect(saved.lastSignal.action).toBe("sell");
  });

  test("файл STOP блокирует торговлю и не помечает день обработанным", async () => {
    const { ex, state, c, broker, notes, notifier, at } = setup("live");
    fs.writeFileSync(path.join(c.dataDir, "..", "STOP"), "");
    at(6);
    expect(await checkAndTrade(c, ex, broker, state, notifier, log)).toBe("stopped");
    expect(ex.orders.length).toBe(0);
    expect(state.lastCandleTs).toBeUndefined();
    expect(notes[0]).toContain("STOP");
    fs.rmSync(path.join(c.dataDir, "..", "STOP"));
    expect(await checkAndTrade(c, ex, broker, state, notifier, log)).toBe("buy");
  });

  test("слишком маленький баланс: понятная ошибка, день не помечен", async () => {
    const { ex, state, c, broker, notifier, at } = setup("live");
    ex.bal.USDT = 3;
    at(6);
    await expect(checkAndTrade(c, ex, broker, state, notifier, log)).rejects.toThrow(/минимального ордера/);
    expect(state.lastCandleTs).toBeUndefined();
    expect(ex.orders.length).toBe(0);
  });
});

describe("лимитный режим исполнения", () => {
  const LIMIT: Partial<Config> = { execution: "limit", limitOffsetPct: 0.3, limitTimeoutHours: 4 };

  function setupL(mode: "paper" | "live") {
    const ex = new MockExchange();
    ex.candles = makeCandles(UP_DOWN);
    ex.bal = { BTC: 0, USDT: 1000 };
    const state: State = {};
    const c: Config = { ...cfg, mode, paperStartQuote: 1000, ...LIMIT };
    const broker = mode === "paper" ? new PaperBroker(c, ex, state) : new ExchangeBroker(c, ex, 0);
    const notes: string[] = [];
    const notifier = new Notifier(c, log);
    notifier.send = async (t: string) => { notes.push(t); };
    const at = (idx: number, plusMin = 6) => {
      ex.now = T0 + idx * DAY_MS + plusMin * 60_000;
      ex.last = ex.candles[idx - 1][4];
    };
    const run = () => checkAndTrade(c, ex, broker, state, notifier, log);
    return { ex, state, c, broker, notes, at, run };
  }

  test("покупка лимиткой: выставлена на 0,3% ниже, ждёт, исполняется", async () => {
    const { ex, state, notes, at, run } = setupL("live");
    at(6);
    expect(await run()).toBe("limit_placed");
    const o = ex.orders[0];
    expect(o.type).toBe("limit");
    expect(o.price).toBeCloseTo(105 * 0.997, 2);
    expect(state.pending?.side).toBe("buy");

    at(6, 60); // через час: не исполнена, срок не вышел
    expect(await run()).toBe("limit_pending");

    ex.fillLimit(o.id, 1);
    at(6, 90);
    expect(await run()).toBe("limit_filled");
    expect(state.pending).toBeUndefined();
    expect(ex.bal.BTC).toBeGreaterThan(9);
    expect(notes.at(-1)).toContain("лимитным ордером");
    expect(ex.orders.filter((x) => x.type === "market").length).toBe(0);
  });

  test("таймаут с частичным исполнением: отмена и докупка остатка по рынку", async () => {
    const { ex, state, notes, at, run } = setupL("live");
    at(6);
    await run();
    const o = ex.orders[0];
    ex.fillLimit(o.id, 0.4);
    at(6, 6 + 4 * 60 + 1); // 4 часа прошло
    expect(await run()).toBe("limit_timeout");
    expect(o.status).toBe("canceled");
    expect(ex.orders.some((x) => x.type === "market" && x.side === "buy")).toBe(true);
    expect(ex.bal.USDT).toBeLessThan(15); // потрачен почти весь бюджет (995 из 1000)
    expect(notes.at(-1)).toContain("частично лимиткой");
    expect(state.pending).toBeUndefined();
  });

  test("продажа: лимитка не исполнилась за 4 ч - продаём всё по рынку", async () => {
    const { ex, state, notes, at, run } = setupL("live");
    at(6);
    await run();
    ex.fillLimit(ex.orders[0].id, 1);
    at(6, 30);
    await run();
    at(13); // сигнал на продажу
    expect(await run()).toBe("limit_placed");
    const so = ex.orders.at(-1);
    expect(so.side).toBe("sell");
    expect(so.price).toBeCloseTo(95 * 1.003, 2);
    at(13, 6 + 4 * 60 + 1);
    expect(await run()).toBe("limit_timeout");
    expect(ex.bal.BTC).toBeLessThan(1e-5);
    expect(notes.at(-1)).toContain("не исполнилась");
    expect(state.pending).toBeUndefined();
  });

  test("paper: лимитка исполняется, когда минутная свеча касается цены", async () => {
    const { ex, state, at, run } = setupL("paper");
    at(6);
    expect(await run()).toBe("limit_placed");
    const px = state.pending!.price;
    const t = ex.now;
    ex.minute = [[t, 105, 105.2, 104.9, 105, 1], [t + 60_000, 105, 105.1, px - 0.01, 104.8, 1]];
    at(6, 20);
    expect(await run()).toBe("limit_filled");
    expect(state.paper!.BTC).toBeGreaterThan(9);
    expect(state.paper!.USDT).toBeLessThan(10);
  });

  test("STOP при открытой лимитке: ордер отменяется", async () => {
    const { ex, state, notes, at, run, c } = setupL("live");
    at(6);
    await run();
    fs.writeFileSync(path.join(c.dataDir, "..", "STOP"), "");
    at(6, 30);
    expect(await run()).toBe("stopped");
    expect(ex.orders[0].status).toBe("canceled");
    expect(ex.bal.USDT).toBeCloseTo(1000);
    expect(state.pending).toBeUndefined();
    expect(notes.at(-1)).toContain("отменён");
  });

  test("перезапуск бота: открытая лимитка подхватывается из файла состояния", async () => {
    const { ex, at, run, c, broker, notes } = setupL("live");
    at(6);
    await run();
    const saved: State = JSON.parse(fs.readFileSync(path.join(c.dataDir, "state-live.json"), "utf8"));
    expect(saved.pending?.id).toBe(ex.orders[0].id);
    ex.fillLimit(ex.orders[0].id, 1);
    at(6, 120);
    const notifier = new Notifier(c, log);
    notifier.send = async (t: string) => { notes.push(t); };
    expect(await checkAndTrade(c, ex, broker, saved, notifier, log)).toBe("limit_filled");
  });
});
