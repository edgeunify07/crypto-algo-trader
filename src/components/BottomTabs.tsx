"use client";

import { useEffect, useMemo, useState } from "react";
import type { CandleInterval } from "@/lib/types";
import type { BacktestResult } from "@/lib/backtest";
import AccountPanel from "./AccountPanel";
import ArenaPanel from "./ArenaPanel";
import AutoSelectPanel from "./AutoSelectPanel";
import { formatIstDateTime } from "@/lib/time/ist";

const fmt = (n: number, d = 2) => new Intl.NumberFormat("en-US", { minimumFractionDigits: d, maximumFractionDigits: d }).format(n);

function fmtMetric(n: number | null | undefined, d = 2): string {
  if (n == null) return "—";
  if (n === Infinity) return "∞";
  if (n === -Infinity || Number.isNaN(n)) return "—";
  return n.toFixed(d);
}

export interface ExecEventRow {
  time: number;
  symbol: string;
  action: string;
  price: number;
  qty?: number;
  notional?: number;
  pnl?: number;
  reason?: string;
  mode?: string;
  live: boolean;
  clientOrderId?: string;
}

export interface BotStatusFull {
  running?: boolean;
  positions: { symbol: string; qty: number; entryPrice: number; entryTime?: number }[];
  events: ExecEventRow[];
  risk: { realizedPnlToday: number; currentEquity?: number };
  lastSignal?: string | null;
  pendingSignal?: string | null;
  pendingReason?: string;
  lastEvent?: ExecEventRow | null;
  lastError?: string | null;
  ticks?: number;
  watchlist?: string[];
  bestCandidate?: { symbol: string; score: number; reason?: string } | null;
  config?: { symbol?: string; interval?: string; mode?: string; tradeNotionalUSDT?: number; strategyId?: string; universeMode?: boolean; symbols?: string[] } | null;
}

interface Props {
  symbol: string;
  interval: CandleInterval;
  strategyId: string;
  params: Record<string, number>;
  status: BotStatusFull | null;
  onUseStrategy: (id: string) => void;
  onChartMarkers?: (markers: { time: number; price: number; side: "buy" | "sell"; reason?: string }[]) => void;
}

type Tab = "autoselect" | "arena" | "account" | "positions" | "log" | "backtest" | "validation" | "optimize";

interface Provenance {
  source: string;
  symbol: string;
  interval: string;
  candleCount: number;
  coverageFrom: number | null;
  coverageTo: number | null;
  fromCache: boolean;
  updatedAt: string;
  gaps: number;
  warnings: string[];
  strategyId?: string;
}

interface ExtendedMetrics {
  sharpe: number;
  sortino: number;
  calmar: number;
  deflatedSharpe: number;
  cagr: number;
  alpha: number;
}

