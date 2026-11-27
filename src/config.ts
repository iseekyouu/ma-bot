// Настройки бота: схема и загрузка из config.json и переменных окружения (через convict).

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import convict from "convict";
import dotenv from "dotenv";

/** Корень проекта (папка над src/): здесь лежат config.json и .env, откуда бы ни запускали бота. */
export const PROJECT_DIR = fileURLToPath(new URL("..", import.meta.url));

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
  stopFile: string;
}

/** Проверка «число в диапазоне» для схемы convict. */
const range = (min: number, max = Infinity, { integer = false, minExclusive = false, maxExclusive = false } = {}) =>
  (v: unknown) => {
    const n = v as number;
    const ok = typeof n === "number" && !Number.isNaN(n) && (!integer || Number.isInteger(n)) &&
      (minExclusive ? n > min : n >= min) && (maxExclusive ? n < max : n <= max);
    if (ok) return;
    const lo = `${minExclusive ? "больше" : "не меньше"} ${min}`;
    const hi = max === Infinity ? "" : ` и ${maxExclusive ? "меньше" : "не больше"} ${max}`;
    throw new Error(`должно быть ${integer ? "целым " : ""}числом ${lo}${hi}`);
  };

/**
 * Схема настроек: значения по умолчанию, проверка и переменные окружения, которые перекрывают config.json.
 * Порядок приоритета: значение по умолчанию < config.json < переменная окружения (.env).
 * Описание каждого параметра - в README, раздел «Настройки config.json».
 */
const SCHEMA: convict.Schema<Config> = {
  mode: { doc: "paper / testnet / live", format: ["paper", "testnet", "live"], default: "paper", env: "BOT_MODE" },
  apiKey: { doc: "ключ Bybit", format: String, default: "", env: "BYBIT_API_KEY", sensitive: true },
  apiSecret: { doc: "секрет Bybit", format: String, default: "", env: "BYBIT_API_SECRET", sensitive: true },
  symbol: {
    doc: "торговая пара",
    format: (v: unknown) => {
      if (typeof v !== "string" || !/^[A-Z0-9]+\/[A-Z0-9]+$/.test(v)) throw new Error("должен быть вида BTC/USDT");
    },
    default: "BTC/USDT",
  },
  maPeriod: { doc: "период средней, дней", format: range(2, 500, { integer: true }), default: 50 },
  sizing: { doc: "all / fixed", format: ["all", "fixed"], default: "all" },
  fixedAmountQuote: { doc: "сумма покупки при sizing: fixed", format: range(0, Infinity, { minExclusive: true }), default: 1000 },
  reservePct: { doc: "% USDT в резерве", format: range(0, 50, { maxExclusive: true }), default: 0.5 },
  maxOrderQuote: { doc: "лимит одной покупки, 0 - без лимита", format: range(0), default: 3000 },
  minPositionQuote: { doc: "меньше этого - пыль, не позиция", format: range(0), default: 10 },
  checkIntervalMinutes: { doc: "период проверки в режиме run", format: range(1), default: 15 },
  executionDelayMinutes: { doc: "задержка после 00:00 UTC", format: range(0), default: 5 },
  paperStartQuote: { doc: "виртуальный баланс для paper", format: range(0, Infinity, { minExclusive: true }), default: 1000 },
  feePct: { doc: "комиссия для paper и backtest", format: range(0), default: 0.1 },
  execution: { doc: "market / limit", format: ["market", "limit"], default: "market" },
  limitOffsetPct: { doc: "насколько % лучше рынка ставить лимитку", format: range(0, 5, { minExclusive: true }), default: 0.3 },
  limitTimeoutHours: { doc: "сколько часов ждать лимитку", format: range(0.25, 20), default: 4 },
  telegramToken: { doc: "токен Telegram-бота", format: String, default: "", env: "TELEGRAM_TOKEN", sensitive: true },
  telegramChatId: { doc: "чат для уведомлений", format: String, default: "", env: "TELEGRAM_CHAT_ID" },
  telegramDailyReport: { doc: "ежедневный отчёт", format: Boolean, default: true },
  dataDir: { doc: "папка для состояния, журнала и лога", format: String, default: "data" },
  stopFile: { doc: "файл-рубильник: пока он есть, бот не торгует", format: String, default: "STOP" },
};

/** Проверяет собранный конфиг: неизвестные ключи, форматы и связи между полями. */
function finalize(conf: convict.Config<Config>): Config {
  try {
    conf.validate({ allowed: "strict" });
  } catch (e) {
    throw new Error(`Ошибка в настройках:\n${(e as Error).message}`);
  }
  const cfg = conf.getProperties();
  if (cfg.mode !== "paper" && !(cfg.apiKey && cfg.apiSecret)) {
    throw new Error("Ошибка в настройках: для testnet/live нужны BYBIT_API_KEY и BYBIT_API_SECRET");
  }
  return cfg;
}

/** Настройки по умолчанию, без файла и без переменных окружения. */
export const DEFAULT_CONFIG: Config = convict(SCHEMA, { env: {}, args: [] }).getProperties();

/** Проверяет готовый объект настроек (без файла и окружения). Нужна в основном для тестов. */
export function validateConfig(values: Partial<Config>): Config {
  const conf = convict(SCHEMA, { env: {}, args: [] });
  conf.load(values);
  return finalize(conf);
}

/**
 * Загружает настройки:
 *  - файл: путь из --config, иначе config.json в папке проекта; если файла нет - ошибка;
 *  - переменные окружения: из окружения процесса и из .env в папке проекта (уже заданные не перезаписываются).
 */
export function loadConfig(file = path.join(PROJECT_DIR, "config.json")): Config {
  if (!fs.existsSync(file)) {
    throw new Error(`Файл настроек ${file} не найден. Создайте его из примера: cp config.example.json config.json`);
  }
  // Bun сам читает .env только из текущей папки; берём его из корня проекта, чтобы работал запуск из cron/systemd.
  dotenv.config({ path: path.join(PROJECT_DIR, ".env"), quiet: true });

  const cfg = finalize(convict(SCHEMA, { args: [] }).loadFile(file));
  // относительные пути считаем от папки config.json (по умолчанию это корень проекта)
  cfg.dataDir = path.resolve(path.dirname(file), cfg.dataDir);
  cfg.stopFile = path.resolve(path.dirname(file), cfg.stopFile);
  fs.mkdirSync(cfg.dataDir, { recursive: true });
  return cfg;
}
