import { NextResponse } from "next/server";
import { KEYS, kv } from "@/lib/store/kv";
import { fetchMarkPrices } from "@/lib/futures/rest";
import {
  DEFAULT_LEVERAGE,
  STARTING_BALANCE,
  drawdown,
  equity,
  newAccount,
  unrealisedTotal,
  type AccountState,
  type EquityPoint,
  type FuturesPosition,
  type FuturesTrade,
} from "@/lib/store/account";
import { unrealisedPnl } from "@/lib/futures/fees";
import { DEFAULT_PARAMS } from "@/lib/algo/strategy/params";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * Everything the dashboard needs in one request.
 *
 * Positions are valued at the live **mark** price, which is what Binance uses
 * for futures PnL and liquidation — using the last traded price would show a
 * number that disagrees with the exchange.
 */
export async function GET() {
  const store = kv();

  const [account, positions, equityCurve, trades, params] = await Promise.all([
    store.get<AccountState>(KEYS.account),
    store.get<FuturesPosition[]>(KEYS.positions),
    store.list<EquityPoint>(KEYS.equity, 500),
    store.list<FuturesTrade>(KEYS.trades, 100),
    store.get<{
      version: string;
      source: string;
      updatedAt: number;
      params?: Record<string, unknown>;
    }>(KEYS.params),
  ]);

  const acct = account ?? newAccount(STARTING_BALANCE);
  const open = positions ?? [];

  const marks: Record<string, number> = {};
  if (open.length > 0) {
    try {
      for (const m of await fetchMarkPrices()) marks[m.symbol] = m.markPrice;
    } catch {
      // Fall back to entry pricing rather than failing the whole dashboard.
    }
  }

  const currentEquity = equity(acct, open, marks);
  const realisedTrades = trades.length;
  const wins = trades.filter((t) => t.netPnl > 0).length;

  return NextResponse.json(
    {
      durable: store.isDurable,
      account: {
        ...acct,
        equity: currentEquity,
        unrealised: unrealisedTotal(open, marks),
        drawdown: drawdown(acct, currentEquity),
        returnPct:
          acct.startingBalance > 0
            ? (currentEquity - acct.startingBalance) / acct.startingBalance
            : 0,
        leverage: DEFAULT_LEVERAGE,
      },
      positions: open.map((p) => {
        const mark = marks[p.symbol] ?? p.entryPrice;
        const uPnl = unrealisedPnl({
          side: p.side,
          entryPrice: p.entryPrice,
          quantity: p.quantity,
          markPrice: mark,
        });
        return {
          ...p,
          markPrice: mark,
          unrealised: uPnl,
          // Return on the margin actually committed, which is what a 3x
          // position's P&L feels like to the account.
          unrealisedPct: p.margin > 0 ? uPnl / p.margin : 0,
          distanceToLiquidation:
            mark > 0 ? Math.abs(mark - p.liquidationPrice) / mark : 0,
          notional: p.quantity * mark,
        };
      }),
      stats: {
        trades: realisedTrades,
        wins,
        losses: realisedTrades - wins,
        winRate: realisedTrades > 0 ? wins / realisedTrades : 0,
        netPnl: trades.reduce((a, t) => a + t.netPnl, 0),
        grossPnl: trades.reduce((a, t) => a + t.grossPnl, 0),
        fees: trades.reduce((a, t) => a + t.entryFee + t.exitFee, 0),
        funding: trades.reduce((a, t) => a + t.fundingCost, 0),
      },
      params: {
        version: params?.version ?? "default-v1",
        source: params?.source ?? "default",
        updatedAt: params?.updatedAt ?? 0,
        // The panel renders these read-only; they are owned by the
        // improvement loop, so a manual edit here would just be overwritten.
        detail: params?.params ?? DEFAULT_PARAMS,
      },
      equityCurve,
      updatedAt: Date.now(),
    },
    { headers: { "cache-control": "no-store" } },
  );
}
