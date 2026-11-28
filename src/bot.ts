// Основная работа бота: одна проверка дневного сигнала и приведение позиции к нему.

import type { Broker, Pending, Side } from "./brokers";
import type { Config } from "./config";
import { fetchClosedDaily, type ExchangeLike } from "./exchange";
import { errText, fmtDay, fmtTime } from "./format";
import type { Logger } from "./logger";
import * as msg from "./messages";
import type { Notifier } from "./notifier";
import { isStopped, recordTrade, saveState, type Pnl, type State, type TradeRecord } from "./storage";
import { buyBudget, computeSignal, DAY_MS, type Signal } from "./strategy";

export type Action =
  | "wait" | "already_processed" | "hold" | "buy" | "sell" | "stopped"
  | "limit_placed" | "limit_pending" | "limit_filled" | "limit_timeout";

/** Итог проверки человеческими словами - для лога. */
export const ACTION_TEXT: Record<Action, string> = {
  already_processed: "день уже обработан, к бирже не обращался",
  wait: "день закрылся, жду executionDelayMinutes после 00:00 UTC",
  hold: "сигнал совпадает с позицией, ничего не меняю",
  buy: "купил по рынку",
  sell: "продал по рынку",
  stopped: "найден файл STOP, не торгую",
  limit_placed: "выставил лимитный ордер",
  limit_pending: "лимитка ещё не исполнилась, жду",
  limit_filled: "лимитка исполнилась",
  limit_timeout: "лимитка не исполнилась вовремя, добрал по рынку",
};

/** Всё, что нужно одной проверке. */
interface Run {
  cfg: Config;
  broker: Broker;
  state: State;
  notifier: Notifier;
  log: Logger;
  nowMs: number;
}

const HOUR_MS = 3_600_000;
/** Если день обработан позже этого срока после закрытия, пишем об опоздании. */
const LATE_AFTER_HOURS = 2;

/** Время открытия последней закрытой дневной свечи. Дневные свечи Bybit начинаются в 00:00 UTC. */
const lastClosedDayTs = (nowMs: number) => Math.floor(nowMs / DAY_MS) * DAY_MS - DAY_MS;

/** Позиция открыта, если BTC на счёте больше «пыли». */
export const isInPosition = (cfg: Config, baseBalance: number, price: number) => baseBalance * price >= cfg.minPositionQuote;

/**
 * Записывает сделку в журнал и ведёт учёт позиции: покупка запоминает, сколько USDT ушло на вход,
 * продажа считает результат относительно этой покупки. Возвращает результат продажи, если он известен.
 */
function settleTrade(run: Run, t: Omit<TradeRecord, "nowMs" | "pnl">, day: string): Pnl | undefined {
  const { cfg, state } = run;
  let pnl: Pnl | undefined;
  if (t.side === "buy") {
    state.entry = { cost: t.cost, amount: t.amount, day };
  } else {
    if (state.entry && state.entry.cost > 0) {
      const quote = t.cost - state.entry.cost;
      pnl = { quote, pct: (quote / state.entry.cost) * 100 };
    }
    state.entry = undefined;
  }
  recordTrade(cfg, { ...t, nowMs: run.nowMs, pnl });
  return pnl;
}

// ---------- проверка ----------

export async function checkAndTrade(
  cfg: Config, ex: ExchangeLike, broker: Broker, state: State, notifier: Notifier, log: Logger,
  opts: { nowMs?: number; force?: boolean } = {},
): Promise<Action> {
  const run: Run = { cfg, broker, state, notifier, log, nowMs: opts.nowMs ?? ex.milliseconds() };

  // 1. Если висит лимитный ордер - сначала разбираемся с ним
  const pendingAction = state.pending ? await processPending(run, state.pending) : null;
  if (pendingAction) {
    state.lastCheck = fmtTime(run.nowMs);
    saveState(cfg, state);
    if (pendingAction === "limit_pending" || pendingAction === "stopped") return pendingAction;
  }

  // 2. День уже обработан - до следующего закрытия (00:00 UTC) свечи и MA не нужны, к бирже не ходим
  if (!opts.force && state.lastCandleTs === lastClosedDayTs(run.nowMs)) return pendingAction ?? "already_processed";

  // 3. Новый дневной сигнал: действуем один раз на каждую закрытую дневную свечу, через несколько минут после 00:00 UTC
  const sig = computeSignal(await fetchClosedDaily(ex, cfg.symbol, cfg.maPeriod, run.nowMs), cfg.maPeriod);
  const dayClosedAt = sig.candleTs + DAY_MS;
  if (!opts.force && run.nowMs < dayClosedAt + cfg.executionDelayMinutes * 60_000) return pendingAction ?? "wait";
  if (!opts.force && state.lastCandleTs === sig.candleTs) return pendingAction ?? "already_processed";

  const action = await followSignal(run, sig);

  if (action !== "stopped") state.lastCandleTs = sig.candleTs;
  state.lastCheck = fmtTime(run.nowMs);
  state.lastSignal = {
    day: fmtDay(sig.candleTs), close: sig.close, ma: Math.round(sig.ma * 100) / 100,
    want: sig.wantBase ? broker.base : broker.quote, action,
  };
  saveState(cfg, state);
  return action;
}

