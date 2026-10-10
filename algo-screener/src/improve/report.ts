import type { BacktestResult } from "../backtest/engine.js";
import type { WalkForwardResult } from "../backtest/walkforward.js";
import { groupMetrics } from "../backtest/metrics.js";
import { isoDate } from "../util/time.js";
import type { ClosedTrade } from "../types.js";
import type { StrategyParams } from "../strategy/params.js";

/**
 * Builds the compact, text-first performance report the LLM reasons over.
 *
 * The model is far more useful when it can see *where* the strategy bled —
 * which timeframes, which exit reasons, which regimes — than when handed a
 * single P&L number. Everything here is derived from closed trades, so it
 * cannot leak future information back into the parameters.
 */

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function money(value: number): string {
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}`;
}

function describeTrades(trades: readonly ClosedTrade[], limit: number): string {
  return trades
    .slice(0, limit)
    .map(
      (t) =>
        `  ${t.symbol} ${t.side} ${t.timeframe} | ${isoDate(t.openedAt)} -> ${isoDate(t.closedAt)} | ` +
        `R ${t.rMultiple.toFixed(2)} | ${money(t.pnl)} | exit: ${t.exitReason}`,
    )
    .join("\n");
}

export function buildPerformanceReport(
  result: BacktestResult,
  params: StrategyParams,
  walkForwardResult?: WalkForwardResult,
): string {
  const m = result.metrics;
  const lines: string[] = [];

  lines.push("=== BACKTEST SUMMARY ===");
  lines.push(
    `Window: ${isoDate(result.from)} -> ${isoDate(result.to)} | step timeframe: ${result.stepTimeframe}`,
  );
  lines.push(`Symbols: ${result.symbols.join(", ")}`);
  lines.push(
    `Trades: ${m.trades} (${m.wins}W / ${m.losses}L, win rate ${pct(m.winRate)})`,
  );
  lines.push(
    `Return: ${pct(m.totalReturn)} | PnL ${money(m.totalPnl)} | fees ${m.feesPaid.toFixed(2)}`,
  );
  lines.push(
    `Sharpe ${m.sharpe.toFixed(2)} | Sortino ${m.sortino.toFixed(2)} | Calmar ${m.calmar.toFixed(2)}`,
  );
  lines.push(
    `Max drawdown ${pct(m.maxDrawdown)} | profit factor ${m.profitFactor.toFixed(2)} | expectancy ${m.expectancy.toFixed(3)}R`,
  );
  lines.push(
    `Avg win ${money(m.avgWin)} | avg loss ${money(m.avgLoss)} | max consecutive losses ${m.maxConsecutiveLosses}`,
  );
  lines.push(`Avg hold: ${m.avgHoldHours.toFixed(1)}h`);
  lines.push("");

  if (walkForwardResult && walkForwardResult.folds.length > 0) {
    lines.push("=== WALK-FORWARD (out-of-sample) ===");
    lines.push(
      `Fold consistency: ${pct(walkForwardResult.foldConsistency)} of folds profitable`,
    );
    for (const fold of walkForwardResult.folds) {
      const fm = fold.result.metrics;
      lines.push(
        `  fold ${fold.index}: ${isoDate(fold.testFrom)} -> ${isoDate(fold.testTo)} | ` +
          `${fm.trades} trades | return ${pct(fm.totalReturn)} | DD ${pct(fm.maxDrawdown)} | PF ${fm.profitFactor.toFixed(2)}`,
      );
    }
    lines.push("");
  }

  // --- Where the money came from / went --------------------------------
  const byTimeframe = groupMetrics(result.trades, (t) => t.timeframe);
  if (byTimeframe.size > 0) {
    lines.push("=== BY ANCHOR TIMEFRAME ===");
    for (const [tf, stats] of [...byTimeframe].sort((a, b) => b[1].totalPnl - a[1].totalPnl)) {
      lines.push(
        `  ${tf.padEnd(4)} | ${String(stats.trades).padStart(3)} trades | win ${pct(stats.winRate).padStart(6)} | ` +
          `PnL ${money(stats.totalPnl).padStart(10)} | expectancy ${stats.expectancy.toFixed(2)}R`,
      );
    }
    lines.push("");
  }

  const bySymbol = groupMetrics(result.trades, (t) => t.symbol);
  if (bySymbol.size > 0) {
    lines.push("=== BY SYMBOL ===");
    for (const [symbol, stats] of [...bySymbol].sort((a, b) => b[1].totalPnl - a[1].totalPnl)) {
      lines.push(
        `  ${symbol.padEnd(10)} | ${String(stats.trades).padStart(3)} trades | win ${pct(stats.winRate).padStart(6)} | ` +
          `PnL ${money(stats.totalPnl).padStart(10)} | expectancy ${stats.expectancy.toFixed(2)}R`,
      );
    }
    lines.push("");
  }

  const byExit = groupMetrics(result.trades, (t) => t.exitReason);
  if (byExit.size > 0) {
    lines.push("=== BY EXIT REASON ===");
    for (const [reason, stats] of [...byExit].sort((a, b) => b[1].trades - a[1].trades)) {
      lines.push(
        `  ${reason.padEnd(14)} | ${String(stats.trades).padStart(3)} trades | win ${pct(stats.winRate).padStart(6)} | ` +
          `PnL ${money(stats.totalPnl).padStart(10)} | expectancy ${stats.expectancy.toFixed(2)}R`,
      );
    }
    lines.push("");
  }

  const bySide = groupMetrics(result.trades, (t) => t.side);
  if (bySide.size > 0) {
    lines.push("=== BY SIDE ===");
    for (const [side, stats] of bySide) {
      lines.push(
        `  ${side.padEnd(6)} | ${stats.trades} trades | win ${pct(stats.winRate)} | PnL ${money(stats.totalPnl)}`,
      );
    }
    lines.push("");
  }

  // --- Specific failures the model can act on ---------------------------
  const sorted = [...result.trades].sort((a, b) => a.pnl - b.pnl);
  if (sorted.length > 0) {
    lines.push("=== WORST TRADES ===");
    lines.push(describeTrades(sorted, 6));
    lines.push("");
    lines.push("=== BEST TRADES ===");
    lines.push(describeTrades([...sorted].reverse(), 4));
    lines.push("");
  }

  const rejections = Object.entries(result.rejections).sort((a, b) => b[1] - a[1]);
  if (rejections.length > 0) {
    lines.push("=== REJECTED ENTRIES (risk gate) ===");
    for (const [reason, count] of rejections.slice(0, 8)) {
      lines.push(`  ${count}x ${reason}`);
    }
    lines.push("");
  }

  // --- Diagnostics worth calling out explicitly -------------------------
  const diagnostics: string[] = [];
  const stopOuts = byExit.get("stop_loss");
  if (stopOuts && m.trades > 0 && stopOuts.trades / m.trades > 0.5) {
    diagnostics.push(
      `${pct(stopOuts.trades / m.trades)} of trades ended at the stop — stops may be too tight for the ATR multiple in use, or entries are too early.`,
    );
  }
  const maxHold = byExit.get("max_hold");
  if (maxHold && m.trades > 0 && maxHold.trades / m.trades > 0.3) {
    diagnostics.push(
      `${pct(maxHold.trades / m.trades)} of trades hit the time stop — maxHoldBars may be too short, or entries are made in directionless conditions.`,
    );
  }
  if (m.trades > 0 && m.winRate > 0.6 && m.expectancy < 0) {
    diagnostics.push(
      "High win rate with negative expectancy — winners are being cut short relative to losers; consider wider take-profit rungs or a later trail start.",
    );
  }
  if (m.trades < 20) {
    diagnostics.push(
      `Only ${m.trades} trades — entry thresholds (minScore ${params.entry.minScore}, minAlignment ${params.entry.minAlignment}) may be too strict to measure anything reliably.`,
    );
  }
  if (m.maxDrawdown > 0.2) {
    diagnostics.push(
      `Drawdown of ${pct(m.maxDrawdown)} is high — consider lower riskPerTrade, fewer concurrent positions, or an earlier break-even stop.`,
    );
  }
  if (diagnostics.length > 0) {
    lines.push("=== DIAGNOSTICS ===");
    for (const d of diagnostics) lines.push(`  - ${d}`);
    lines.push("");
  }

  lines.push("=== CURRENT PARAMETERS ===");
  lines.push(JSON.stringify(params, null, 2));

  return lines.join("\n");
}
