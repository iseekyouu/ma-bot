import { checkAndTrade, isInPosition, type Action } from "../bot";
import { errStack, errText, fmtTime } from "../format";
import * as msg from "../messages";
import { Notifier } from "../notifier";
import { openAccount, type Ctx } from "./context";

/** Штатные исходы проверки, о которых не пишем в лог на каждой итерации. */
const ROUTINE_ACTIONS = new Set<Action>(["wait", "already_processed", "limit_pending"]);

/** Уведомляем о первой ошибке подряд, о пятой и далее о каждой двадцатой — чтобы не спамить. */
const shouldNotifyError = (streak: number) => streak === 1 || streak === 5 || streak % 20 === 0;

/** Спит seconds секунд, просыпаясь раз в секунду, чтобы быстро реагировать на остановку. */
async function sleepUnless(seconds: number, stopped: () => boolean) {
  for (let s = 0; s < seconds && !stopped(); s++) await new Promise((r) => setTimeout(r, 1000));
}

/** Сигналы, по которым бот штатно останавливается и присылает «Бот остановлен». */
const STOP_SIGNALS = { SIGINT: "Ctrl+C", SIGTERM: "SIGTERM", SIGHUP: "закрыт терминал" } as const;

export async function cmdRun({ cfg, log }: Ctx) {
  log.info(`Старт ${fmtTime(Date.now())}: режим ${cfg.mode}, ${cfg.symbol}, MA${cfg.maPeriod}, sizing=${cfg.sizing}, execution=${cfg.execution}`);
  if (cfg.mode === "live") log.warn("БОЕВОЙ РЕЖИМ: бот будет отправлять реальные ордера на Bybit.");

  const notifier = new Notifier(cfg, log);

  // Неожиданная ошибка вне проверки (баг, сбой рантайма) иначе убила бы процесс молча: сообщаем и выходим с кодом 1
  let crashed = false;
  const crash = async (e: unknown) => {
    if (crashed) return;
    crashed = true;
    log.error(`Бот упал: ${errStack(e)}`);
    await notifier.send(msg.botCrashed(errText(e)));
    process.exit(1);
  };
  process.on("uncaughtException", crash);
  process.on("unhandledRejection", crash);

  let account;
  try {
    account = await openAccount(cfg);
  } catch (e) {
    // например, Bybit недоступен или ключ неверный - сообщаем, иначе бот молча не работает
    await notifier.send(msg.botStartFailed(errText(e)));
    throw e;
  }
  const { ex, state, broker } = account;
  await notifier.send(msg.botStarted(cfg));

  let stopSignal = "";
  const stopping = () => stopSignal !== "";
  for (const [signal, reason] of Object.entries(STOP_SIGNALS)) {
    process.on(signal, () => {
      if (stopping()) return;
      stopSignal = reason;
      log.info(`Получен ${signal}, завершаюсь после текущей проверки`);
    });
  }

  let errorStreak = 0;
  while (!stopping()) {
    try {
      const action = await checkAndTrade(cfg, ex, broker, state, notifier, log);
      if (!ROUTINE_ACTIONS.has(action)) log.info(`Действие: ${action}`);
      errorStreak = 0;
    } catch (e) {
      errorStreak++;
      log.error(`Ошибка проверки (${errorStreak} подряд): ${errStack(e)}`);
      if (shouldNotifyError(errorStreak)) await notifier.send(`Ошибка бота (${errorStreak} подряд): ${errText(e)}`);
    }
    await sleepUnless(cfg.checkIntervalMinutes * 60, stopping);
  }

  // что сейчас на счёте - по реальному балансу; если биржа не ответила, просто не пишем
  const holding = await Promise.all([broker.balances(), broker.price()])
    .then(([bal, price]) => (isInPosition(cfg, bal.base, price) ? broker.base : broker.quote))
    .catch(() => "");
  await notifier.send(msg.botStopped(stopSignal, holding));
}
