"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Chart from "./Chart";

/**
 * Automated futures trading dashboard.
 *
 * There is no start/stop control by design. On serverless there is no process
 * to start — the loop advances one step per request to `/api/v2/tick`, driven
 * by this page while it is open and by an external scheduler when it is not.
 * A "Start Bot" button would imply a background process that cannot exist.
 */

type Direction = "long" | "short" | "flat";

interface TfRead {
  score: number;
  confidence: number;
  direction: string;
  regime: string;
  elliott: { pattern: string; wave: string; bias: string; confidence: number };
  gann: { bias: string; confidence: number; barsSinceAnchor: number; nearestCycle: number };
}

interface ScreenerRow {
  symbol: string;
  markPrice: number;
  score: number;
  confidence: number;
  alignment: number;
  direction: Direction;
  anchorTimeframe: string;
  style: string;
  quoteVolume24h: number;
  fundingRate: number;
  hasPosition: boolean;
  gates: { name: string; required: number | string; actual: number | string; passed: boolean }[];
  blockedBy: string | null;
  timeframes: Record<string, TfRead>;
}

interface Position {
  id: string;
  symbol: string;
  side: "long" | "short";
  quantity: number;
  entryPrice: number;
  markPrice: number;
  margin: number;
  leverage: number;
  stopLoss: number;
  liquidationPrice: number;
  unrealised: number;
  unrealisedPct: number;
  distanceToLiquidation: number;
  notional: number;
  style: string;
  timeframe: string;
  fundingPaid: number;
  openedAt: number;
  reasons: string[];
}

interface Trade {
  id: string;
  symbol: string;
  side: "long" | "short";
  style: string;
  timeframe: string;
  entryPrice: number;
  exitPrice: number;
  grossPnl: number;
  entryFee: number;
  exitFee: number;
  fundingCost: number;
  netPnl: number;
  netPnlPct: number;
  rMultiple: number;
  exitReason: string;
  closedAt: number;
}

interface State {
  durable: boolean;
  account: {
    balance: number;
    startingBalance: number;
    equity: number;
    unrealised: number;
    realisedPnl: number;
    totalFees: number;
    totalFunding: number;
    drawdown: number;
    returnPct: number;
    leverage: number;
    tickCount: number;
    lastTickAt: number;
    haltedReason: string | null;
  };
  positions: Position[];
  stats: {
    trades: number;
    wins: number;
    losses: number;
    winRate: number;
    netPnl: number;
    grossPnl: number;
    fees: number;
    funding: number;
  };
  params: { version: string; source: string };
}

const TF_ORDER = ["5m", "15m", "1h", "4h", "1d"];
const TICK_MS = 20_000;

const money = (n: number, d = 2) =>
  `${n < 0 ? "-" : ""}$${Math.abs(n).toFixed(d)}`;
const signed = (n: number, d = 2) => `${n >= 0 ? "+" : "-"}$${Math.abs(n).toFixed(d)}`;
const pct = (n: number, d = 1) => `${(n * 100).toFixed(d)}%`;
const tone = (n: number) =>
  n > 0 ? "text-[var(--up)]" : n < 0 ? "text-[var(--down)]" : "text-[var(--muted)]";

