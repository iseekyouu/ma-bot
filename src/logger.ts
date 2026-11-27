import * as fs from "node:fs";

export class Logger {
  constructor(private file: string | null) {}
  private write(level: string, msg: string) {
    const line = `${new Date().toISOString().replace("T", " ").slice(0, 19)} ${level} ${msg}`;
    (level === "ERROR" ? console.error : console.log)(line);
    if (this.file) fs.appendFileSync(this.file, line + "\n");
  }
  info(m: string) { this.write("INFO", m); }
  warn(m: string) { this.write("WARN", m); }
  error(m: string) { this.write("ERROR", m); }
}
