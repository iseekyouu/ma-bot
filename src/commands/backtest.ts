import type { Config } from "../config";
import { fetchDailyHistory, makeExchange } from "../exchange";
import { fmtDay, sign } from "../format";
import { backtest, DAY_MS, type BacktestResult } from "../strategy";
import type { Ctx } from "./context";

function printBacktest(cfg: Config, r: BacktestResult) {
  const pct = (x: number) => `${sign(x - r.start)}${((x / r.start - 1) * 100).toFixed(1)}%`;
  console.log(`Бэктест MA${cfg.maPeriod} на ${cfg.symbol}: ${fmtDay(r.from)} - ${fmtDay(r.to)}`);
  console.log(`  Стратегия:        ${r.start} -> ${r.final.toFixed(2)} (${pct(r.final)}), входов ${r.entries}, ` +
    `прибыльных ${r.wins}, макс. просадка ${r.maxDrawdownPct.toFixed(1)}%`);
  console.log(`  Купить и держать: ${r.start} -> ${r.buyHold.toFixed(2)} (${pct(r.buyHold)})`);
  console.log(`  Сейчас стратегия: ${r.inPosition ? "в BTC" : "в USDT"}`);

  if (!r.trades.length) return;
  console.log("\n  Сделки (вход / выход по цене открытия дня):");
  for (const t of r.trades) {
    const exit = t.sellTs
      ? `${fmtDay(t.sellTs)} @ ${t.sellPrice!.toFixed(0)}  ${sign(t.pnlPct!)}${t.pnlPct!.toFixed(1)}%`
      : "открыта";
    console.log(`  ${fmtDay(t.buyTs)} @ ${t.buyPrice.toFixed(0)}  ->  ${exit}`);
  }
}

export async function cmdBacktest({ cfg, args }: Ctx) {
  const ex = await makeExchange({ ...cfg, mode: "paper" }, true);
  const now = ex.milliseconds();
  const since = now - (args.days + cfg.maPeriod + 2) * DAY_MS;
  const closed = (await fetchDailyHistory(ex, cfg.symbol, since)).filter((c) => c[0] + DAY_MS <= now);
  printBacktest(cfg, backtest(closed, cfg.maPeriod, args.days, cfg.feePct, cfg.paperStartQuote));
}
