// Команды из чата Telegram. Пока одна: /log - прислать лог файлом за последние 4 ч, 12 ч или сутки.
// Бот слушает только чат из TELEGRAM_CHAT_ID, остальные игнорирует.

import type { Config } from "./config";
import { errText } from "./format";
import { tzLabel, type Logger } from "./logger";

const PERIODS = [
  { hours: 4, label: "4 ч" },
  { hours: 12, label: "12 ч" },
  { hours: 24, label: "Сутки" },
];

/** Больше сообщений подряд не шлём - присылаем файлом. */
const MAX_TEXT_MESSAGES = 5;
/** Лимит Telegram - 4096 символов на сообщение, оставляем запас на заголовок и теги. */
const CHUNK_CHARS = 3800;

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Делит лог на куски по целым строкам (уже экранированные для HTML), каждый влезает в одно сообщение. */
export function splitForTelegram(text: string): string[] {
  const chunks: string[] = [];
  let cur = "";
  for (const raw of text.split("\n")) {
    const line = escapeHtml(raw.length > CHUNK_CHARS / 2 ? raw.slice(0, CHUNK_CHARS / 2) + "…" : raw);
    if (cur && cur.length + line.length + 1 > CHUNK_CHARS) { chunks.push(cur); cur = ""; }
    cur += (cur ? "\n" : "") + line;
  }
  if (cur) chunks.push(cur);
  return chunks;
}

interface Update {
  update_id: number;
  message?: { chat: { id: number }; text?: string };
  callback_query?: { id: string; data?: string; message?: { chat: { id: number } } };
}

/** Слушает команды через long polling, пока не сработает stop. Ошибки только пишет в лог. */
export async function listenCommands(cfg: Config, log: Logger, stop: AbortSignal) {
  if (!cfg.telegramToken || !cfg.telegramChatId) return;

  const api = async <T>(method: string, body: object | FormData, timeoutMs = 15_000): Promise<T> => {
    const res = await fetch(`https://api.telegram.org/bot${cfg.telegramToken}/${method}`, {
      method: "POST",
      ...(body instanceof FormData
        ? { body }
        : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
      signal: AbortSignal.any([stop, AbortSignal.timeout(timeoutMs)]),
    });
    const data = (await res.json()) as { ok: boolean; result: T; description?: string };
    if (!data.ok) throw new Error(`${method}: ${data.description ?? res.status}`);
    return data.result;
  };
  const ourChat = (chat?: { id: number }) => String(chat?.id) === cfg.telegramChatId;

  async function sendLog(hours: number) {
    log.info(`Telegram: запрошен лог за ${hours} ч`);
    const text = log.readSince(Date.now() - hours * 3_600_000);
    const title = `Лог за последние ${hours} ч (время ${tzLabel()})`;
    if (!text) return api("sendMessage", { chat_id: cfg.telegramChatId, text: `За последние ${hours} ч записей в логе нет.` });

    // текстом, если влезает в несколько сообщений; иначе файлом
    const chunks = splitForTelegram(text);
    if (chunks.length <= MAX_TEXT_MESSAGES) {
      for (const [i, chunk] of chunks.entries()) {
        const head = i === 0 ? `${title}:\n` : "";
        await api("sendMessage", { chat_id: cfg.telegramChatId, text: `${head}<pre>${chunk}</pre>`, parse_mode: "HTML" });
      }
      return;
    }
    const form = new FormData();
    form.append("chat_id", cfg.telegramChatId);
    form.append("caption", `${title}. Длинный, поэтому файлом.`);
    const stamp = new Date().toISOString().slice(0, 16).replace(/[T:]/g, "-");
    form.append("document", new Blob([text], { type: "text/plain" }), `bot-${stamp}-last-${hours}h.log`);
    return api("sendDocument", form, 60_000);
  }

  async function handle(u: Update) {
    const cmd = u.message?.text?.match(/^\/log(?:@\w+)?(?:\s+(\d+))?\s*$/);
    if (cmd && ourChat(u.message?.chat)) {
      if (cmd[1]) return sendLog(Math.min(Number(cmd[1]), 24 * cfg.logRetentionDays));
      return api("sendMessage", {
        chat_id: cfg.telegramChatId,
        text: "За какой период прислать лог?",
        reply_markup: { inline_keyboard: [PERIODS.map((p) => ({ text: p.label, callback_data: `log:${p.hours}` }))] },
      });
    }
    const q = u.callback_query;
    const hours = q?.data?.match(/^log:(\d+)$/)?.[1];
    if (q && hours && ourChat(q.message?.chat)) {
      await api("answerCallbackQuery", { callback_query_id: q.id }).catch(() => {}); // убрать «часики» на кнопке
      return sendLog(Number(hours));
    }
  }

  await api("setMyCommands", { commands: [{ command: "log", description: "прислать лог: 4 ч, 12 ч или сутки" }] })
    .catch((e) => log.warn(`Telegram: не удалось зарегистрировать команды: ${errText(e)}`));

  let offset = 0;
  while (!stop.aborted) {
    try {
      const updates = await api<Update[]>("getUpdates",
        { offset, timeout: 30, allowed_updates: ["message", "callback_query"] }, 40_000);
      for (const u of updates) {
        offset = u.update_id + 1;
        await handle(u).catch((e) => log.warn(`Telegram: не удалось выполнить команду: ${errText(e)}`));
      }
    } catch (e) {
      if (stop.aborted) break;
      // например, нет сети или запущен второй экземпляр бота (Telegram отвечает Conflict)
      log.warn(`Telegram: не удалось получить команды: ${errText(e)}`);
      await new Promise<void>((r) => {
        const t = setTimeout(r, 60_000);
        stop.addEventListener("abort", () => { clearTimeout(t); r(); }, { once: true });
      });
    }
  }
}
