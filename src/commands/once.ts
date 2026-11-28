import { ACTION_TEXT, checkAndTrade } from "../bot";
import { errStack, errText } from "../format";
import { Notifier } from "../notifier";
import { openAccount, type Ctx } from "./context";

export async function cmdOnce({ cfg, log, args }: Ctx) {
  const { ex, state, broker } = await openAccount(cfg);
  const notifier = new Notifier(cfg, log);
  try {
    const action = await checkAndTrade(cfg, ex, broker, state, notifier, log, { force: args.force });
    log.info(`Проверка: ${ACTION_TEXT[action]} (${action})`);
  } catch (e) {
    log.error(`Ошибка проверки: ${errStack(e)}`);
    await notifier.send(`Ошибка бота: ${errText(e)}`);
    process.exitCode = 1;
  }
}
