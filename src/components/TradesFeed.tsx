"use client";

import { useEffect, useState } from "react";
import { useMarketSub, type WsTrade } from "@/lib/useMarketStream";
import { formatIstTime } from "@/lib/time/ist";

const fmt = (n: number, d = 2) => new Intl.NumberFormat("en-US", { minimumFractionDigits: d, maximumFractionDigits: d }).format(n);
const time = (ms: number) => formatIstTime(ms, true);

interface T { id: number; price: number; qty: number; time: number; isBuyerMaker: boolean }

export default function TradesFeed({ symbol }: { symbol: string }) {
  const [trades, setTrades] = useState<T[]>([]);

  // Seed with a REST snapshot so the panel is populated instantly, then let the
  // WebSocket stream take over for real-time updates.
  useEffect(() => {
    setTrades([]);
    let alive = true;
    fetch(`/api/trades?symbol=${symbol}&limit=40`)
      .then((r) => r.json())
      .then((j) => { if (alive && j.trades) setTrades(j.trades); })
      .catch(() => {});
    return () => { alive = false; };
  }, [symbol]);

  useMarketSub<WsTrade>("trade", (d) => {
    setTrades((prev) => [
      { id: d.t, price: Number(d.p), qty: Number(d.q), time: d.T, isBuyerMaker: d.m },
      ...prev,
    ].slice(0, 40));
  });

  return (
    <div className="flex h-full flex-col text-xs nums">
      <div className="px-3 py-2 text-[11px] font-medium text-muted">Market Trades</div>
      <div className="grid grid-cols-3 px-3 pb-1 text-[10px] text-muted">
        <span>Price</span>
        <span className="text-right">Amount</span>
        <span className="text-right">Time</span>
      </div>
      <div className="scroll-thin flex-1 overflow-auto">
        {trades.map((t) => (
          <div key={t.id} className="grid grid-cols-3 px-3 py-[3px] hover:bg-hover">
            <span className={t.isBuyerMaker ? "text-down" : "text-up"}>{fmt(t.price)}</span>
            <span className="text-right text-text">{fmt(t.qty, 5)}</span>
            <span className="text-right text-muted">{time(t.time)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