export default function BottomTabs(p: Props) {
  const [tab, setTab] = useState<Tab>("autoselect");
  const [result, setResult] = useState<BacktestResult | null>(null);
  const [provenance, setProvenance] = useState<Provenance | null>(null);
  const [metrics, setMetrics] = useState<ExtendedMetrics | null>(null);
  const [configHash, setConfigHash] = useState<string | null>(null);
  const [breakEven, setBreakEven] = useState<{ minEdgePct: number; viable: boolean } | null>(null);
  const [validation, setValidation] = useState<Record<string, unknown> | null>(null);
  const [optimize, setOptimize] = useState<Record<string, unknown> | null>(null);
  const [startEquity, setStartEquity] = useState<string>("100");
  const [scalpMeta, setScalpMeta] = useState<Record<string, unknown> | null>(null);
  const [universeRows, setUniverseRows] = useState<{ symbol: string; totalReturnPct: number; winRate: number; profitFactor: number | null; numTrades: number; maxDrawdownPct: number; expectancy: number; endEquity: number }[] | null>(null);
  const [bestSymbol, setBestSymbol] = useState<string | null>(null);
  const [universeMode, setUniverseMode] = useState(true);
  const [running, setRunning] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [journalEvents, setJournalEvents] = useState<ExecEventRow[]>([]);

  useEffect(() => {
    const loadJournal = () => {
      fetch("/api/journal?format=json&limit=200")
        .then((r) => r.json())
        .then((j) => setJournalEvents(j.events ?? []))
        .catch(() => {});
    };
    loadJournal();
    const id = window.setInterval(loadJournal, 3000);
    return () => window.clearInterval(id);
  }, []);

  const runBacktest = async () => {
    const equity = Number(startEquity);
    if (!equity || equity <= 0) {
      setErr("Enter your account size (USDT) before running a backtest");
      return;
    }
    setRunning(true);
    setErr(null);
    try {
      const r = await fetch("/api/backtest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          symbol: p.symbol,
          interval: p.interval,
          strategyId: p.strategyId,
          params: p.params,
          startEquity: equity,
          universeMode,
          universeLimit: 20,
        }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? "failed");
      setResult(j.result);
      setProvenance({ ...(j.provenance ?? {}), strategyId: p.strategyId } as Provenance);
      setMetrics(j.metrics ?? null);
      setConfigHash(j.configHash ?? null);
      setBreakEven(j.breakEven ?? null);
      setScalpMeta(j.scalpMeta ?? null);
      setUniverseRows(j.universe ?? null);
      setBestSymbol(j.bestSymbol ?? null);
      p.onChartMarkers?.(j.chartMarkers ?? []);
      setTab("backtest");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "failed");
    } finally {
      setRunning(false);
    }
  };

  const runValidation = async () => {
    setRunning(true);
    setErr(null);
    try {
      const r = await fetch("/api/validation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbol: p.symbol, interval: p.interval, strategyId: p.strategyId, params: p.params }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? "failed");
      setValidation(j.result);
      setTab("validation");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "failed");
    } finally {
      setRunning(false);
    }
  };

  const runOptimize = async () => {
    setRunning(true);
    setErr(null);
    try {
      const r = await fetch("/api/optimize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbol: p.symbol, interval: p.interval, strategyId: p.strategyId }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? "failed");
      setOptimize(j);
      setTab("optimize");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "failed");
    } finally {
      setRunning(false);
    }
  };

  const positions = p.status?.positions ?? [];
  const liveEvents = p.status?.events ?? [];

  const mergedEvents = useMemo(() => {
    const map = new Map<string, ExecEventRow>();
    for (const e of [...journalEvents, ...liveEvents]) {
      const key = `${e.time}-${e.symbol}-${e.action}-${e.clientOrderId ?? e.reason ?? ""}`;
      map.set(key, e);
    }
    return [...map.values()].sort((a, b) => b.time - a.time);
  }, [journalEvents, liveEvents]);

  const tabs: { id: Tab; label: string }[] = [
    { id: "autoselect", label: "Auto-Select" },
    { id: "arena", label: "Compare Algos" },
    { id: "account", label: "Account (real)" },
    { id: "positions", label: `Bot Positions${p.status?.running ? " · live" : positions.length ? ` (${positions.length})` : ""}` },
    { id: "log", label: `Execution Log${mergedEvents.length ? ` (${mergedEvents.length})` : ""}` },
    { id: "backtest", label: "Backtest" },
    { id: "validation", label: "Validation" },
    { id: "optimize", label: "Optimize" },
  ];

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 overflow-x-auto border-b border-line px-3">
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`shrink-0 border-b-2 py-2 text-xs ${tab === t.id ? "border-accent text-text" : "border-transparent text-muted hover:text-text"}`}
          >
            {t.label}
          </button>
        ))}
        <div className="ml-auto flex shrink-0 items-center gap-1 py-1">
          <label className="flex items-center gap-1 text-[10px] text-muted">
            <input type="checkbox" checked={universeMode} onChange={(e) => setUniverseMode(e.target.checked)} />
            All symbols
          </label>
          <label className="flex items-center gap-1 text-[10px] text-muted">
            Capital $
            <input
              type="number"
              value={startEquity}
              onChange={(e) => setStartEquity(e.target.value)}
              className="w-16 rounded bg-panel2 px-1 py-0.5 text-[10px] text-text outline-none nums"
              min={1}
            />
          </label>
          <button onClick={runBacktest} disabled={running} className="rounded bg-accent px-2 py-1 text-[10px] font-semibold text-black disabled:opacity-50">
            {running ? "…" : "Backtest"}
          </button>
          <button onClick={runValidation} disabled={running} className="rounded bg-panel2 px-2 py-1 text-[10px] text-text disabled:opacity-50">Validate</button>
          <button onClick={runOptimize} disabled={running} className="rounded bg-panel2 px-2 py-1 text-[10px] text-text disabled:opacity-50">Optimize</button>
          <a href="/api/journal" className="rounded bg-panel2 px-2 py-1 text-[10px] text-muted hover:text-text">CSV</a>
        </div>
      </div>
      {err && <div className="px-3 py-1 text-[11px] text-down">{err}</div>}

      <div className="scroll-thin flex-1 overflow-auto nums text-xs">
        {tab === "autoselect" && <AutoSelectPanel />}

        {tab === "arena" && <ArenaPanel symbol={p.symbol} interval={p.interval} onUseStrategy={p.onUseStrategy} />}
        {tab === "account" && <AccountPanel />}
        {tab === "positions" && (
          <BotPositionsView
            symbol={p.symbol}
            status={p.status}
            journalEvents={mergedEvents}
          />
        )}
        {tab === "log" && (
          mergedEvents.length ? (
            <div>
              <p className="border-b border-line px-3 py-1 text-[10px] text-muted">
                Spot long-only: <span className="text-up">BUY</span> = open long · <span className="text-down">SELL</span> = close long (not short selling). Persisted to .data/executions.json
              </p>
              <Table head={["Time", "Order", "Side", "Symbol", "Price", "Qty", "P&L", "Reason", "Mode"]}>
                {mergedEvents.map((e, i) => (
                  <tr key={i} className="border-t border-line">
                    <Td>{formatIstDateTime(e.time)}</Td>
                    <Td cls={
                      e.action === "BUY" ? "text-up"
                        : e.action === "SELL" ? "text-down"
                          : e.action === "BOT" ? "text-accent"
                            : e.action === "SIGNAL" ? "text-muted"
                              : "text-muted"
                    }>
                      {e.action}{e.live ? " ·live" : ""}
                    </Td>
                    <Td cls={e.action === "SELL" ? "text-muted" : e.action === "BUY" ? "text-up" : "text-muted"}>
                      {e.action === "BUY" ? "LONG open" : e.action === "SELL" ? "LONG close" : e.action === "BOT" ? "system" : e.action === "SIGNAL" ? "signal" : "—"}
                    </Td>
                    <Td>{e.symbol}</Td>
                    <Td right>{e.price ? `$${fmt(e.price)}` : "—"}</Td>
                    <Td right>{e.qty ? fmt(e.qty, 5) : "—"}</Td>
                    <Td right cls={(e.pnl ?? 0) >= 0 ? "text-up" : "text-down"}>{e.pnl != null ? `$${fmt(e.pnl)}` : "—"}</Td>
                    <Td>{e.reason ?? "—"}</Td>
                    <Td>{e.mode ?? "—"}</Td>
                  </tr>
                ))}
              </Table>
            </div>
          ) : (
            <Empty text={p.status?.running
              ? "Bot is running — waiting for first BUY/SELL fill. Signals fire on bar close; orders fill next bar open."
              : "No executions yet. Start the bot (Paper) or run a backtest."} />
          )
        )}
        {tab === "backtest" && (result ? (
          <BacktestView
            r={result}
            provenance={provenance}
            metrics={metrics}
            configHash={configHash}
            breakEven={breakEven}
            scalpMeta={scalpMeta}
            universe={universeRows}
            bestSymbol={bestSymbol}
          />
        ) : <Empty text="Enter capital ($) and run a backtest. Enable “All symbols” to rank the universe." />)}
        {tab === "validation" && (validation ? <ValidationView data={validation} /> : <Empty text="Run validation for IS/OOS, walk-forward, Monte Carlo." />)}
        {tab === "optimize" && (optimize ? <OptimizeView data={optimize} /> : <Empty text="Run optimize for parameter sweep with deflated Sharpe." />)}
      </div>
    </div>
  );
}

