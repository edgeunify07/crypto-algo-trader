"use client";

import { useState } from "react";
import { useMarketSub, type WsDepth } from "@/lib/useMarketStream";

const fmt = (n: number, d = 2) => new Intl.NumberFormat("en-US", { minimumFractionDigits: d, maximumFractionDigits: d }).format(n);

interface Level { price: number; qty: number; total: number }

function build(levels: [string, string][]): Level[] {
  let total = 0;
  return levels.map(([p, q]) => {
    total += Number(q);
    return { price: Number(p), qty: Number(q), total };
  });
}

export default function OrderBook({ symbol, lastPrice }: { symbol: string; lastPrice: number }) {
  const [bids, setBids] = useState<Level[]>([]);
  const [asks, setAsks] = useState<Level[]>([]);

  useMarketSub<WsDepth>("depth", (d) => {
    if (!d.bids || !d.asks) return;
    setBids(build(d.bids.slice(0, 12)));
    setAsks(build(d.asks.slice(0, 12)));
  });

  const maxTotal = Math.max(bids.at(-1)?.total ?? 1, asks.at(-1)?.total ?? 1, 1);
  const spread = (asks[0]?.price ?? 0) - (bids[0]?.price ?? 0);
  const spreadPct = bids[0]?.price ? (spread / bids[0].price) * 100 : 0;

  return (
    <div className="flex h-full flex-col text-xs nums">
      <div className="flex items-center justify-between px-3 py-2 text-[11px] font-medium text-muted">
        <span>Order Book</span>
        <span>{symbol.replace("USDT", "/USDT")}</span>
      </div>
      <div className="grid grid-cols-3 px-3 pb-1 text-[10px] text-muted">
        <span>Price</span>
        <span className="text-right">Amount</span>
        <span className="text-right">Total</span>
      </div>

      <div className="flex-1 overflow-hidden">
        <div className="flex flex-col-reverse">
          {asks.slice(0, 12).map((l) => (
            <Row key={`a${l.price}`} {...l} max={maxTotal} down />
          ))}
        </div>

        <div className="my-1 flex items-center justify-between border-y border-line px-3 py-1.5">
          <span className="text-sm font-semibold text-text">{fmt(lastPrice)}</span>
          <span className="text-[10px] text-muted">spread {fmt(spreadPct, 3)}%</span>
        </div>

        <div>
          {bids.slice(0, 12).map((l) => (
            <Row key={`b${l.price}`} {...l} max={maxTotal} />
          ))}
        </div>
      </div>
    </div>
  );
}

function Row({ price, qty, total, max, down }: Level & { max: number; down?: boolean }) {
  const pct = Math.min(100, (total / max) * 100);
  return (
    <div className="relative grid grid-cols-3 px-3 py-[3px] hover:bg-hover">
      <div className="absolute inset-y-0 right-0" style={{ width: `${pct}%`, background: down ? "rgba(246,70,93,0.12)" : "rgba(46,189,133,0.12)" }} />
      <span className={`relative ${down ? "text-down" : "text-up"}`}>{fmt(price)}</span>
      <span className="relative text-right text-text">{fmt(qty, 5)}</span>
      <span className="relative text-right text-muted">{fmt(total, 3)}</span>
    </div>
  );
}
