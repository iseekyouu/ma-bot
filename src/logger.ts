import * as fs from "node:fs";
import * as path from "node:path";

/** Местное время компьютера: «2026-11-28 03:18:38». */
export const localStamp = (ms: number) => new Date(ms).toLocaleString("sv-SE");

/** Часовой пояс компьютера: «UTC+3». */
export function tzLabel(ms = Date.now()) {
  const off = -new Date(ms).getTimezoneOffset();
  const hm = `${Math.floor(Math.abs(off) / 60)}${Math.abs(off) % 60 ? `:${String(Math.abs(off) % 60).padStart(2, "0")}` : ""}`;
  return `UTC${off >= 0 ? "+" : "-"}${hm}`;
}

const DAY_MS = 86_400_000;
const FILE_RE = /^bot-(\d{4}-\d{2}-\d{2})\.log$/;

/** Пишет в консоль и в файл за текущий местный день (bot-2026-11-28.log); файлы старше keepDays дней удаляет. */
export class Logger {
  private day = "";

  constructor(private dir: string | null, private keepDays = 30) {}

  private write(level: string, msg: string) {
    const stamp = localStamp(Date.now());
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
    const oldest = localStamp(Date.now() - (this.keepDays - 1) * DAY_MS).slice(0, 10);
    for (const f of fs.readdirSync(this.dir!)) {
      const m = FILE_RE.exec(f);
      if (m && m[1] < oldest) fs.rmSync(path.join(this.dir!, f), { force: true });
    }
  }

  /** Записи лога начиная с sinceMs, по всем дневным файлам. Многострочные записи (стек ошибки) - целиком. */
  readSince(sinceMs: number): string {
    if (!this.dir || !fs.existsSync(this.dir)) return "";
    const since = localStamp(sinceMs);
    const files = fs.readdirSync(this.dir)
      .filter((f) => FILE_RE.exec(f)?.[1]! >= since.slice(0, 10))
      .sort();
    const out: string[] = [];
    for (const f of files) {
      let keep = false;
      for (const line of fs.readFileSync(path.join(this.dir, f), "utf8").split("\n")) {
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