/** Приводит позицию к сигналу: ничего не делает, покупает или продаёт - по рынку или лимиткой. */
async function followSignal(run: Run, sig: Signal): Promise<Action> {
  const { cfg, broker, notifier, log } = run;
  const price = await broker.price();
  const bal = await broker.balances();
  const inPos = isInPosition(cfg, bal.base, price);
  const info: msg.SignalInfo = { day: fmtDay(sig.candleTs), close: sig.close, ma: sig.ma };
  log.info(
    `Свеча ${info.day}: закрытие ${sig.close.toFixed(2)}, MA${cfg.maPeriod} ${sig.ma.toFixed(2)} -> держать ${sig.wantBase ? broker.base : broker.quote}; ` +
    `баланс ${bal.base.toFixed(8)} ${broker.base} / ${bal.quote.toFixed(2)} ${broker.quote}; позиция: ${inPos ? "да" : "нет"}`,
  );

  if (isStopped(cfg)) {
    await notifier.send(msg.stopped());
    return "stopped";
  }

  if (sig.wantBase === inPos) {
    if (cfg.telegramDailyReport) {
      await notifier.send(msg.dailyReport(cfg, info, inPos ? broker.base : broker.quote, bal.quote + bal.base * price, broker.quote));
    }
    return "hold";
  }

  const side: Side = sig.wantBase ? "buy" : "sell";
  // если бот был выключен и обрабатывает день с опозданием - отметим это в уведомлении
  const lateHours = (run.nowMs - (sig.candleTs + DAY_MS)) / HOUR_MS;
  let note = lateHours > LATE_AFTER_HOURS ? msg.lateNote(lateHours) : "";

  // на покупку тратим бюджет по правилам sizing; если сработал maxOrderQuote - предупреждаем
  let budget = 0;
  if (side === "buy") {
    budget = buyBudget(cfg, bal.quote);
    const uncapped = buyBudget({ ...cfg, maxOrderQuote: 0 }, bal.quote);
    if (uncapped > budget + 1) note += msg.capNote(cfg, broker.quote, uncapped - budget);
  }

  if (cfg.execution === "market") {
    const fill = side === "buy" ? await broker.buy(budget) : await broker.sellAll();
    const pnl = settleTrade(run, { side, ...fill, reason: msg.tradeReason(cfg, side) }, info.day);
    await notifier.send(msg.marketFilled(cfg, broker.quote, side, fill, info, note) + msg.pnlNote(broker.quote, pnl));
    return side;
  }

  // лимитка на limitOffsetPct лучше рынка; её дальнейшую судьбу решает processPending
  const offset = cfg.limitOffsetPct / 100;
  const limitPrice = side === "buy" ? price * (1 - offset) : price * (1 + offset);
  const amount = side === "buy" ? (budget * (1 - cfg.feePct / 100)) / limitPrice : bal.base;
  const lim = await broker.placeLimit(side, limitPrice, amount);
  run.state.pending = {
    side, ...lim, budget, placedAt: run.nowMs, deadline: run.nowMs + cfg.limitTimeoutHours * HOUR_MS,
    before: bal, ...info, note,
  };
  await notifier.send(msg.limitPlaced(cfg, broker.base, side, lim));
  return "limit_placed";
}

// ---------- открытая лимитка ----------

/** Ведём открытую лимитку: исполнилась / ждём / по таймауту отменяем и добиваем остаток по рынку. */
async function processPending(run: Run, p: Pending): Promise<Action> {
  const { cfg, broker, state, notifier, nowMs } = run;

  if (isStopped(cfg)) {
    await broker.cancelLimit(p);
    state.pending = undefined;
    await notifier.send(msg.stoppedWithPending(p.side));
    return "stopped";
  }

  const status = await broker.limitStatus(p, nowMs);
  if (status === "open" && nowMs < p.deadline) return "limit_pending";

  let action: Action = "limit_filled";
  let how = msg.limitOutcome(cfg, p, "filled");
  if (status !== "filled") {
    // таймаут или ордер отменён на бирже: снимаем остаток и добиваем по рынку
    if (status === "open") await broker.cancelLimit(p);
    action = "limit_timeout";
    const partly = await finishByMarket(run, p);
    how = msg.limitOutcome(cfg, p, partly ? "partial" : "missed");
  }

  // итог считаем по изменению балансов с момента выставления лимитки
  const after = await broker.balances();
  const amount = Math.abs(after.base - p.before.base);
  const cost = Math.abs(after.quote - p.before.quote);
  const price = amount > 0 ? cost / amount : p.price;
  const pnl = settleTrade(run, { side: p.side, price, amount, cost, id: p.id, reason: `${msg.tradeReason(cfg, p.side)} ${action}` }, p.day);
  await notifier.send(msg.pendingDone(cfg, broker.quote, p, how, price, cost) + msg.pnlNote(broker.quote, pnl));
  state.pending = undefined;
  return action;
}

/** Добирает по рынку то, что не исполнила лимитка. Возвращает true, если лимитка успела исполниться частично. */
async function finishByMarket({ cfg, broker, log }: Run, p: Pending): Promise<boolean> {
  const bal = await broker.balances();
  if (p.side === "sell") {
    if (isInPosition(cfg, bal.base, await broker.price())) await broker.sellAll();
    return p.before.base - bal.base > 0;
  }
  const spent = Math.max(0, p.before.quote - bal.quote);
  const remaining = p.budget - spent;
  if (remaining >= Math.max(cfg.minPositionQuote, p.budget * 0.01)) {
    try {
      await broker.buy(Math.min(remaining, bal.quote));
    } catch (e) {
      log.warn(`Остаток покупки не добран: ${errText(e)}`);
    }
  }
  return spent > 1;
}
