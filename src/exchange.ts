// Подключение к Bybit через ccxt и загрузка свечей.

import ccxt from "ccxt";
import type { Config } from "./config";
import { closedCandles, DAY_MS, type Candle } from "./strategy";

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

/** Последние count закрытых дневных свечей. */
export async function fetchClosedDaily(ex: ExchangeLike, symbol: string, count: number, nowMs: number): Promise<Candle[]> {
  const raw = (await ex.fetchOHLCV(symbol, "1d", undefined, count + 2)) as Candle[];
  return closedCandles(raw, nowMs, count);
}

const OHLCV_PAGE = 1000;

/** Все дневные свечи начиная с since, постранично. */
export async function fetchDailyHistory(ex: ExchangeLike, symbol: string, since: number): Promise<Candle[]> {
  const candles: Candle[] = [];
  for (;;) {
    const page = (await ex.fetchOHLCV(symbol, "1d", since, OHLCV_PAGE)) as Candle[];
    const lastTs = candles.at(-1)?.[0] ?? -Infinity;
    candles.push(...page.filter((c) => c[0] > lastTs));
    if (page.length < OHLCV_PAGE) return candles;
    since = page[page.length - 1][0] + DAY_MS;
  }
}