function BotPositionsView({
  symbol,
  status,
  journalEvents,
}: {
  symbol: string;
  status: BotStatusFull | null;
  journalEvents: ExecEventRow[];
}) {
  const cfg = status?.config;
  const activeSymbol = (cfg?.symbol ?? symbol).toUpperCase();
  const openPos = status?.positions.find((p) => p.symbol.toUpperCase() === activeSymbol);
  const recentFills = journalEvents.filter(
    (e) => e.symbol.toUpperCase() === activeSymbol && (e.action === "BUY" || e.action === "SELL"),
  ).slice(0, 5);
  const lastBotEvent = journalEvents.find((e) => e.action === "BOT" && e.symbol.toUpperCase() === activeSymbol);

  const statusCells = [
    ["Bot", status?.running ? "RUNNING" : "STOPPED", status?.running ? "text-up" : "text-muted"],
    ["Symbol", activeSymbol, ""],
    ["Strategy", cfg?.strategyId ?? "—", ""],
    ["Interval", cfg?.interval ?? "—", ""],
    ["Mode", cfg?.mode ?? "—", ""],
    ["Universe", cfg?.universeMode ? `${status?.watchlist?.length ?? "…"} pairs` : "single", ""],
    ["Best pick", status?.bestCandidate ? `${status.bestCandidate.symbol} (${status.bestCandidate.score.toFixed(1)})` : "—", "text-accent"],
    ["Order size", cfg?.tradeNotionalUSDT ? `$${cfg.tradeNotionalUSDT}` : "—", ""],
    ["Last signal", status?.lastSignal ?? "—", status?.lastSignal === "buy" ? "text-up" : status?.lastSignal === "sell" ? "text-down" : ""],
    ["Pending", status?.pendingSignal && status.pendingSignal !== "hold" ? status.pendingSignal : "none", status?.pendingSignal === "buy" ? "text-accent" : ""],
    ["Ticks", status?.ticks != null ? String(status.ticks) : "—", ""],
    ["P&L today", `$${fmt(status?.risk.realizedPnlToday ?? 0)}`, (status?.risk.realizedPnlToday ?? 0) >= 0 ? "text-up" : "text-down"],
  ] as const;

  return (
    <div>
      <div className="grid grid-cols-2 gap-px border-b border-line bg-line sm:grid-cols-5">
        {statusCells.map(([label, val, cls]) => (
          <div key={label} className="bg-panel px-2 py-1.5">
            <div className="text-[9px] text-muted">{label}</div>
            <div className={`text-xs font-semibold ${cls}`}>{val}</div>
          </div>
        ))}
      </div>

      {status?.pendingSignal && status.pendingSignal !== "hold" && (
        <div className="border-b border-line bg-panel2 px-3 py-1.5 text-[10px] text-accent">
          Pending {status.pendingSignal.toUpperCase()} queued — fills at next bar open
          {status.pendingReason ? ` · ${status.pendingReason}` : ""}
        </div>
      )}

      {status?.lastError && (
        <div className="border-b border-line px-3 py-1 text-[10px] text-down">{status.lastError}</div>
      )}

      {!status?.running && lastBotEvent && (
        <div className="border-b border-line px-3 py-1 text-[10px] text-muted">
          Last session: {lastBotEvent.reason ?? "—"}
        </div>
      )}

      {status?.watchlist && status.watchlist.length > 1 && (
        <div className="border-b border-line px-3 py-1 text-[10px] text-muted">
          Scanning: {status.watchlist.join(" · ")}
        </div>
      )}

      <p className="border-b border-line px-3 py-1 text-[10px] text-muted">
        Paper bot holds <span className="text-text">cash (FLAT)</span> or <span className="text-up">BTC (LONG)</span> — a row appears below for the active symbol even when flat.
      </p>

      <Table head={["Symbol", "Status", "Side", "Qty", "Entry $", "Notional", "Notes"]}>
        <tr className="border-t border-line">
          <Td>{activeSymbol}</Td>
          <Td cls={openPos ? "text-up" : "text-muted"}>{openPos ? "OPEN" : "FLAT"}</Td>
          <Td cls={openPos ? "text-up" : "text-muted"}>{openPos ? "LONG" : "—"}</Td>
          <Td right>{openPos ? fmt(openPos.qty, 5) : "0"}</Td>
          <Td right>{openPos ? `$${fmt(openPos.entryPrice)}` : "—"}</Td>
          <Td right>{openPos ? `$${fmt(openPos.qty * openPos.entryPrice)}` : "—"}</Td>
          <Td>
            {openPos
              ? "Holding — SELL closes on exit signal"
              : status?.running
                ? `Waiting for BUY · last: ${status.lastSignal ?? "—"}`
                : "Start bot to trade"}
          </Td>
        </tr>
        {status?.positions
          .filter((p) => p.symbol.toUpperCase() !== activeSymbol)
          .map((pos) => (
            <tr key={pos.symbol} className="border-t border-line">
              <Td>{pos.symbol}</Td>
              <Td cls="text-up">OPEN</Td>
              <Td cls="text-up">LONG</Td>
              <Td right>{fmt(pos.qty, 5)}</Td>
              <Td right>${fmt(pos.entryPrice)}</Td>
              <Td right>${fmt(pos.qty * pos.entryPrice)}</Td>
              <Td>Other symbol</Td>
            </tr>
          ))}
      </Table>

      {recentFills.length > 0 && (
        <div className="border-t border-line">
          <div className="px-3 py-1 text-[10px] font-medium text-muted">Recent fills ({activeSymbol})</div>
          <Table head={["Time", "Order", "Price", "Qty", "P&L", "Reason"]}>
            {recentFills.map((e, i) => (
              <tr key={i} className="border-t border-line">
                <Td>{formatIstDateTime(e.time)}</Td>
                <Td cls={e.action === "BUY" ? "text-up" : "text-down"}>{e.action}</Td>
                <Td right>${fmt(e.price)}</Td>
                <Td right>{e.qty ? fmt(e.qty, 5) : "—"}</Td>
                <Td right cls={(e.pnl ?? 0) >= 0 ? "text-up" : "text-down"}>{e.pnl != null ? `$${fmt(e.pnl)}` : "—"}</Td>
                <Td>{e.reason ?? "—"}</Td>
              </tr>
            ))}
          </Table>
        </div>
      )}

      {!openPos && status?.running && status.lastSignal === "hold" && (
        <p className="px-3 py-3 text-center text-[11px] text-muted">
          Strategy says <span className="text-text">hold</span> — no BUY yet. On {cfg?.interval ?? "your interval"}, check back after the next bar closes.
        </p>
      )}
    </div>
  );
}

