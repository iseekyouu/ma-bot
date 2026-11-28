import * as fs from "node:fs";
import * as path from "node:path";

/** Пишет в консоль и в файл за текущий день UTC (bot-2026-11-28.log); файлы старше keepDays дней удаляет. */
export class Logger {
  private day = "";

  constructor(private dir: string | null, private keepDays = 30) {}

  private write(level: string, msg: string) {
    const stamp = new Date().toISOString().replace("T", " ").slice(0, 19);
    const line = `${stamp} ${level} ${msg}`;
    (level === "ERROR" ? console.error : console.log)(line);
    if (!this.dir) return;
    const day = stamp.slice(0, 10);
    if (day !== this.day) this.startDay(day);
    fs.appendFileSync(path.join(this.dir, `bot-${day}.log`), line + "\n");
  }

  /** Новый день: убираем файлы, вышедшие за keepDays (сегодняшний считается). */
  private startDay(day: string) {
    this.day = day;
    fs.mkdirSync(this.dir!, { recursive: true });
    const oldest = new Date(Date.parse(day) - (this.keepDays - 1) * 86_400_000).toISOString().slice(0, 10);
    for (const f of fs.readdirSync(this.dir!)) {
      const m = /^bot-(\d{4}-\d{2}-\d{2})\.log$/.exec(f);
      if (m && m[1] < oldest) fs.rmSync(path.join(this.dir!, f), { force: true });
    }
  }

  /** Записи лога начиная с sinceMs, по всем дневным файлам. Многострочные записи (стек ошибки) - целиком. */
  readSince(sinceMs: number): string {
    if (!this.dir) return "";
    const since = new Date(sinceMs).toISOString().replace("T", " ").slice(0, 19);
    const out: string[] = [];
    for (let d = Math.floor(sinceMs / 86_400_000) * 86_400_000; d <= Date.now(); d += 86_400_000) {
      const file = path.join(this.dir, `bot-${new Date(d).toISOString().slice(0, 10)}.log`);
      if (!fs.existsSync(file)) continue;
      let keep = false;
      for (const line of fs.readFileSync(file, "utf8").split("\n")) {
        if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} /.test(line)) keep = line.slice(0, 19) >= since;
        if (keep && line) out.push(line);
      }
    }
    return out.join("\n");
  }

  info(m: string) { this.write("INFO", m); }
  warn(m: string) { this.write("WARN", m); }
  error(m: string) { this.write("ERROR", m); }
}
