// Уведомления в Telegram (и в лог).

import type { Config } from "./config";
import type { Logger } from "./logger";

export class Notifier {
  constructor(private cfg: Config, private log: Logger) {}
  async send(text: string) {
    const prefix = this.cfg.mode === "live" ? "" : `[${this.cfg.mode.toUpperCase()}] `;
    this.log.info(`Уведомление: ${text.replace(/\n/g, " | ")}`);
    if (!this.cfg.telegramToken || !this.cfg.telegramChatId) return;
    try {
      await fetch(`https://api.telegram.org/bot${this.cfg.telegramToken}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: this.cfg.telegramChatId, text: prefix + text }),
        signal: AbortSignal.timeout(15000),
      });
    } catch (e) {
      this.log.warn(`Не удалось отправить в Telegram: ${(e as Error).message}`);
    }
  }
}
