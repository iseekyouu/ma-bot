// Версия бота: номер из package.json (поднимаем при каждом пуше) и коммит, если код запущен из git.

import * as fs from "node:fs";
import * as path from "node:path";
import { PROJECT_DIR } from "./config";

function readVersion(): string {
  const { version } = JSON.parse(fs.readFileSync(path.join(PROJECT_DIR, "package.json"), "utf8")) as { version: string };
  try {
    const git = Bun.spawnSync(["git", "rev-parse", "--short", "HEAD"], { cwd: PROJECT_DIR });
    const commit = git.success ? git.stdout.toString().trim() : "";
    return commit ? `${version} (${commit})` : version;
  } catch {
    return version; // git не установлен - достаточно номера
  }
}

/** «1.1.0 (3125ebf)». */
export const VERSION = readVersion();
