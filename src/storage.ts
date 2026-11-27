// Всё, что бот хранит на диске в dataDir: состояние между проверками и журнал сделок.

import * as fs from "node:fs";
import * as path from "node:path";
import type { Pending, Side } from "./brokers/types";
import type { Config } from "./config";
import { fmtTime } from "./format";

export interface State {
  lastCandleTs?: number;
  lastCheck?: string;
  lastSignal?: { day: string; close: number; ma: number; want: string; action: string };
  paper?: Record<string, number>;
  pending?: Pending;
  /** Открытая позиция: сколько USDT ушло на вход. Нужна, чтобы при продаже посчитать результат. */
  entry?: { cost: number; amount: number; day: string };
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

export interface TradeRecord {
  nowMs: number;
  side: Side;
  price: number;
  amount: number; // BTC
  cost: number; // USDT
  id: string; // id ордера на бирже
  reason: string;
  /** Результат продажи относительно покупки (только для sell, если покупку делал бот). */
  pnl?: Pnl;
}

export interface Pnl {
  quote: number; // USDT: получено при продаже минус потрачено на покупку
  pct: number;
}

/** Колонки trades.csv: заголовок и как получить значение. */
/** «buy (USDT → BTC)» / «sell (BTC → USDT)» - сразу видно, что на что меняли. */
function sideLabel(cfg: Config, side: Side) {
  const [base, quote] = cfg.symbol.split("/");
  return side === "buy" ? `buy (${quote} → ${base})` : `sell (${base} → ${quote})`;
}

const TRADE_COLUMNS: [string, (t: TradeRecord, cfg: Config) => string][] = [
  ["time_utc", (t) => fmtTime(t.nowMs)],
  ["side", (t, cfg) => sideLabel(cfg, t.side)],
  ["price", (t) => t.price.toFixed(2)],
  ["amount_base", (t) => t.amount.toFixed(8)],
  ["cost_quote", (t) => t.cost.toFixed(2)],
  ["order_id", (t) => t.id],
  ["reason", (t) => t.reason],
  ["pnl_quote", (t) => (t.pnl ? t.pnl.quote.toFixed(2) : "")],
  ["pnl_pct", (t) => (t.pnl ? t.pnl.pct.toFixed(2) : "")],
];

/** Дописывает сделку в журнал режима: trades-paper.csv / trades-testnet.csv / trades-live.csv в dataDir. */
export function recordTrade(cfg: Config, t: TradeRecord) {
  const f = path.join(cfg.dataDir, `trades-${cfg.mode}.csv`);
  if (!fs.existsSync(f)) fs.writeFileSync(f, TRADE_COLUMNS.map(([h]) => h).join(",") + "\n");
  fs.appendFileSync(f, TRADE_COLUMNS.map(([, get]) => get(t, cfg)).join(",") + "\n");
}

/** Файл-рубильник (по умолчанию STOP в корне проекта): пока он есть, бот не торгует. */
export const isStopped = (cfg: Config) => fs.existsSync(cfg.stopFile);
