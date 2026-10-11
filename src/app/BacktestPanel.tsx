"use client";

import { useEffect, useState } from "react";

/**
 * What the live parameters would have done over recent real klines.
 *
 * Shown on the main screen because the headline question about an automated
 * strategy is not "what is it about to do" but "does this actually work" —
 * and the only answer available before it has traded for months is a replay
 * over real data, with the same fees and funding the live engine pays.
 *
 * The number in the big type is the one the search had not seen. A backtest
 * over a window the parameters were fitted on will happily print twenty or
 * thirty percent, and showing that as the headline is the single most
 * misleading thing this screen could do: it is a measurement of the search,
 * not a forecast of the account. When no clean window exists yet the panel
 * says so instead of substituting the flattering one.
 */

interface Backtest {
  paramsVersion: string;
  days: number;
  startingBalance: number;
  finalEquity: number;
  totalReturn: number;
  trades: number;
  wins: number;
  winRate: number;
  profitFactor: number;
  maxDrawdown: number;
  expectancy: number;
  totalFees: number;
  totalFunding: number;
  liquidations: number;
  bySymbol: { symbol: string; trades: number; netPnl: number }[];
  byReason: { reason: string; trades: number; netPnl: number }[];
  equityCurve: { t: number; equity: number }[];
  poolSize: number;
  universeSize: number;
  fittedThrough: number;
  inSampleDays: number;
  outOfSample: {
    from: number;
    to: number;
    days: number;
    totalReturn: number;
    trades: number;
    winRate: number;
    profitFactor: number;
    maxDrawdown: number;
  } | null;
  cached: boolean;
  ranAt: number;
  error?: string;
}

const money = (n: number, d = 2) => `${n < 0 ? "-" : ""}$${Math.abs(n).toFixed(d)}`;
const signed = (n: number, d = 2) => `${n >= 0 ? "+" : "-"}$${Math.abs(n).toFixed(d)}`;
const pct = (n: number, d = 1) => `${(n * 100).toFixed(d)}%`;
const tone = (n: number) =>
  n > 0 ? "text-[var(--up)]" : n < 0 ? "text-[var(--down)]" : "text-[var(--muted)]";

export default function BacktestPanel({ days = 30 }: { days?: number }) {
  const [data, setData] = useState<Backtest | null>(null);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const kick = setTimeout(() => {
      void (async () => {
        try {
          const res = await fetch(`/api/v2/backtest?days=${days}`, { cache: "no-store" });
          const body = (await res.json()) as Backtest;
          if (!cancelled) setData(body);
        } catch {
          if (!cancelled) setData({ error: "backtest unavailable" } as Backtest);
        } finally {
          if (!cancelled) setLoading(false);
        }
      })();
    }, 0);
    return () => {
      cancelled = true;
      clearTimeout(kick);
    };
  }, [days]);

  if (loading) {
    return (
      <div className="rounded-xl bg-[var(--surface)] px-3 py-4 text-center text-[11px] text-[var(--muted)]">
        replaying the last {days} days of real data…
      </div>
    );
  }
  if (!data || data.error) {
    return (
      <div className="rounded-xl bg-[var(--surface)] px-3 py-4 text-center text-[11px] text-[var(--down)]">
        {data?.error ?? "backtest unavailable"}
      </div>
    );
  }

  // Everything the search had already seen is in-sample; only the remainder
  // says anything about the future. `oos` is null when there is no remainder.
  const oos = data.outOfSample;
  const headline = oos ?? {
    totalReturn: data.totalReturn,
    trades: data.trades,
    winRate: data.winRate,
    profitFactor: data.profitFactor,
    maxDrawdown: data.maxDrawdown,
    days: data.days,
  };
  const profitable = headline.totalReturn > 0;

  return (
    <div className="rounded-xl bg-[var(--surface)] overflow-hidden">
      <button onClick={() => setOpen(!open)} className="w-full px-3 pt-2.5 pb-2 text-left">
        <div className="flex items-center justify-between">
          <span className="text-[9px] uppercase tracking-wider text-[var(--muted)]">
            {oos ? `Out of sample · ${oos.days}d` : `Backtest · last ${data.days}d`} · real data
          </span>
          <span className="text-[9px] text-[var(--muted)]">{open ? "hide" : "detail"}</span>
        </div>

        <div className="mt-1 flex items-baseline gap-2">
          <span className={`text-[22px] font-semibold tnum ${tone(headline.totalReturn)}`}>
            {pct(headline.totalReturn, 2)}
          </span>
          <span className="text-[11px] text-[var(--muted)] tnum">
            {headline.trades} trades · {money(data.startingBalance, 0)} start
          </span>
        </div>

        <EquitySpark points={data.equityCurve} start={data.startingBalance} />

        <div className="mt-2 grid grid-cols-4 gap-1.5 text-[9px]">
          <Cell label="Trades" value={String(headline.trades)} />
          <Cell label="Win" value={pct(headline.winRate, 0)} />
          <Cell label="PF" value={headline.profitFactor.toFixed(2)} cls={tone(headline.profitFactor - 1)} />
          <Cell label="Max DD" value={pct(headline.maxDrawdown, 0)} />
        </div>

        {/*
          The in-sample figure is still shown, just never as the headline —
          hiding it entirely would invite someone to re-derive it and trust it.
        */}
        {data.inSampleDays > 0 && (
          <div className="mt-1.5 flex items-center justify-between text-[9px] text-[var(--muted)]">
            <span>
              {oos
                ? `${data.inSampleDays}d of this window was used to tune the params`
                : "the whole window was used to tune the params"}
            </span>
            <span className="tnum">
              {data.days}d: <span className={tone(data.totalReturn)}>{pct(data.totalReturn, 1)}</span>
            </span>
          </div>
        )}

        {!oos && (
          <div
            className="mt-2 rounded-lg px-2 py-1.5 text-[10px] leading-relaxed"
            style={{ background: "rgba(245,185,66,.12)", color: "var(--warn)" }}
          >
            No untouched window yet — the search that chose these parameters saw
            all of this data, so the figure above measures the search, not the
            strategy. It becomes meaningful as days accumulate past{" "}
            {new Date(data.fittedThrough).toISOString().slice(0, 10)}.
          </div>
        )}

        {/* Fees are the headline risk on a $100 account; never bury them. */}
        <div className="mt-1.5 text-[9px] leading-relaxed text-[var(--muted)]">
          Costs {money(data.totalFees + data.totalFunding, 2)} of the{" "}
          {money(Math.abs(data.finalEquity - data.startingBalance) + data.totalFees + data.totalFunding, 2)} gross moved
          {data.liquidations > 0 && (
            <span className="text-[var(--down)]"> · {data.liquidations} liquidation(s)</span>
          )}
        </div>

        {!profitable && oos && (
          <div
            className="mt-2 rounded-lg px-2 py-1.5 text-[10px] leading-relaxed"
            style={{ background: "rgba(245,185,66,.12)", color: "var(--warn)" }}
          >
            These parameters lost money over the window the search had not
            seen. The engine will still trade them — promotion only happens
            when the improvement loop finds something measurably better.
          </div>
        )}
      </button>

      {open && (
        <div className="border-t border-[var(--line)] px-3 py-2 space-y-2">
          <Section title="By symbol">
            {data.bySymbol.slice(0, 6).map((s) => (
              <Row key={s.symbol} left={s.symbol.replace("USDT", "")} mid={`${s.trades}t`} right={signed(s.netPnl, 2)} tone={s.netPnl} />
            ))}
          </Section>
          <Section title="By exit reason">
            {data.byReason.map((r) => (
              <Row key={r.reason} left={r.reason.replace(/_/g, " ")} mid={`${r.trades}t`} right={signed(r.netPnl, 2)} tone={r.netPnl} />
            ))}
          </Section>
          <p className="pt-1 text-[9px] leading-relaxed text-[var(--muted)]">
            Params {data.paramsVersion}, fitted on data through{" "}
            {new Date(data.fittedThrough).toISOString().slice(0, 10)}. Ranked
            point-in-time across {data.poolSize} symbols, {data.universeSize} tradable
            at a time, on the trailing volume each step actually had — so the
            run is not handed the coins that turned out to move most. The pool
            is drawn from symbols listed today, so anything delisted mid-window
            is missing. Fills use the mark price with no slippage or order-book
            depth, so a real account would do slightly worse. Past results are
            not a forecast.
          </p>
        </div>
      )}
    </div>
  );
}

