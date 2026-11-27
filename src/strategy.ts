// Чистая логика стратегии: без сети и файлов, чтобы её было легко тестировать.

export const DAY_MS = 24 * 60 * 60 * 1000;

/** Свеча в формате ccxt: [время открытия, open, high, low, close, volume] */
export type Candle = [number, number, number, number, number, number];

export interface Signal {
  candleTs: number; // время открытия последней ЗАКРЫТОЙ дневной свечи
  close: number;
  ma: number;
  wantBase: boolean; // true -> держать BTC, false -> держать USDT
}

/** Оставляет только закрытые свечи и возвращает последние `count`. */
export function closedCandles(candles: Candle[], nowMs: number, count: number): Candle[] {
  return candles.filter((c) => c[0] + DAY_MS <= nowMs).slice(-count);
}

/** Сигнал: закрытие последнего дня выше простой средней за `period` дней. */
export function computeSignal(candles: Candle[], period: number): Signal {
  if (candles.length < period) {
    throw new Error(`Мало дневных свечей для MA${period}: получено ${candles.length}`);
  }
  const last = candles[candles.length - 1];
  const window = candles.slice(-period);
  const ma = window.reduce((s, c) => s + c[4], 0) / period;
  return { candleTs: last[0], close: last[4], ma, wantBase: last[4] > ma };
}

export interface SizingConfig {
  sizing: "all" | "fixed";
  fixedAmountQuote: number;
  reservePct: number;
  maxOrderQuote: number;
}

/** Сколько USDT потратить на покупку. */
export function buyBudget(cfg: SizingConfig, quoteFree: number): number {
  let budget = quoteFree * (1 - cfg.reservePct / 100);
  if (cfg.sizing === "fixed") budget = Math.min(budget, cfg.fixedAmountQuote);
  if (cfg.maxOrderQuote > 0) budget = Math.min(budget, cfg.maxOrderQuote);
  return Math.max(budget, 0);
}

export interface BacktestResult {
  from: number;
  to: number;
  start: number;
  final: number;
  buyHold: number;
  entries: number;
  wins: number;
  maxDrawdownPct: number;
  inPosition: boolean;
  trades: { buyTs: number; buyPrice: number; sellTs?: number; sellPrice?: number; pnlPct?: number }[];
}

/**
 * Бэктест как в нашем исследовании: сигнал по закрытию дня i-1,
 * сделка по цене открытия дня i, комиссия `feePct` с каждой сделки.
 */
export function backtest(candles: Candle[], period: number, days: number, feePct: number, start: number): BacktestResult {
  if (candles.length < period + 2) throw new Error("Недостаточно данных для бэктеста");
  const fee = feePct / 100;
  const a = Math.max(period, candles.length - days);
  let cash = start, qty = 0, inPos = false, entries = 0, wins = 0, entryCash = 0;
  let peak = start, mdd = 0;
  const trades: BacktestResult["trades"] = [];
  for (let i = a; i < candles.length; i++) {
    let sum = 0;
    for (let k = i - period; k < i; k++) sum += candles[k][4];
    const want = candles[i - 1][4] > sum / period;
    const open = candles[i][1];
    if (want && !inPos) {
      entryCash = cash;
      qty = (cash * (1 - fee)) / open;
      cash = 0;
      inPos = true;
      entries++;
      trades.push({ buyTs: candles[i][0], buyPrice: open });
    } else if (!want && inPos) {
      cash = qty * open * (1 - fee);
      qty = 0;
      inPos = false;
      if (cash > entryCash) wins++;
      const t = trades[trades.length - 1];
      t.sellTs = candles[i][0];
      t.sellPrice = open;
      t.pnlPct = (cash / entryCash - 1) * 100;
    }
    const eq = cash + qty * candles[i][4];
    peak = Math.max(peak, eq);
    mdd = Math.max(mdd, 1 - eq / peak);
  }
  const lastClose = candles[candles.length - 1][4];
  const final = cash + qty * lastClose * (inPos ? 1 - fee : 1);
  return {
    from: candles[a][0],
    to: candles[candles.length - 1][0],
    start,
    final,
    buyHold: (start * lastClose) / candles[a][1],
    entries,
    wins,
    maxDrawdownPct: mdd * 100,
    inPosition: inPos,
    trades,
  };
}
