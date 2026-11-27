#!/usr/bin/env bun
// Точка входа: команды run / once / status / backtest.

import * as fs from "node:fs";
import * as path from "node:path";
import { parseArgs } from "node:util";
import {
  checkAndTrade, fmtDay, fmtTime, loadConfig, loadState, Logger, makeBroker, makeExchange, Notifier,
  fetchClosedDaily, type Action, type Config, type ExchangeLike,
} from "./bot";
import { backtest, computeSignal, DAY_MS, type BacktestResult, type Candle } from "./strategy";

// ---------- аргументы ----------

interface Args {
  command: string;
  config: string;
  days: number;
  force: boolean;
}

function readArgs(argv: string[]): Args {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      config: { type: "string", short: "c", default: "config.json" },
      days: { type: "string", default: "365" },
      force: { type: "boolean", default: false },
    },
  });
  const days = Number(values.days);
  if (!Number.isInteger(days) || days <= 0) throw new Error(`--days должно быть целым положительным числом, получено: ${values.days}`);
  return { command: positionals[0] ?? "", config: values.config!, days, force: values.force! };
}

// ---------- общие части ----------

interface Ctx {
  cfg: Config;
  log: Logger;
  args: Args;
}

/** Биржа + состояние + брокер: нужны всем командам, которые смотрят на счёт. */
async function openAccount(cfg: Config) {
  const ex = await makeExchange(cfg);
  const state = loadState(cfg);
  const broker = makeBroker(cfg, ex, state);
  return { ex, state, broker };
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const errStack = (e: unknown) => (e instanceof Error ? e.stack ?? e.message : String(e));
const sign = (x: number) => (x >= 0 ? "+" : "");

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

async function cmdStatus({ cfg }: Ctx) {
  const { ex, state, broker } = await openAccount(cfg);
  const candles = await fetchClosedDaily(ex, cfg.symbol, cfg.maPeriod, ex.milliseconds());
  const sig = computeSignal(candles, cfg.maPeriod);
  const price = await broker.price();
  const bal = await broker.balances();
  const inPos = bal.base * price >= cfg.minPositionQuote;
  const total = bal.quote + bal.base * price;

  const rows: [string, string][] = [
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
    fs.existsSync(path.join(cfg.dataDir, "..", "STOP")) && "ВНИМАНИЕ: найден файл STOP, торговля приостановлена.",
    state.lastSignal && `Последняя проверка бота: ${state.lastCheck} -> ${JSON.stringify(state.lastSignal)}`,
  ];
  for (const note of notes) if (note) console.log(note);
}

// ---------- once ----------

async function cmdOnce({ cfg, log, args }: Ctx) {
  const { ex, state, broker } = await openAccount(cfg);
  const notifier = new Notifier(cfg, log);
  try {
    const action = await checkAndTrade(cfg, ex, broker, state, notifier, log, { force: args.force });
    log.info(`Результат проверки: ${action}`);
  } catch (e) {
    log.error(`Ошибка проверки: ${errStack(e)}`);
    await notifier.send(`Ошибка бота: ${errText(e)}`);
    process.exitCode = 1;
  }
}

// ---------- run ----------

/** Штатные исходы проверки, о которых не пишем в лог на каждой итерации. */
const ROUTINE_ACTIONS = new Set<Action>(["wait", "already_processed", "limit_pending"]);

/** Уведомляем о первой ошибке подряд, о пятой и далее о каждой двадцатой — чтобы не спамить. */
const shouldNotifyError = (streak: number) => streak === 1 || streak === 5 || streak % 20 === 0;

/** Спит seconds секунд, просыпаясь раз в секунду, чтобы быстро реагировать на остановку. */
async function sleepUnless(seconds: number, stopped: () => boolean) {
  for (let s = 0; s < seconds && !stopped(); s++) await new Promise((r) => setTimeout(r, 1000));
}

async function cmdRun({ cfg, log }: Ctx) {
  log.info(`Старт ${fmtTime(Date.now())}: режим ${cfg.mode}, ${cfg.symbol}, MA${cfg.maPeriod}, sizing=${cfg.sizing}, execution=${cfg.execution}`);
  if (cfg.mode === "live") log.warn("БОЕВОЙ РЕЖИМ: бот будет отправлять реальные ордера на Bybit.");

  const { ex, state, broker } = await openAccount(cfg);
  const notifier = new Notifier(cfg, log);
  await notifier.send(`Бот запущен: ${cfg.symbol}, MA${cfg.maPeriod}, режим ${cfg.mode}, проверка каждые ${cfg.checkIntervalMinutes} мин.`);

  let stopping = false;
  const stop = () => {
    stopping = true;
    log.info("Получен сигнал остановки, завершаюсь после текущей проверки");
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  let errorStreak = 0;
  while (!stopping) {
    try {
      const action = await checkAndTrade(cfg, ex, broker, state, notifier, log);
      if (!ROUTINE_ACTIONS.has(action)) log.info(`Действие: ${action}`);
      errorStreak = 0;
    } catch (e) {
      errorStreak++;
      log.error(`Ошибка проверки (${errorStreak} подряд): ${errStack(e)}`);
      if (shouldNotifyError(errorStreak)) await notifier.send(`Ошибка бота (${errorStreak} подряд): ${errText(e)}`);
    }
    await sleepUnless(cfg.checkIntervalMinutes * 60, () => stopping);
  }
}

// ---------- backtest ----------

const OHLCV_PAGE = 1000;

/** Все дневные свечи начиная с since, постранично. */
async function fetchDailyHistory(ex: ExchangeLike, symbol: string, since: number): Promise<Candle[]> {
  const candles: Candle[] = [];
  for (;;) {
    const page = (await ex.fetchOHLCV(symbol, "1d", since, OHLCV_PAGE)) as Candle[];
    const lastTs = candles.at(-1)?.[0] ?? -Infinity;
    candles.push(...page.filter((c) => c[0] > lastTs));
    if (page.length < OHLCV_PAGE) return candles;
    since = page[page.length - 1][0] + DAY_MS;
  }
}

function printBacktest(cfg: Config, r: BacktestResult) {
  const pct = (x: number) => `${sign(x - r.start)}${((x / r.start - 1) * 100).toFixed(1)}%`;
  console.log(`Бэктест MA${cfg.maPeriod} на ${cfg.symbol}: ${fmtDay(r.from)} - ${fmtDay(r.to)}`);
  console.log(`  Стратегия:        ${r.start} -> ${r.final.toFixed(2)} (${pct(r.final)}), входов ${r.entries}, ` +
    `прибыльных ${r.wins}, макс. просадка ${r.maxDrawdownPct.toFixed(1)}%`);
  console.log(`  Купить и держать: ${r.start} -> ${r.buyHold.toFixed(2)} (${pct(r.buyHold)})`);
  console.log(`  Сейчас стратегия: ${r.inPosition ? "в BTC" : "в USDT"}`);

  if (!r.trades.length) return;
  console.log("\n  Сделки (вход / выход по цене открытия дня):");
  for (const t of r.trades) {
    const exit = t.sellTs
      ? `${fmtDay(t.sellTs)} @ ${t.sellPrice!.toFixed(0)}  ${sign(t.pnlPct!)}${t.pnlPct!.toFixed(1)}%`
      : "открыта";
    console.log(`  ${fmtDay(t.buyTs)} @ ${t.buyPrice.toFixed(0)}  ->  ${exit}`);
  }
}

async function cmdBacktest({ cfg, args }: Ctx) {
  const ex = await makeExchange({ ...cfg, mode: "paper" }, true);
  const now = ex.milliseconds();
  const since = now - (args.days + cfg.maPeriod + 2) * DAY_MS;
  const closed = (await fetchDailyHistory(ex, cfg.symbol, since)).filter((c) => c[0] + DAY_MS <= now);
  printBacktest(cfg, backtest(closed, cfg.maPeriod, args.days, cfg.feePct, cfg.paperStartQuote));
}

// ---------- диспетчер ----------

const COMMANDS: Record<string, { help: string; run: (ctx: Ctx) => Promise<void> }> = {
  run: { help: "работать постоянно (проверка раз в checkIntervalMinutes)", run: cmdRun },
  once: { help: "одна проверка и выход (для cron / планировщика)", run: cmdOnce },
  status: { help: "показать сигнал, баланс и позицию, ничего не торгуя", run: cmdStatus },
  backtest: { help: "проверить стратегию на истории Bybit (по умолчанию 365 дней)", run: cmdBacktest },
};

const HELP = `MA-бот для Bybit Spot

Использование:
  bun run src/main.ts <команда> [--config config.json] [--days 365] [--force]

Команды:
${Object.entries(COMMANDS).map(([name, c]) => `  ${name.padEnd(10)}${c.help}`).join("\n")}
`;

async function main() {
  const args = readArgs(process.argv.slice(2));
  const command = COMMANDS[args.command];
  if (!command) {
    console.log(HELP);
    process.exit(args.command ? 1 : 0);
  }
  const cfg = loadConfig(path.resolve(args.config));
  const log = new Logger(path.join(cfg.dataDir, "bot.log"));
  await command.run({ cfg, log, args });
}

main().catch((e) => {
  console.error(errText(e));
  process.exit(1);
});