function EquitySpark({ points, start }: { points: { t: number; equity: number }[]; start: number }) {
  if (points.length < 2) {
    return <div className="mt-2 h-[34px] rounded bg-[var(--surface-2)]" />;
  }
  const W = 300;
  const H = 34;
  const values = points.map((p) => p.equity);
  const hi = Math.max(...values, start);
  const lo = Math.min(...values, start);
  const span = hi - lo || 1;
  const x = (i: number) => (i / (points.length - 1)) * W;
  const y = (v: number) => H - 2 - ((v - lo) / span) * (H - 4);

  const d = points.map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)} ${y(p.equity).toFixed(1)}`).join("");
  const last = values.at(-1) ?? start;
  const colour = last >= start ? "var(--up)" : "var(--down)";

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="mt-2 w-full" style={{ height: 34 }} preserveAspectRatio="none">
      {/* Break-even line: above it the run is in profit. */}
      <line x1={0} x2={W} y1={y(start)} y2={y(start)} stroke="#2a3447" strokeWidth={1} strokeDasharray="3 3" />
      <path d={`${d}L${W} ${H} L0 ${H} Z`} fill={colour} opacity={0.1} />
      <path d={d} fill="none" stroke={colour} strokeWidth={1.5} />
    </svg>
  );
}

function Cell({ label, value, cls }: { label: string; value: string; cls?: string }) {
  return (
    <div className="rounded-lg bg-[var(--surface-2)] px-1.5 py-1">
      <div className="text-[8px] uppercase tracking-wide text-[var(--muted)]">{label}</div>
      <div className={`tnum text-[11px] ${cls ?? ""}`}>{value}</div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1 text-[9px] uppercase tracking-wide text-[var(--muted)]">{title}</div>
      <div className="space-y-0.5">{children}</div>
    </div>
  );
}

function Row({ left, mid, right, tone: t }: { left: string; mid: string; right: string; tone: number }) {
  return (
    <div className="flex items-center justify-between text-[10px]">
      <span className="flex-1 truncate">{left}</span>
      <span className="w-10 text-right text-[var(--muted)] tnum">{mid}</span>
      <span className={`w-16 text-right tnum ${tone(t)}`}>{right}</span>
    </div>
  );
}