function timeAgo(t: number, now: number): string {
  if (!t || !now) return "never";
  const s = Math.max(0, Math.floor((now - t) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

function fmtPrice(n: number): string {
  if (!Number.isFinite(n) || n === 0) return "—";
  if (n >= 1000) return n.toFixed(2);
  if (n >= 1) return n.toFixed(4);
  return n.toFixed(6);
}

export default function Home() {
  const [state, setState] = useState<State | null>(null);
  const [rows, setRows] = useState<ScreenerRow[]>([]);
  const [trades, setTrades] = useState<Trade[]>([]);
  const [tab, setTab] = useState<"live" | "scan" | "chart" | "history">("live");
  const [chartSymbol, setChartSymbol] = useState<string>("BTCUSDT");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [ticking, setTicking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastTick, setLastTick] = useState<number>(0);
  // Clock held in state rather than read during render: calling Date.now()
  // while rendering is impure and makes the server and client disagree on
  // first paint.
  const [now, setNow] = useState<number>(0);
  const inFlight = useRef(false);

  const refresh = useCallback(async () => {
    try {
      const [s, sc, tr] = await Promise.all([
        fetch("/api/v2/state", { cache: "no-store" }).then((r) => r.json()),
        fetch("/api/v2/screener", { cache: "no-store" }).then((r) => r.json()),
        fetch("/api/v2/trades?limit=50", { cache: "no-store" }).then((r) => r.json()),
      ]);
      if (s?.account) setState(s);
      if (Array.isArray(sc?.rows)) setRows(sc.rows);
      if (Array.isArray(tr?.trades)) setTrades(tr.trades);
      setError(null);
    } catch {
      setError("Cannot reach the server");
    }
  }, []);

  /** Drive the loop. Guarded so a slow tick never overlaps itself. */
  const tick = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setTicking(true);
    try {
      const res = await fetch("/api/v2/tick", { method: "POST", cache: "no-store" });
      const body = await res.json();
      if (body?.error) setError(body.error);
      else if (body?.ok || body?.skipped) {
        setLastTick(Date.now());
        setError(null);
      }
      await refresh();
    } catch {
      setError("Tick failed");
    } finally {
      inFlight.current = false;
      setTicking(false);
    }
  }, [refresh]);

  useEffect(() => {
    // Deferred by a timer rather than called inline: an inline call updates
    // state during the effect's synchronous phase, and in StrictMode it would
    // also fire two ticks on mount.
    const kick = setTimeout(() => {
      setNow(Date.now());
      void refresh();
      void tick();
    }, 0);
    const t = setInterval(() => void tick(), TICK_MS);
    const r = setInterval(() => void refresh(), 7000);
    const clock = setInterval(() => setNow(Date.now()), 1000);
    // Catch up immediately when the app comes back to the foreground on iOS.
    const onVisible = () => {
      if (document.visibilityState === "visible") void tick();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearTimeout(kick);
      clearInterval(t);
      clearInterval(r);
      clearInterval(clock);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [tick, refresh]);

  const acct = state?.account;
  const equity = acct?.equity ?? 0;
  const totalPnl = equity - (acct?.startingBalance ?? 100);

  // "Running" means a tick completed recently. There is no process to be up or
  // down on serverless, so liveness is measured by whether the loop is
  // actually advancing — which is the thing that matters anyway.
  const lastTickAt = Math.max(lastTick, acct?.lastTickAt ?? 0);
  const sinceTick = now && lastTickAt ? now - lastTickAt : Infinity;
  const botState: "running" | "stale" | "down" =
    sinceTick < 90_000 ? "running" : sinceTick < 15 * 60_000 ? "stale" : "down";

  return (
    <main className="min-h-screen pb-24">
      {/* ---- Equity header ---- */}
      <header className="sticky top-0 z-20 bg-[var(--bg)]/95 backdrop-blur border-b border-[var(--line)] px-4 pt-3 pb-3">
        <div className="flex items-center justify-between mb-1">
          <div className="flex items-center gap-2">
            <span className="text-[11px] uppercase tracking-wider text-[var(--muted)]">
              Equity
            </span>
            <span
              className={`live-dot h-1.5 w-1.5 rounded-full ${
                ticking ? "bg-[var(--accent)]" : "bg-[var(--up)]"
              }`}
            />
          </div>
          <span className="flex items-center gap-1.5 text-[10px] text-[var(--muted)] tnum">
            <span
              className="rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide"
              style={{
                background:
                  botState === "running"
                    ? "rgba(34,201,139,.15)"
                    : botState === "stale"
                      ? "rgba(245,185,66,.15)"
                      : "rgba(255,85,112,.15)",
                color:
                  botState === "running"
                    ? "var(--up)"
                    : botState === "stale"
                      ? "var(--warn)"
                      : "var(--down)",
              }}
            >
              {botState === "running" ? "auto" : botState === "stale" ? "slow" : "idle"}
            </span>
            {acct?.leverage ?? 3}x · {acct?.tickCount ?? 0} ticks · {timeAgo(lastTickAt, now)}
          </span>
        </div>

        <div className="flex items-baseline gap-3">
          <span className="text-[34px] leading-none font-semibold tnum">
            {money(equity)}
          </span>
          <span className={`text-sm font-medium tnum ${tone(totalPnl)}`}>
            {signed(totalPnl)} ({pct(acct?.returnPct ?? 0, 2)})
          </span>
        </div>

        <div className="mt-2 grid grid-cols-4 gap-2 text-[10px]">
          <Stat label="Free" value={money(acct?.balance ?? 0)} />
          <Stat
            label="Unreal."
            value={signed(acct?.unrealised ?? 0)}
            cls={tone(acct?.unrealised ?? 0)}
          />
          <Stat label="Fees" value={money(acct?.totalFees ?? 0, 3)} cls="text-[var(--warn)]" />
          <Stat label="Draw" value={pct(acct?.drawdown ?? 0)} />
        </div>

        {state && !state.durable && (
          <Banner tone="warn">
            Storage is not configured — state resets. Add Upstash Redis env vars.
          </Banner>
        )}
        {acct?.haltedReason && (
          <Banner tone="down">Entries halted: {acct.haltedReason}</Banner>
        )}
        {error && <Banner tone="down">{error}</Banner>}
      </header>

      {/* ---- Tabs ---- */}
      <nav className="flex gap-1 px-4 py-3">
        {(["live", "scan", "chart", "history"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`flex-1 rounded-lg py-2 text-[11px] font-medium transition-colors ${
              tab === t
                ? "bg-[var(--surface-2)] text-[var(--text)]"
                : "text-[var(--muted)]"
            }`}
          >
            {t === "live"
              ? `Positions${state?.positions.length ? ` ${state.positions.length}` : ""}`
              : t === "scan"
                ? "Signals"
                : t === "chart"
                  ? "Chart"
                  : `Trades${state?.stats.trades ? ` ${state.stats.trades}` : ""}`}
          </button>
        ))}
      </nav>

      <div className="px-4 space-y-2">
        {tab === "live" && <LiveTab positions={state?.positions ?? []} />}
        {tab === "scan" && (
          <ScanTab
            rows={rows}
            expanded={expanded}
            setExpanded={setExpanded}
            onChart={(sym) => {
              setChartSymbol(sym);
              setTab("chart");
            }}
          />
        )}
        {tab === "chart" && (
          <>
            <div className="flex gap-1 overflow-x-auto no-bar pb-1">
              {(rows.length > 0 ? rows.map((r) => r.symbol) : ["BTCUSDT"]).map((sym) => (
                <button
                  key={sym}
                  onClick={() => setChartSymbol(sym)}
                  className={`shrink-0 rounded-lg px-2.5 py-1.5 text-[11px] font-medium ${
                    chartSymbol === sym
                      ? "bg-[var(--surface-2)] text-[var(--text)]"
                      : "bg-[var(--surface)] text-[var(--muted)]"
                  }`}
                >
                  {sym.replace("USDT", "")}
                </button>
              ))}
            </div>
            <Chart symbol={chartSymbol} />
          </>
        )}
        {tab === "history" && <HistoryTab trades={trades} stats={state?.stats} now={now} />}
      </div>

      <footer className="fixed bottom-0 inset-x-0 bg-[var(--bg)]/95 backdrop-blur border-t border-[var(--line)] px-4 py-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
        <div className="flex items-center justify-between text-[10px] text-[var(--muted)]">
          <span>Paper · USDⓈ-M perps · fees &amp; funding real</span>
          <span className="tnum">{state?.params.version ?? "—"}</span>
        </div>
      </footer>
    </main>
  );
}

function Stat({ label, value, cls }: { label: string; value: string; cls?: string }) {
  return (
    <div className="rounded-lg bg-[var(--surface)] px-2 py-1.5">
      <div className="text-[9px] uppercase tracking-wide text-[var(--muted)]">{label}</div>
      <div className={`tnum text-[12px] font-medium ${cls ?? ""}`}>{value}</div>
    </div>
  );
}

function Banner({ tone, children }: { tone: "warn" | "down"; children: React.ReactNode }) {
  const colour = tone === "warn" ? "var(--warn)" : "var(--down)";
  return (
    <div
      className="mt-2 rounded-lg px-2.5 py-1.5 text-[11px]"
      style={{ background: `${colour}1a`, color: colour }}
    >
      {children}
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-xl bg-[var(--surface)] py-10 text-center text-[12px] text-[var(--muted)]">
      {children}
    </div>
  );
}

function LiveTab({ positions }: { positions: Position[] }) {
  if (positions.length === 0) {
    return <Empty>No open positions — the engine is waiting for a qualified setup.</Empty>;
  }
  return (
    <>
      {positions.map((p) => {
        const long = p.side === "long";
        const liqNear = p.distanceToLiquidation < 0.1;
        return (
          <div key={p.id} className="rounded-xl bg-[var(--surface)] p-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="font-semibold text-[15px]">
                  {p.symbol.replace("USDT", "")}
                </span>
                <span
                  className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${
                    long
                      ? "bg-[var(--up)]/15 text-[var(--up)]"
                      : "bg-[var(--down)]/15 text-[var(--down)]"
                  }`}
                >
                  {p.side.toUpperCase()} {p.leverage}x
                </span>
                <span className="rounded bg-[var(--surface-2)] px-1.5 py-0.5 text-[10px] text-[var(--muted)]">
                  {p.style} · {p.timeframe}
                </span>
              </div>
              <div className="text-right">
                <div className={`tnum text-[15px] font-semibold ${tone(p.unrealised)}`}>
                  {signed(p.unrealised, 3)}
                </div>
                <div className={`tnum text-[10px] ${tone(p.unrealised)}`}>
                  {pct(p.unrealisedPct)} on margin
                </div>
              </div>
            </div>

            <div className="mt-2.5 grid grid-cols-4 gap-2 text-[10px]">
              <Cell label="Entry" value={fmtPrice(p.entryPrice)} />
              <Cell label="Mark" value={fmtPrice(p.markPrice)} />
              <Cell label="Stop" value={fmtPrice(p.stopLoss)} />
              <Cell
                label="Liq"
                value={fmtPrice(p.liquidationPrice)}
                cls={liqNear ? "text-[var(--down)]" : ""}
              />
            </div>

            <div className="mt-2 flex items-center justify-between text-[10px] text-[var(--muted)]">
              <span className="tnum">
                {p.quantity} · {money(p.notional)} notional · {money(p.margin)} margin
              </span>
              <span className={`tnum ${p.fundingPaid < 0 ? "text-[var(--warn)]" : ""}`}>
                funding {signed(p.fundingPaid, 4)}
              </span>
            </div>

            <details className="mt-2">
              <summary className="cursor-pointer list-none text-[10px] text-[var(--accent)]">
                Why this trade
              </summary>
              <ul className="mt-1.5 space-y-0.5">
                {p.reasons.map((r, i) => (
                  <li key={i} className="text-[10px] leading-relaxed text-[var(--muted)]">
                    · {r}
                  </li>
                ))}
              </ul>
            </details>
          </div>
        );
      })}
    </>
  );
}

function Cell({ label, value, cls }: { label: string; value: string; cls?: string }) {
  return (
    <div className="rounded-lg bg-[var(--surface-2)] px-2 py-1.5">
      <div className="text-[9px] uppercase tracking-wide text-[var(--muted)]">{label}</div>
      <div className={`tnum text-[11px] ${cls ?? ""}`}>{value}</div>
    </div>
  );
}

function ScanTab({
  rows,
  expanded,
  setExpanded,
  onChart,
}: {
  rows: ScreenerRow[];
  expanded: string | null;
  setExpanded: (s: string | null) => void;
  onChart: (symbol: string) => void;
}) {
  if (rows.length === 0) {
    return <Empty>Waiting for the first scan of today&apos;s top-10 by volume…</Empty>;
  }
  return (
    <>
      {rows.map((r) => {
        const open = expanded === r.symbol;
        return (
          <div key={r.symbol} className="rounded-xl bg-[var(--surface)] overflow-hidden">
            <button
              onClick={() => setExpanded(open ? null : r.symbol)}
              className="w-full px-3 py-2.5 text-left"
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="font-semibold text-[14px]">
                    {r.symbol.replace("USDT", "")}
                  </span>
                  {r.hasPosition && (
                    <span className="rounded bg-[var(--accent)]/15 px-1 py-0.5 text-[9px] text-[var(--accent)]">
                      OPEN
                    </span>
                  )}
                  <span className="text-[10px] text-[var(--muted)] tnum">
                    {fmtPrice(r.markPrice)}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <TfStrip timeframes={r.timeframes} />
                  <span
                    className={`tnum text-[13px] font-semibold w-11 text-right ${tone(r.score)}`}
                  >
                    {r.score >= 0 ? "+" : ""}
                    {r.score.toFixed(2)}
                  </span>
                </div>
              </div>
              <div className="mt-1 flex items-center gap-2 text-[9px] text-[var(--muted)]">
                <span>align {pct(r.alignment, 0)}</span>
                <span>·</span>
                <span>conf {pct(r.confidence, 0)}</span>
                <span>·</span>
                <span>{r.anchorTimeframe} {r.style}</span>
                <span>·</span>
                <span className={r.fundingRate > 0 ? "text-[var(--warn)]" : ""}>
                  fund {(r.fundingRate * 100).toFixed(4)}%
                </span>
              </div>
              <div className="mt-1 text-[9px]">
                {r.hasPosition ? (
                  <span className="text-[var(--accent)]">position open</span>
                ) : r.blockedBy ? (
                  <span className="text-[var(--muted)]">
                    waiting on: <span className="text-[var(--warn)]">{r.blockedBy}</span>
                  </span>
                ) : (
                  <span className="text-[var(--up)]">
                    all entry conditions met — trades on the next tick
                  </span>
                )}
              </div>
            </button>

            {open && (
              <div className="border-t border-[var(--line)] px-3 py-2 space-y-1.5">
                <div className="space-y-1 pb-1">
                  <div className="text-[9px] uppercase tracking-wide text-[var(--muted)]">
                    Entry conditions
                  </div>
                  {r.gates.map((g) => (
                    <div key={g.name} className="flex items-center gap-2 text-[10px]">
                      <span className={g.passed ? "text-[var(--up)]" : "text-[var(--down)]"}>
                        {g.passed ? "✓" : "✗"}
                      </span>
                      <span className="flex-1 text-[var(--muted)]">{g.name}</span>
                      <span className="tnum text-[var(--text)]">{g.actual}</span>
                      <span className="tnum text-[var(--muted)]">need {g.required}</span>
                    </div>
                  ))}
                </div>
                <button
                  onClick={() => onChart(r.symbol)}
                  className="w-full rounded-md bg-[var(--surface-2)] py-1.5 text-[10px] text-[var(--accent)]"
                >
                  Open chart &amp; indicators
                </button>
                {TF_ORDER.filter((tf) => r.timeframes[tf]).map((tf) => {
                  const t = r.timeframes[tf]!;
                  return (
                    <div key={tf} className="text-[10px]">
                      <div className="flex items-center justify-between">
                        <span className="font-medium">
                          {tf}
                          <span className="ml-1.5 text-[var(--muted)]">{t.regime}</span>
                        </span>
                        <span className={`tnum ${tone(t.score)}`}>
                          {t.score >= 0 ? "+" : ""}
                          {t.score.toFixed(2)}
                        </span>
                      </div>
                      <div className="text-[var(--muted)] leading-relaxed">
                        Elliott {t.elliott.pattern}
                        {t.elliott.pattern !== "none" && `/${t.elliott.wave}`} →{" "}
                        <span className={t.elliott.bias === "long" ? "text-[var(--up)]" : t.elliott.bias === "short" ? "text-[var(--down)]" : ""}>
                          {t.elliott.bias}
                        </span>{" "}
                        ({pct(t.elliott.confidence, 0)}) · Gann{" "}
                        <span className={t.gann.bias === "long" ? "text-[var(--up)]" : t.gann.bias === "short" ? "text-[var(--down)]" : ""}>
                          {t.gann.bias}
                        </span>{" "}
                        bar {t.gann.barsSinceAnchor}/{t.gann.nearestCycle}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </>
  );
}

/** Per-timeframe heat strip: one cell per timeframe, green long / red short. */
function TfStrip({ timeframes }: { timeframes: Record<string, TfRead> }) {
  return (
    <div className="flex gap-[2px]">
      {TF_ORDER.map((tf) => {
        const t = timeframes[tf];
        if (!t) {
          return <span key={tf} className="h-4 w-[6px] rounded-sm bg-[var(--surface-2)]" />;
        }
        const a = Math.min(1, Math.abs(t.score) * 1.8 + 0.15);
        const bg =
          t.score > 0.1
            ? `rgba(34,201,139,${a})`
            : t.score < -0.1
              ? `rgba(255,85,112,${a})`
              : "var(--surface-2)";
        return (
          <span
            key={tf}
            className="h-4 w-[6px] rounded-sm"
            style={{ background: bg }}
            title={`${tf}: ${t.score.toFixed(2)}`}
          />
        );
      })}
    </div>
  );
}

function HistoryTab({
  trades,
  stats,
  now,
}: {
  trades: Trade[];
  stats: State["stats"] | undefined;
  now: number;
}) {
  return (
    <>
      {stats && stats.trades > 0 && (
        <div className="rounded-xl bg-[var(--surface)] p-3">
          <div className="grid grid-cols-4 gap-2 text-[10px]">
            <Cell label="Trades" value={String(stats.trades)} />
            <Cell label="Win rate" value={pct(stats.winRate, 0)} />
            <Cell
              label="Net P&L"
              value={signed(stats.netPnl, 3)}
              cls={tone(stats.netPnl)}
            />
            <Cell label="Costs" value={money(stats.fees + stats.funding, 3)} />
          </div>
          <p className="mt-2 text-[10px] leading-relaxed text-[var(--muted)]">
            Gross {signed(stats.grossPnl, 3)} minus {money(stats.fees, 3)} fees and{" "}
            {money(stats.funding, 4)} funding = net {signed(stats.netPnl, 3)}.
          </p>
        </div>
      )}

      {trades.length === 0 ? (
        <Empty>No closed trades yet.</Empty>
      ) : (
        trades.map((t) => (
          <div key={t.id} className="rounded-xl bg-[var(--surface)] px-3 py-2.5">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="font-medium text-[13px]">
                  {t.symbol.replace("USDT", "")}
                </span>
                <span
                  className={`text-[10px] ${t.side === "long" ? "text-[var(--up)]" : "text-[var(--down)]"}`}
                >
                  {t.side}
                </span>
                <span className="rounded bg-[var(--surface-2)] px-1 py-0.5 text-[9px] text-[var(--muted)]">
                  {t.exitReason.replace("_", " ")}
                </span>
              </div>
              <span className={`tnum text-[13px] font-semibold ${tone(t.netPnl)}`}>
                {signed(t.netPnl, 3)}
              </span>
            </div>
            <div className="mt-1 flex items-center justify-between text-[9px] text-[var(--muted)] tnum">
              <span>
                {fmtPrice(t.entryPrice)} → {fmtPrice(t.exitPrice)} · {t.rMultiple.toFixed(2)}R
              </span>
              <span>
                fees {money(t.entryFee + t.exitFee, 4)} · {timeAgo(t.closedAt, now)}
              </span>
            </div>
          </div>
        ))
      )}
    </>
  );
}
