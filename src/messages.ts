// Тексты уведомлений в Telegram. Логика торговли - в bot.ts, здесь только формулировки.

import type { Fill, Pending, Side } from "./brokers";
import type { Config } from "./config";
import { sign } from "./format";
import type { Pnl } from "./storage";

/** Что запомнили о сигнале, по которому торгуем. */
export interface SignalInfo {
  day: string;
  close: number;
  ma: number;
}

const SIDE = {
  buy: { title: "ПОКУПКА", accusative: "ПОКУПКУ", cmp: ">", money: "потрачено", limitDir: "ниже", fallback: "докуплю по рынку" },
  sell: { title: "ПРОДАЖА", accusative: "ПРОДАЖУ", cmp: "<=", money: "получено", limitDir: "выше", fallback: "продам остаток по рынку" },
} as const;

/** «Закрытие 2026-11-26: 60577.80 <= MA50 74777.40» */
const signalLine = (cfg: Config, side: Side, s: SignalInfo) =>
  `Закрытие ${s.day}: ${s.close.toFixed(2)} ${SIDE[side].cmp} MA${cfg.maPeriod} ${s.ma.toFixed(2)}`;

/** Причина сделки для журнала: «close>MA50». */
export const tradeReason = (cfg: Config, side: Side) => `close${SIDE[side].cmp}MA${cfg.maPeriod}`;

export const lateNote = (hours: number) => `\nИсполнено с опозданием: ${hours.toFixed(1)} ч после закрытия дня.`;

export const capNote = (cfg: Config, quote: string, leftOut: number) =>
  `\nСработал лимит ${cfg.maxOrderQuote} ${quote}: ~${leftOut.toFixed(2)} ${quote} остались не вложены.`;

export const stopped = () => "Найден файл STOP - торговля приостановлена, сигнал не исполнен.";

export const stoppedWithPending = (side: Side) =>
  `Найден файл STOP - лимитный ордер ${SIDE[side].title.toLowerCase()} отменён. Если он исполнился частично, остаток не добирается.`;

export const marketFilled = (cfg: Config, quote: string, side: Side, fill: Fill, s: SignalInfo, note: string) =>
  `${SIDE[side].title} ${cfg.symbol}\nЦена ~${fill.price.toFixed(2)}, ${SIDE[side].money} ${fill.cost.toFixed(2)} ${quote}\n` +
  signalLine(cfg, side, s) + note;

export const limitPlaced = (cfg: Config, base: string, side: Side, lim: { price: number; amount: number }) =>
  `Сигнал на ${SIDE[side].accusative} ${cfg.symbol}: выставлен лимитный ордер ${lim.amount} ${base} по ${lim.price.toFixed(2)} ` +
  `(на ${cfg.limitOffsetPct}% ${SIDE[side].limitDir} рынка). Если не исполнится за ${cfg.limitTimeoutHours} ч - ${SIDE[side].fallback}.`;

/** Как исполнилась лимитка: целиком, частично или не исполнилась вовсе. */
export const limitOutcome = (cfg: Config, p: Pending, result: "filled" | "partial" | "missed") =>
  ({
    filled: `лимитным ордером по ${p.price.toFixed(2)}`,
    partial: "частично лимиткой, остаток по рынку",
    missed: `по рынку (лимитка ${p.price.toFixed(2)} не исполнилась за ${cfg.limitTimeoutHours} ч)`,
  })[result];

export const pendingDone = (cfg: Config, quote: string, p: Pending, how: string, avg: number, cost: number) =>
  `${SIDE[p.side].title} ${cfg.symbol} исполнена ${how}\n` +
  `Средняя цена ~${avg.toFixed(2)}, ${SIDE[p.side].money} ${cost.toFixed(2)} ${quote}\n` +
  signalLine(cfg, p.side, p) + p.note;

/** Строка с результатом продажи; пустая, если это покупка или вход делал не бот. */
export const pnlNote = (quote: string, pnl?: Pnl) =>
  pnl ? `\n${pnl.quote >= 0 ? "Прибыль" : "Убыток"}: ${sign(pnl.quote)}${pnl.quote.toFixed(2)} ${quote} (${sign(pnl.pct)}${pnl.pct.toFixed(2)}%)` : "";

export const botStarted = (cfg: Config) =>
  `Бот запущен: ${cfg.symbol}, MA${cfg.maPeriod}, режим ${cfg.mode}, исполнение ${cfg.execution === "limit" ? "лимиткой" : "по рынку"}, ` +
  `проверка каждые ${cfg.checkIntervalMinutes} мин.`;

export const botStartFailed = (error: string) => `Бот не запустился: ${error}`;

export const botCrashed = (error: string) =>
  `Бот упал и не работает: ${error}\nСделки не исполняются, пока бот не перезапущен (bun start).`;

export const botStopped = (signal: string, holding: string) =>
  `Бот остановлен (${signal}).${holding ? ` Сейчас держим ${holding}.` : ""} Пока бот не запущен, сигналы не исполняются.`;

export const dailyReport = (cfg: Config, s: SignalInfo, holding: string, total: number, quote: string) =>
  `${s.day}: без изменений, держим ${holding}.\n` +
  `Закрытие ${s.close.toFixed(2)}, MA${cfg.maPeriod} ${s.ma.toFixed(2)}. Баланс ~${total.toFixed(2)} ${quote}`;
