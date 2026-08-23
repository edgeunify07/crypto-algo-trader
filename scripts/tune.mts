/**
 * Strategy auto-tune script. Run: npm run tune
 *
 * Ranks by AFTER-COST expectancy and reports win rate honestly — it does NOT
 * hunt for high win rate. Manufacturing a high WR means shrinking the target
 * relative to the stop, which provably raises the breakeven WR above what the
 * strategy achieves (a 0.30% round trip makes any tight target a net loser).
 * A config is only labelled viable if expectancy > 0 AND it beats buy & hold.
 */
import { tuneSwing, tuneScalp } from "../src/lib/strategies/tuning.js";

const startEquity = 100;

function verdict(r: { expectancy: number; beatsBuyHold: boolean; numTrades: number }): string {
  if (r.numTrades < 3) return "NOT VIABLE (too few trades)";
  if (r.expectancy <= 0) return "NOT VIABLE (negative expectancy after costs)";
  if (!r.beatsBuyHold) return "NOT VIABLE (underperforms buy & hold)";
  return "viable (positive expectancy, beats buy & hold)";
}

async function main() {
  console.log("Tuning Confluence (Swing) on BTCUSDT 15m by after-cost expectancy…");
  const swing = await tuneSwing("BTCUSDT", startEquity);
  const bestSwing = swing.filter((r) => r.numTrades >= 3)[0] ?? swing[0];
  console.log("\n=== TOP SWING CONFIG ===");
  console.log(verdict(bestSwing));
  console.log(JSON.stringify({
    score: bestSwing.score,
    return: bestSwing.totalReturnPct.toFixed(2) + "%",
    buyHold: bestSwing.buyHoldReturnPct.toFixed(2) + "%",
    winRate: bestSwing.winRate.toFixed(1) + "%",
    pf: bestSwing.profitFactor.toFixed(2),
    trades: bestSwing.numTrades,
    maxDD: bestSwing.maxDrawdownPct.toFixed(2) + "%",
    expectancy: bestSwing.expectancy.toFixed(3),
    params: {
      entryThreshold: bestSwing.params.entryThreshold,
      minConfirmFactors: bestSwing.params.minConfirmFactors,
      minConfidence: bestSwing.params.minConfidence,
      emaFast: bestSwing.params.emaFast,
      emaSlow: bestSwing.params.emaSlow,
      minRvol: bestSwing.params.minRvol,
      requireTrending: bestSwing.params.requireTrending,
      requireCoreFactors: bestSwing.params.requireCoreFactors,
    },
  }, null, 2));
  console.log(`\nViable swing configs (expectancy > 0 AND beats buy & hold): ${swing.filter((r) => r.numTrades >= 3 && r.expectancy > 0 && r.beatsBuyHold).length} / ${swing.length}`);

  // High-WR configs are shown as a WARNING, not a recommendation: measured on this
  // codebase, most ≥80% WR configs lose money because the tight target cannot pay
  // the round-trip cost. Do not pick from this list.
  const highWr = swing.filter((r) => r.winRate >= 80 && r.numTrades >= 3);
  if (highWr.length) {
    const profitable = highWr.filter((r) => r.expectancy > 0 && r.beatsBuyHold).length;
    console.log(`\n⚠ ${highWr.length} config(s) show WR ≥ 80%, of which only ${profitable} are actually viable.`);
    console.log("  High win rate is not the objective — it is usually a tight-target artifact. Do not select on it.");
  }

  console.log("\nTuning Confluence (Scalp) on ETHUSDT 1m…");
  const scalp = await tuneScalp("ETHUSDT", startEquity);
  const bestScalp = scalp.filter((r) => r.numTrades >= 3)[0] ?? scalp[0];
  const viableScalp = scalp.filter((r) => r.numTrades >= 3 && r.expectancy > 0 && r.beatsBuyHold);
  console.log("\n=== TOP SCALP CONFIG ===");
  console.log(verdict(bestScalp));
  console.log(JSON.stringify({
    score: bestScalp.score,
    return: bestScalp.totalReturnPct.toFixed(2) + "%",
    buyHold: bestScalp.buyHoldReturnPct.toFixed(2) + "%",
    winRate: bestScalp.winRate.toFixed(1) + "%",
    pf: bestScalp.profitFactor.toFixed(2),
    trades: bestScalp.numTrades,
    maxDD: bestScalp.maxDrawdownPct.toFixed(2) + "%",
    expectancy: bestScalp.expectancy.toFixed(3),
    params: {
      entryThreshold: bestScalp.params.entryThreshold,
      minConfirmFactors: bestScalp.params.minConfirmFactors,
      minRvol: bestScalp.params.minRvol,
      targetPct: bestScalp.params.targetPct,
      stopPct: bestScalp.params.stopPct,
    },
  }, null, 2));
  console.log(`\nViable scalp configs: ${viableScalp.length} / ${scalp.length}`);
  if (!viableScalp.length) {
    console.log("⚠ NO VIABLE SCALP CONFIG on this window — the config above LOSES money after costs.");
    console.log("  Do not trade it. A staged search over 198 configs × 13 datasets (1y 15m / 180d 5m / 45d 1m)");
    console.log("  found zero scalp configs with positive out-of-sample expectancy. See scripts/scratch/scalp-search.mts.");
  }
  console.log("\nNOTE: these scalp numbers come from backtestScalp (maker-limit entry + fixed brackets),");
  console.log("which is NOT what the live bot executes (live uses ATR stops via computeProtection).");
}

main().catch((e) => { console.error(e); process.exit(1); });
