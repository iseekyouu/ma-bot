import { makeBroker } from "../brokers";
import type { Config } from "../config";
import { makeExchange } from "../exchange";
import type { Logger } from "../logger";
import { loadState } from "../storage";

export interface Args {
  command: string;
  /** путь из --config; не задан - config.json в папке проекта */
  config?: string;
  days: number;
  force: boolean;
}

export interface Ctx {
  cfg: Config;
  log: Logger;
  args: Args;
}

/** Биржа + состояние + брокер: нужны всем командам, которые смотрят на счёт. */
export async function openAccount(cfg: Config) {
  const ex = await makeExchange(cfg);
  const state = loadState(cfg);
  const broker = makeBroker(cfg, ex, state);
  return { ex, state, broker };
}
