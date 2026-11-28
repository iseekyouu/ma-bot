import { isInPosition } from "../bot";
import type { Config } from "../config";
import { fetchClosedDaily } from "../exchange";
import { fmtDay, fmtTime } from "../format";
import { isStopped } from "../storage";
import { computeSignal } from "../strategy";
import { VERSION } from "../version";
import { openAccount, type Ctx } from "./context";

/** Печатает пары «метка: значение» с выровненной колонкой значений. */
function printTable(rows: [string, string][]) {
  const width = Math.max(...rows.map(([label]) => label.length)) + 2;
  for (const [label, value] of rows) console.log(`${(label + ":").padEnd(width)}${value}`);
}

// ---------- status ----------

function describeExecution(cfg: Config): string {
  return cfg.execution === "limit"
    ? `лимитка ${cfg.limitOffsetPct}% лучше рынка, через ${cfg.limitTimeoutHours} ч - по рынку`
    : "по рынку";
}

export async function cmdStatus({ cfg }: Ctx) {
  const { ex, state, broker } = await openAccount(cfg);
  const candles = await fetchClosedDaily(ex, cfg.symbol, cfg.maPeriod, ex.milliseconds());
  const sig = computeSignal(candles, cfg.maPeriod);
  const price = await broker.price();
  const bal = await broker.balances();
  const inPos = isInPosition(cfg, bal.base, price);
  const total = bal.quote + bal.base * price;

  const rows: [string, string][] = [
    ["Версия", VERSION],
    ["Режим", cfg.mode],
    ["Стратегия", `${cfg.symbol}, MA${cfg.maPeriod} на дневных свечах`],
    ["Последняя свеча", `${fmtDay(sig.candleTs)}, закрытие ${sig.close.toFixed(2)}`],
    [`MA${cfg.maPeriod}`, sig.ma.toFixed(2)],
    ["Сигнал", `держать ${sig.wantBase ? broker.base : broker.quote}`],
    ["Текущая цена", price.toFixed(2)],
    ["Баланс", `${bal.base.toFixed(8)} ${broker.base} / ${bal.quote.toFixed(2)} ${broker.quote}  (~${total.toFixed(2)} ${broker.quote})`],
    ["В позиции", inPos ? "да" : "нет"],
    ["Исполнение", describeExecution(cfg)],
  ];
  const p = state.pending;
  if (p) {
    const side = p.side === "buy" ? "покупка" : "продажа";
    rows.push(["Открытый ордер", `${side} ${p.amount} ${broker.base} по ${p.price}, срок до ${fmtTime(p.deadline)} (id ${p.id})`]);
  }
  printTable(rows);

  const notes = [
    sig.wantBase !== inPos && "-> На ближайшей проверке бот приведёт позицию к сигналу.",
    isStopped(cfg) && "ВНИМАНИЕ: найден файл STOP, торговля приостановлена.",
    state.lastSignal && `Последняя проверка бота: ${state.lastCheck} -> ${JSON.stringify(state.lastSignal)}`,
  ];
  for (const note of notes) if (note) console.log(note);
}
