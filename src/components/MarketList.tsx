"use client";

import { useEffect, useMemo, useState } from "react";
import type { MarketRow } from "@/lib/binance/marketData";

const fmt = (n: number) => new Intl.NumberFormat("en-US", { maximumFractionDigits: n < 1 ? 6 : n < 100 ? 4 : 2 }).format(n);
const vol = (n: number) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : `${(n / 1e3).toFixed(0)}K`);

export default function MarketList({ selected, onSelect }: { selected: string; onSelect: (s: string) => void }) {
  const [rows, setRows] = useState<MarketRow[]>([]);
  const [q, setQ] = useState("");

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const r = await fetch(`/api/tickers?limit=50`);
        const j = await r.json();
        if (alive && j.markets) setRows(j.markets);
      } catch {
        /* retry */
      } finally {
        if (alive) timer = setTimeout(poll, 5000);
      }
    }
    poll();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, []);

  const filtered = useMemo(
    () => rows.filter((r) => r.symbol.toLowerCase().includes(q.toLowerCase())),
    [rows, q],
  );

  return (
    <div className="flex h-full flex-col">
      <div className="p-2">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search"
          className="w-full rounded bg-panel2 px-2 py-1.5 text-xs text-text outline-none placeholder:text-muted"
        />
      </div>
      <div className="grid grid-cols-[1.4fr_1fr_0.9fr] px-3 pb-1 text-[10px] text-muted">
        <span>Pair</span>
        <span className="text-right">Price</span>
        <span className="text-right">24h%</span>
      </div>
      <div className="scroll-thin flex-1 overflow-auto nums text-xs">
        {filtered.map((r) => {
          const up = r.change24h >= 0;
          const active = r.symbol === selected;
          return (
            <button
              key={r.symbol}
              onClick={() => onSelect(r.symbol)}
              className={`grid w-full grid-cols-[1.4fr_1fr_0.9fr] items-center px-3 py-[5px] text-left hover:bg-hover ${active ? "bg-hover" : ""}`}
            >
              <span className="truncate text-text">
                <span className="text-muted">{r.symbol.replace("USDT", "")}</span>
                <span className="text-[10px] text-muted">/USDT</span>
              </span>
              <span className="text-right text-text">{fmt(r.lastPrice)}</span>
              <span className={`text-right ${up ? "text-up" : "text-down"}`}>
                {up ? "+" : ""}{r.change24h.toFixed(2)}%
              </span>
            </button>
          );
        })}
        {filtered.length === 0 && <p className="px-3 py-4 text-center text-[11px] text-muted">Loading markets…</p>}
      </div>
    </div>
  );
}
