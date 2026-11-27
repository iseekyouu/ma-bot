import type { Config } from "../config";
import type { ExchangeLike } from "../exchange";
import type { State } from "../storage";
import { ExchangeBroker } from "./exchange";
import { PaperBroker } from "./paper";
import type { Broker } from "./types";

export { ExchangeBroker } from "./exchange";
export { PaperBroker } from "./paper";
export * from "./types";

export function makeBroker(cfg: Config, ex: ExchangeLike, state: State): Broker {
  return cfg.mode === "paper" ? new PaperBroker(cfg, ex, state) : new ExchangeBroker(cfg, ex);
}
