// Мелкие функции форматирования для логов, уведомлений и консоли.

export const fmtDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
export const fmtTime = (ms: number) => new Date(ms).toISOString().replace("T", " ").slice(0, 16) + " UTC";
export const sign = (x: number) => (x >= 0 ? "+" : "");
export const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
export const errStack = (e: unknown) => (e instanceof Error ? e.stack ?? e.message : String(e));
