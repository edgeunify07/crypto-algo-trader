"use client";

import { useCallback, useEffect, useState } from "react";
import type { CandleInterval, Ticker } from "@/lib/types";
import { useStreamTarget, useMarketSub, type WsTicker } from "@/lib/useMarketStream";
import ChartPanel from "@/components/ChartPanel";
import OrderBook from "@/components/OrderBook";
import TradesFeed from "@/components/TradesFeed";
import MarketList from "@/components/MarketList";
import TradePanel, { type StrategyMeta } from "@/components/TradePanel";
import BottomTabs from "@/components/BottomTabs";

const fmt = (n: number, d = 2) => new Intl.NumberFormat("en-US", { minimumFractionDigits: d, maximumFractionDigits: d }).format(n);

interface FullStatus {
  running: boolean;
  positions: { symbol: string; qty: number; entryPrice: number }[];
  events: { time: number; symbol: string; action: string; price: number; pnl?: number; reason?: string; mode: string; live: boolean }[];
  risk: { killSwitch: boolean; realizedPnlToday: number; limits: { maxOrderNotionalUSDT: number; maxDailyLossUSDT: number; maxOpenPositions: number } };
  server?: { env: string; live: boolean; hasKeys: boolean; tradingEnabled: boolean };
}

export default function Terminal() {
  const [symbol, setSymbol] = useState("BTCUSDT");
  const [interval, setInterval] = useState<CandleInterval>("15m");
  const [ticker, setTicker] = useState<Ticker | null>(null);
  const [strategies, setStrategies] = useState<StrategyMeta[]>([]);
  const [strategyId, setStrategyId] = useState("");
  const [params, setParams] = useState<Record<string, number>>({});
  const [mode, setMode] = useState<"paper" | "live">("paper");
  const [tradeNotional, setTradeNotional] = useState(25);
  const [status, setStatus] = useState<FullStatus | null>(null);

  useEffect(() => {
    fetch("/api/backtest").then((r) => r.json()).then((j) => {
      setStrategies(j.strategies ?? []);
      if (j.strategies?.[0]) { setStrategyId(j.strategies[0].id); setParams(j.strategies[0].params); }
    }).catch(() => {});
  }, []);

  // Point the shared WebSocket at the selected market.
  useStreamTarget(symbol, interval);

  // Live ticker for the header, pushed over WebSocket.
  useMarketSub<WsTicker>("ticker", (d) => {
    setTicker({
      market: symbol,
      lastPrice: Number(d.c),
      bid: Number(d.b ?? d.c),
      ask: Number(d.a ?? d.c),
      high24h: Number(d.h),
      low24h: Number(d.l),
      volume: Number(d.v),
      change24h: Number(d.P),
      timestamp: Date.now(),
    });
  });

  // Reset the header when the symbol changes until the first WS tick arrives.
  useEffect(() => { setTicker(null); }, [symbol]);

  const refreshStatus = useCallback(async () => {
    try {
      const r = await fetch("/api/bot");
      const j = await r.json();
      setStatus(j);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    refreshStatus();
    const id = window.setInterval(refreshStatus, 2500);
    return () => window.clearInterval(id);
  }, [refreshStatus]);

  const up = (ticker?.change24h ?? 0) >= 0;
  const armed = status?.server?.live;

  return (
    <div className="flex h-screen flex-col bg-bg text-text">
      {/* TOP BAR */}
      <header className="flex flex-wrap items-center gap-x-6 gap-y-1 border-b border-line px-4 py-2">
        <div className="flex items-center gap-2">
          <span className="text-base font-bold text-accent">◆ UNIFY</span>
          <span className="text-sm font-semibold text-text">{symbol.replace("USDT", "")}<span className="text-muted">/USDT</span></span>
        </div>
        <div className="nums flex items-baseline gap-1">
          <span className={`text-lg font-semibold ${up ? "text-up" : "text-down"}`}>{ticker ? fmt(ticker.lastPrice) : "—"}</span>
        </div>
        <Stat label="24h Change" value={ticker ? `${up ? "+" : ""}${ticker.change24h.toFixed(2)}%` : "—"} cls={up ? "text-up" : "text-down"} />
        <Stat label="24h High" value={ticker ? fmt(ticker.high24h) : "—"} />
        <Stat label="24h Low" value={ticker ? fmt(ticker.low24h) : "—"} />
        <Stat label="24h Volume" value={ticker ? `${fmt(ticker.volume, 0)}` : "—"} />
        <div className="ml-auto flex items-center gap-3 text-xs">
          {status?.running && <span className="flex items-center gap-1 text-up"><span className="h-1.5 w-1.5 animate-pulse rounded-full bg-up" />BOT RUNNING</span>}
          <span className={`rounded px-2 py-0.5 ${armed ? "bg-down/20 text-down" : "bg-panel2 text-muted"}`}>
            {armed ? `LIVE · ${status?.server?.env}` : `SAFE · ${status?.server?.env ?? "testnet"}`}
          </span>
          <button
            onClick={async () => { await fetch("/api/auth/logout", { method: "POST" }); window.location.href = "/login"; }}
            className="rounded border border-line px-2 py-0.5 text-muted hover:text-text"
          >
            Logout
          </button>
        </div>
      </header>

      {/* MAIN GRID */}
      <div className="flex min-h-0 flex-1">
        <aside className="hidden w-56 shrink-0 border-r border-line bg-panel lg:block">
          <MarketList selected={symbol} onSelect={setSymbol} />
        </aside>

        <section className="flex min-w-0 flex-1 flex-col">
          <div className="min-h-0 flex-1 bg-panel">
            <ChartPanel symbol={symbol} interval={interval} onInterval={setInterval} />
          </div>
          <div className="h-[300px] shrink-0 border-t border-line bg-panel">
            <BottomTabs
              symbol={symbol}
              interval={interval}
              strategyId={strategyId}
              params={params}
              status={status}
              onUseStrategy={(id) => {
                setStrategyId(id);
                const s = strategies.find((x) => x.id === id);
                if (s) setParams(s.params);
              }}
            />
          </div>
        </section>

        <aside className="hidden w-64 shrink-0 border-l border-line bg-panel md:flex md:flex-col">
          <div className="min-h-0 flex-1 overflow-hidden border-b border-line">
            <OrderBook symbol={symbol} lastPrice={ticker?.lastPrice ?? 0} />
          </div>
          <div className="h-[40%] min-h-0">
            <TradesFeed symbol={symbol} />
          </div>
        </aside>

        <aside className="hidden w-72 shrink-0 border-l border-line bg-panel xl:block">
          <TradePanel
            symbol={symbol}
            interval={interval}
            strategies={strategies}
            strategyId={strategyId}
            onStrategy={setStrategyId}
            params={params}
            onParams={setParams}
            mode={mode}
            onMode={setMode}
            tradeNotional={tradeNotional}
            onTradeNotional={setTradeNotional}
            status={status}
            onChanged={refreshStatus}
          />
        </aside>
      </div>
    </div>
  );
}

function Stat({ label, value, cls }: { label: string; value: string; cls?: string }) {
  return (
    <div className="hidden flex-col sm:flex">
      <span className="text-[10px] text-muted">{label}</span>
      <span className={`nums text-xs ${cls ?? "text-text"}`}>{value}</span>
    </div>
  );
}
