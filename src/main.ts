#!/usr/bin/env bun
// Точка входа: разбор аргументов и запуск команды run / once / status / backtest.

import * as path from "node:path";
import { parseArgs } from "node:util";
import { cmdBacktest } from "./commands/backtest";
import type { Args, Ctx } from "./commands/context";
import { cmdOnce } from "./commands/once";
import { cmdRun } from "./commands/run";
import { cmdStatus } from "./commands/status";
import { loadConfig } from "./config";
import { errText } from "./format";
import { Logger } from "./logger";

// ---------- аргументы ----------

function readArgs(argv: string[]): Args {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      config: { type: "string", short: "c" },
      days: { type: "string", default: "365" },
      force: { type: "boolean", default: false },
    },
  });
  const days = Number(values.days);
  if (!Number.isInteger(days) || days <= 0) throw new Error(`--days должно быть целым положительным числом, получено: ${values.days}`);
  const config = values.config && path.resolve(values.config);
  return { command: positionals[0] ?? "", config, days, force: values.force! };
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
  bun run src/main.ts <команда> [--config путь] [--days 365] [--force]

  Без --config берётся config.json из папки проекта. Ключи - из .env в папке проекта.

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
  const cfg = loadConfig(args.config);
  const log = new Logger(path.join(cfg.dataDir, "bot.log"));
  await command.run({ cfg, log, args });
}

main().catch((e) => {
  console.error(errText(e));
  process.exit(1);
});