function BacktestView({ r, provenance, metrics, configHash, breakEven, scalpMeta, universe, bestSymbol }: {
  r: BacktestResult; provenance: Provenance | null; metrics: ExtendedMetrics | null;
  configHash: string | null; breakEven: { minEdgePct: number; viable: boolean; feeBudgetPct?: number } | null;
  scalpMeta: Record<string, unknown> | null;
  universe?: { symbol: string; totalReturnPct: number; winRate: number; profitFactor: number | null; numTrades: number; maxDrawdownPct: number; expectancy: number; endEquity: number }[] | null;
  bestSymbol?: string | null;
}) {
  const pf = r.profitFactor === Infinity ? "∞" : r.profitFactor.toFixed(2);
  const cells = [
    ["Net Return", `${r.totalReturnPct.toFixed(2)}%`, r.totalReturnPct >= 0 ? "text-up" : "text-down"],
    ["Buy & Hold", `${r.buyHoldReturnPct.toFixed(2)}%`, ""],
    ["Sharpe", metrics ? metrics.sharpe.toFixed(2) : "—", metrics && metrics.sharpe >= 1 ? "text-up" : ""],
    ["P(skill)", metrics ? `${(metrics.deflatedSharpe * 100).toFixed(0)}%` : "—", metrics && metrics.deflatedSharpe >= 0.95 ? "text-up" : "text-down"],
    ["Max DD", `-${r.maxDrawdownPct.toFixed(2)}%`, "text-down"],
    ["Trades", `${r.numTrades}`, ""],
    ["Win Rate", `${r.winRate.toFixed(1)}%`, ""],
    ["Profit Factor", pf, r.profitFactor >= 1.5 ? "text-up" : ""],
    ["Expectancy", `$${fmt(r.expectancy)}`, r.expectancy >= 0 ? "text-up" : "text-down"],
    ["Fees", `$${fmt(r.totalFeesPaid)}`, "text-muted"],
    ["End Equity", `$${fmt(r.endEquity)}`, ""],
  ] as const;

  return (
    <div>
      {provenance && (
        <div className="border-b border-line bg-panel px-3 py-2 text-[10px] text-muted">
          <span className="font-semibold text-text">Strategy:</span> {provenance.strategyId ?? r.strategyId}
          {" · "}
          <span className="font-semibold text-text">Data:</span> {provenance.source} · {provenance.symbol} · {provenance.interval} · {provenance.candleCount} bars
          {configHash && <span> · config #{configHash}</span>}
          {breakEven && (
            <span className={breakEven.viable ? " text-up" : " text-down"}>
              {" "}· break-even edge ≥{breakEven.minEdgePct.toFixed(2)}%/trade
            </span>
          )}
          <div className="mt-0.5 text-[9px] text-muted">
            Candles from Binance spot mainnet (historical). Dates are bar open times — e.g. 1000×15m ≈ last ~10 days.
          </div>
        </div>
      )}
      <div className="grid grid-cols-3 gap-px bg-line sm:grid-cols-4 lg:grid-cols-11">
        {cells.map(([label, val, cls]) => (
          <div key={label} className="bg-panel px-2 py-1.5">
            <div className="text-[9px] text-muted">{label}</div>
            <div className={`text-xs font-semibold ${cls}`}>{val}</div>
          </div>
        ))}
      </div>
      {scalpMeta && (
        <div className="border-b border-line bg-panel2 px-3 py-1 text-[10px] text-muted">
          Scalp: maker fills {(Number(scalpMeta.makerFillRatio) * 100).toFixed(0)}% · abandoned {String(scalpMeta.abandonedEntries)} · max-hold exits {String(scalpMeta.maxHoldExits)}
          {scalpMeta.klineOnly ? " · ⚠ kline-only (promotion blocked)" : " · aggTrade replay"}
          {scalpMeta.widenedForCost ? (
            <span className="text-down"> · ⚠ take-profit widened to the 0.45% cost floor (your target could not pay fees+slippage)</span>
          ) : null}
          <div className="mt-0.5 text-[9px] text-down">
            ⚠ This models maker-limit entries with fixed brackets — NOT what the live bot executes (live uses ATR stops).
            Do not read these numbers as live results.
          </div>
        </div>
      )}
      {universe && universe.length > 1 && (
        <div className="border-b border-line">
          <div className="px-3 py-1 text-[10px] font-medium text-muted">
            Universe ranking {bestSymbol ? `· best: ${bestSymbol}` : ""} (by win rate)
          </div>
          <Table head={["Rank", "Symbol", "Return", "Win %", "PF", "Trades", "Max DD", "Expectancy"]}>
            {universe.map((u, i) => (
              <tr key={u.symbol} className={`border-t border-line ${u.symbol === bestSymbol ? "bg-panel2" : ""}`}>
                <Td>{i + 1}</Td>
                <Td cls={u.symbol === bestSymbol ? "text-accent" : ""}>{u.symbol}</Td>
                <Td right cls={u.totalReturnPct >= 0 ? "text-up" : "text-down"}>{u.totalReturnPct.toFixed(2)}%</Td>
                <Td right>{u.winRate.toFixed(1)}%</Td>
                <Td right>{fmtMetric(u.profitFactor)}</Td>
                <Td right>{u.numTrades}</Td>
                <Td right cls="text-down">{u.maxDrawdownPct.toFixed(2)}%</Td>
                <Td right>${fmt(u.expectancy)}</Td>
              </tr>
            ))}
          </Table>
        </div>
      )}
      <p className="border-b border-line px-3 py-1 text-[10px] text-muted">
        Spot <strong className="font-normal text-text">long-only</strong> — each row is one round-trip:{" "}
        <span className="text-up">BUY</span> opens at Entry time/price,{" "}
        <span className="text-down">SELL</span> closes at Exit time/price (not two exits; two timestamps for one trade).
        {" "}Detail table = chart symbol {provenance?.symbol ?? ""}.
      </p>
      <Table head={["Entry time", "Exit time", "Order", "Entry $", "Exit $", "Why BUY", "Why SELL", "P&L"]}>
        {r.trades.map((t, i) => (
          <tr key={i} className="border-t border-line">
            <Td>{formatIstDateTime(t.entryTime)}</Td>
            <Td>{formatIstDateTime(t.exitTime)}</Td>
            <Td cls="text-up">LONG</Td>
            <Td right>${fmt(t.entryPrice)}</Td>
            <Td right>${fmt(t.exitPrice)}</Td>
            <Td>{t.entryReason ?? "signal"}</Td>
            <Td>{t.exitReason ?? "signal"}</Td>
            <Td right cls={t.pnl >= 0 ? "text-up" : "text-down"}>${fmt(t.pnl)}</Td>
          </tr>
        ))}
      </Table>
    </div>
  );
}

function ValidationView({ data }: { data: Record<string, unknown> }) {
  const is = data.inSample as { totalReturnPct: number; metrics: { sharpe: number } };
  const oos = data.outOfSample as { totalReturnPct: number; metrics: { sharpe: number } };
  const wf = data.walkForward as { windows: number; oosReturnPct: number; oosSharpe: number };
  const mc = data.monteCarlo as { runs: number; medianMaxDd: number; p95MaxDd: number };
  return (
    <div className="space-y-3 p-3">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Metric label="IS Return" value={`${is.totalReturnPct.toFixed(2)}%`} />
        <Metric label="OOS Return" value={`${oos.totalReturnPct.toFixed(2)}%`} />
        <Metric label="OOS Sharpe" value={oos.metrics.sharpe.toFixed(2)} />
        <Metric label="P(skill) after N trials" value={`${((data.deflatedSharpe as number) * 100).toFixed(0)}%`} />
        <Metric label="Walk-forward windows" value={String(wf.windows)} />
        <Metric label="WF OOS Return" value={`${wf.oosReturnPct.toFixed(2)}%`} />
        <Metric label="MC median max DD" value={`${mc.medianMaxDd.toFixed(1)}%`} />
        <Metric label="MC p95 max DD" value={`${mc.p95MaxDd.toFixed(1)}%`} />
        <Metric label="PBO" value={`${((data.pbo as number) * 100).toFixed(0)}%`} />
      </div>
      <p className="text-[10px] text-muted">Live Sharpe typically lands 30–50% below backtest. Poor OOS results are a successful engineering outcome.</p>
    </div>
  );
}

function OptimizeView({ data }: { data: Record<string, unknown> }) {
  const top = (data.top as { params: Record<string, number>; deflatedSharpe: number; totalReturnPct: number; profitFactor: number | null }[]) ?? [];
  return (
    <div className="p-3">
      <p className="mb-2 text-[10px] text-muted">
        {data.trials as number} trials · pick robustness plateaus, not isolated peaks ·
        P(skill) is discounted for having tried {data.trials as number} configs — below 95% the winner is not
        distinguishable from luck
      </p>
      <Table head={["Params", "Return", "P(skill)", "PF"]}>
        {top.map((row, i) => (
          <tr key={i} className="border-t border-line">
            <Td>{JSON.stringify(row.params)}</Td>
            <Td right>{fmtMetric(row.totalReturnPct)}%</Td>
            <Td right>{row.deflatedSharpe == null ? "—" : `${(row.deflatedSharpe * 100).toFixed(0)}%`}</Td>
            <Td right>{fmtMetric(row.profitFactor)}</Td>
          </tr>
        ))}
      </Table>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded bg-panel2 px-2 py-1.5">
      <div className="text-[9px] text-muted">{label}</div>
      <div className="text-sm font-semibold">{value}</div>
    </div>
  );
}

function Table({ head, children }: { head: string[]; children: React.ReactNode }) {
  return (
    <table className="w-full text-left">
      <thead className="sticky top-0 bg-panel text-[10px] text-muted">
        <tr>{head.map((h, i) => <th key={h} className={`px-3 py-1.5 ${i > 0 ? "text-right" : ""}`}>{h}</th>)}</tr>
      </thead>
      <tbody>{children}</tbody>
    </table>
  );
}
function Td({ children, right, cls }: { children: React.ReactNode; right?: boolean; cls?: string }) {
  return <td className={`px-3 py-1 ${right ? "text-right" : ""} ${cls ?? "text-text"}`}>{children}</td>;
}
function Empty({ text }: { text: string }) {
  return <p className="px-3 py-6 text-center text-[11px] text-muted">{text}</p>;
}
