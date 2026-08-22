import { getEvents } from "./executor";
import { RiskGuard } from "./risk";
import { getScalpBacktestMeta, makerFillRatio } from "./scalpState";

export interface PromotionCriterion {
  id: string;
  label: string;
  pass: boolean;
  detail: string;
}

export interface PromotionGateResult {
  ready: boolean;
  criteria: PromotionCriterion[];
}

const MIN_PAPER_TRADES = 30;

/** Machine-checked gate before enabling Live toggle (§10.4). */
export async function evaluatePromotionGate(): Promise<PromotionGateResult> {
  const events = await getEvents(500);
  const paperTrades = events.filter((e) => e.action === "SELL" && !e.live);
  const risk = RiskGuard.status();

  const positivePnl = paperTrades.filter((e) => (e.pnl ?? 0) > 0);
  const totalPnl = paperTrades.reduce((s, e) => s + (e.pnl ?? 0), 0);
  const wins = positivePnl.length;
  const winRate = paperTrades.length ? wins / paperTrades.length : 0;
  const avgWin = wins ? positivePnl.reduce((s, e) => s + (e.pnl ?? 0), 0) / wins : 0;
  const losses = paperTrades.filter((e) => (e.pnl ?? 0) <= 0);
  const avgLoss = losses.length ? Math.abs(losses.reduce((s, e) => s + (e.pnl ?? 0), 0) / losses.length) : 0;
  const expectancy = paperTrades.length ? totalPnl / paperTrades.length : 0;

  const scalpMeta = getScalpBacktestMeta();
  const liveMakerRatio = makerFillRatio();

  const criteria: PromotionCriterion[] = [
    {
      id: "min_trades",
      label: `≥${MIN_PAPER_TRADES} paper trades`,
      pass: paperTrades.length >= MIN_PAPER_TRADES,
      detail: `${paperTrades.length} completed`,
    },
    {
      id: "expectancy",
      label: "Positive expectancy (net of fees)",
      pass: expectancy > 0,
      detail: `$${expectancy.toFixed(2)}/trade`,
    },
    {
      id: "profit_factor",
      label: "Profit factor > 1",
      pass: avgLoss > 0 ? avgWin / avgLoss > 1 : totalPnl > 0,
      detail: avgLoss > 0 ? (avgWin / avgLoss).toFixed(2) : "N/A",
    },
    {
      id: "daily_loss",
      label: "Within daily loss limit",
      pass: risk.realizedPnlToday > -risk.limits.maxDailyLossUSDT,
      detail: `$${risk.realizedPnlToday.toFixed(2)} today`,
    },
    {
      id: "kill_switch",
      label: "Kill switch off",
      pass: !risk.killSwitch,
      detail: risk.killSwitch ? "engaged" : "off",
    },
    {
      id: "scalp_aggtrades",
      label: "Scalp backtest used aggTrades (not kline-only)",
      pass: scalpMeta.strategyId !== "confluence-scalp" || !scalpMeta.klineOnly,
      detail: scalpMeta.klineOnly ? "kline-only blocked" : "aggTrade replay OK",
    },
    {
      id: "maker_fill_ratio",
      label: "Maker fill ratio ≥ 70%",
      pass: liveMakerRatio >= 0.7 || scalpMeta.strategyId !== "confluence-scalp",
      detail: `${(liveMakerRatio * 100).toFixed(0)}% maker fills`,
    },
  ];

  return {
    ready: criteria.every((c) => c.pass),
    criteria,
  };
}

export function getMinNotionalWarning(symbol: string, minNotional: number, equity: number, riskPct: number): string | null {
  const riskBudget = equity * (riskPct / 100);
  if (minNotional > riskBudget * 2) {
    return `${symbol} min notional $${minNotional} exceeds risk budget $${riskBudget.toFixed(2)} — consider alt pairs`;
  }
  if (symbol === "BTCUSDT" && equity < 200) {
    return "BTCUSDT perp min ~$100 — not viable for accounts under $200";
  }
  return null;
}
