/**
 * Strategy auto-tune script. Run: npm run tune
 * Prefers high win-rate configs (≥80% when available).
 */
import { tuneSwing, tuneScalp } from "../src/lib/strategies/tuning.js";

const startEquity = 100;

async function main() {
  console.log("Tuning Confluence (Swing) on BTCUSDT 15m for high win-rate…");
  const swing = await tuneSwing("BTCUSDT", startEquity);
  const bestSwing = swing.filter((r) => r.numTrades >= 3)[0] ?? swing[0];
  console.log("\n=== BEST SWING (win-rate first) ===");
  console.log(JSON.stringify({
    score: bestSwing.score,
    return: bestSwing.totalReturnPct.toFixed(2) + "%",
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

  const highWr = swing.filter((r) => r.winRate >= 80 && r.numTrades >= 3).slice(0, 5);
  console.log("\nConfigs with WR ≥ 80%:", highWr.length ? highWr.map((r) => ({
    wr: r.winRate.toFixed(0), ret: r.totalReturnPct.toFixed(2), pf: r.profitFactor.toFixed(2), n: r.numTrades,
    th: r.params.entryThreshold, conf: r.params.minConfirmFactors, minConf: r.params.minConfidence,
  })) : "(none — showing top 5 by WR instead)");
  if (!highWr.length) {
    console.log(swing.slice(0, 5).map((r) => ({
      wr: r.winRate.toFixed(0), ret: r.totalReturnPct.toFixed(2), pf: r.profitFactor.toFixed(2), n: r.numTrades,
    })));
  }

  console.log("\nTuning Confluence (Scalp) on ETHUSDT 1m…");
  const scalp = await tuneScalp("ETHUSDT", startEquity);
  const bestScalp = scalp.filter((r) => r.numTrades >= 3)[0] ?? scalp[0];
  console.log("\n=== BEST SCALP ===");
  console.log(JSON.stringify({
    score: bestScalp.score,
    return: bestScalp.totalReturnPct.toFixed(2) + "%",
    winRate: bestScalp.winRate.toFixed(1) + "%",
    pf: bestScalp.profitFactor.toFixed(2),
    trades: bestScalp.numTrades,
    maxDD: bestScalp.maxDrawdownPct.toFixed(2) + "%",
    params: {
      entryThreshold: bestScalp.params.entryThreshold,
      minConfirmFactors: bestScalp.params.minConfirmFactors,
      minRvol: bestScalp.params.minRvol,
      targetPct: bestScalp.params.targetPct,
      stopPct: bestScalp.params.stopPct,
    },
  }, null, 2));

  console.log("\nTop 5 swing by WR:", swing.slice(0, 5).map((r) => ({
    wr: r.winRate.toFixed(0), ret: r.totalReturnPct.toFixed(2), pf: r.profitFactor.toFixed(2), n: r.numTrades,
  })));
}

main().catch((e) => { console.error(e); process.exit(1); });
