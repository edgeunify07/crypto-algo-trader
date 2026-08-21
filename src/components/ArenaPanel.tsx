"use client";

import { useEffect, useState } from "react";
import type { CandleInterval } from "@/lib/types";

interface Row {
  id: string;
  name: string;
  totalReturnPct: number;
  buyHoldReturnPct: number;
  numTrades: number;
  winRate: number;
  maxDrawdownPct: number;
  totalFeesPaid: number;
  endEquity: number;
}
interface Arena { bars: number; from: number; to: number; buyHoldReturnPct: number; leaderboard: Row[] }

const fmt = (n: number, d = 2) => new Intl.NumberFormat("en-US", { minimumFractionDigits: d, maximumFractionDigits: d }).format(n);
const day = (s: number) => new Date(s * 1000).toLocaleDateString();

export default function ArenaPanel({
  symbol,
  interval,
  onUseStrategy,
}: {
  symbol: string;
  interval: CandleInterval;
  onUseStrategy: (id: string) => void;
}) {
  const [data, setData] = useState<Arena | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const r = await fetch(`/api/arena?symbol=${symbol}&interval=${interval}`);
        const j = await r.json();
        if (!alive) return;
        if (!r.ok) throw new Error(j.error ?? "failed");
        setData(j);
        setErr(null);
      } catch (e) {
        if (alive) setErr(e instanceof Error ? e.message : "failed");
      } finally {
        if (alive) timer = setTimeout(poll, 8000);
      }
    }
    poll();
    return () => { alive = false; clearTimeout(timer); };
  }, [symbol, interval]);

  const board = data?.leaderboard ?? [];
  const best = board[0];

  return (
    <div className="nums text-xs">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-3 py-2">
        <div className="text-[11px] text-muted">
          Auto-backtest · all algos · <span className="text-text">{symbol}</span> {interval} ·{" "}
          {data ? `${data.bars} bars (${day(data.from)}–${day(data.to)})` : "loading…"} · real 0.1% fees
        </div>
        {best && (
          <div className="text-[11px]">
            <span className="text-muted">Best: </span>
            <span className="font-semibold text-accent">{best.name}</span>{" "}
            <span className={best.totalReturnPct >= 0 ? "text-up" : "text-down"}>{best.totalReturnPct >= 0 ? "+" : ""}{best.totalReturnPct.toFixed(2)}%</span>
            <span className="text-muted"> vs B&amp;H {data!.buyHoldReturnPct.toFixed(2)}%</span>
          </div>
        )}
      </div>
      {err && <div className="px-3 py-1 text-[11px] text-down">{err}</div>}

      <table className="w-full text-left">
        <thead className="text-[10px] text-muted">
          <tr>
            <th className="px-3 py-1.5">#</th>
            <th className="px-3 py-1.5">Algo</th>
            <th className="px-3 py-1.5 text-right">Return</th>
            <th className="px-3 py-1.5 text-right">vs B&amp;H</th>
            <th className="px-3 py-1.5 text-right">Trades</th>
            <th className="px-3 py-1.5 text-right">Win%</th>
            <th className="px-3 py-1.5 text-right">Max DD</th>
            <th className="px-3 py-1.5 text-right">Fees</th>
            <th className="px-3 py-1.5 text-right"></th>
          </tr>
        </thead>
        <tbody>
          {board.map((r, i) => {
            const beat = r.totalReturnPct > r.buyHoldReturnPct;
            return (
              <tr key={r.id} className={`border-t border-line ${i === 0 ? "bg-accent/5" : ""}`}>
                <td className="px-3 py-1.5 text-muted">{i === 0 ? "🏆" : i + 1}</td>
                <td className="px-3 py-1.5 text-text">{r.name}</td>
                <td className={`px-3 py-1.5 text-right font-semibold ${r.totalReturnPct >= 0 ? "text-up" : "text-down"}`}>
                  {r.totalReturnPct >= 0 ? "+" : ""}{r.totalReturnPct.toFixed(2)}%
                </td>
                <td className={`px-3 py-1.5 text-right ${beat ? "text-up" : "text-muted"}`}>{beat ? "beats" : "under"}</td>
                <td className="px-3 py-1.5 text-right text-text">{r.numTrades}</td>
                <td className="px-3 py-1.5 text-right text-text">{r.winRate.toFixed(0)}%</td>
                <td className="px-3 py-1.5 text-right text-down">-{r.maxDrawdownPct.toFixed(1)}%</td>
                <td className="px-3 py-1.5 text-right text-muted">${fmt(r.totalFeesPaid)}</td>
                <td className="px-3 py-1.5 text-right">
                  <button onClick={() => onUseStrategy(r.id)} className="rounded bg-panel2 px-2 py-0.5 text-[10px] text-text hover:bg-hover">Use</button>
                </td>
              </tr>
            );
          })}
          {board.length === 0 && !err && <tr><td colSpan={9} className="px-3 py-4 text-center text-muted">Running all strategies…</td></tr>}
        </tbody>
      </table>
      <p className="px-3 py-2 text-[10px] text-muted">
        Paper simulation on real market data with actual Binance taker fees (0.1%, no TDS). Updates every 8s as new candles form.
        Past performance ≠ future results. Click <span className="text-text">Use</span> to load an algo into the bot.
      </p>
    </div>
  );
}
