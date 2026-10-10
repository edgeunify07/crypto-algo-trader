"use client";

import { useEffect, useState } from "react";

/**
 * Terminal panels: market list, order book, trade tape and strategy readout.
 *
 * These are the parts of a trading screen that are purely informational. None
 * of them can place an order — the engine trades on its own schedule, so a
 * manual control here would either do nothing or fight the loop.
 */

export interface MarketRow {
  symbol: string;
  markPrice: number;
  score: number;
  direction: "long" | "short" | "flat";
  alignment: number;
  hasPosition: boolean;
  blockedBy: string | null;
  changePct?: number;
}

const fmtPrice = (n: number) => {
  if (!Number.isFinite(n) || n === 0) return "—";
  if (n >= 1000) return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (n >= 1) return n.toFixed(4);
  return n.toFixed(6);
};
const pct = (n: number, d = 2) => `${n >= 0 ? "+" : ""}${(n * 100).toFixed(d)}%`;
const tone = (n: number) =>
  n > 0 ? "text-[var(--up)]" : n < 0 ? "text-[var(--down)]" : "text-[var(--muted)]";

/** Left rail: every symbol the engine is watching today. */
export function MarketList({
  rows,
  selected,
  onSelect,
}: {
  rows: MarketRow[];
  selected: string;
  onSelect: (s: string) => void;
}) {
  const [query, setQuery] = useState("");
  const filtered = rows.filter((r) =>
    r.symbol.toLowerCase().includes(query.toLowerCase().trim()),
  );

  return (
    <div className="flex h-full flex-col">
      <div className="p-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search"
          className="w-full rounded-lg bg-[var(--surface-2)] px-2.5 py-1.5 text-[12px] outline-none placeholder:text-[var(--muted)]"
        />
      </div>
      <div className="grid grid-cols-[1fr_auto_auto] gap-2 px-2.5 pb-1 text-[9px] uppercase tracking-wide text-[var(--muted)]">
        <span>Pair</span>
        <span className="text-right">Price</span>
        <span className="w-12 text-right">Signal</span>
      </div>
      <div className="flex-1 overflow-y-auto no-bar">
        {filtered.length === 0 && (
          <p className="px-3 py-6 text-center text-[11px] text-[var(--muted)]">
            waiting for the first scan…
          </p>
        )}
        {filtered.map((r) => {
          const active = r.symbol === selected;
          return (
            <button
              key={r.symbol}
              onClick={() => onSelect(r.symbol)}
              className={`grid w-full grid-cols-[1fr_auto_auto] items-center gap-2 px-2.5 py-1.5 text-left ${
                active ? "bg-[var(--surface-2)]" : ""
              }`}
            >
              <span className="flex items-center gap-1 truncate text-[12px]">
                <span className="font-medium">{r.symbol.replace("USDT", "")}</span>
                <span className="text-[9px] text-[var(--muted)]">/USDT</span>
                {r.hasPosition && (
                  <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--accent)]" />
                )}
              </span>
              <span className="text-right text-[11px] tnum">{fmtPrice(r.markPrice)}</span>
              <span className={`w-12 text-right text-[11px] tnum ${tone(r.score)}`}>
                {r.score >= 0 ? "+" : ""}
                {r.score.toFixed(2)}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

interface BookData {
  bids: { price: number; qty: number; total: number }[];
  asks: { price: number; qty: number; total: number }[];
  maxTotal: number;
  spread: number;
  spreadPct: number;
  trades: { id: number; price: number; qty: number; time: number; side: "buy" | "sell" }[];
  ticker: {
    lastPrice: number;
    changePct: number;
    high: number;
    low: number;
    quoteVolume: number;
  } | null;
}

export function useBook(symbol: string) {
  const [book, setBook] = useState<BookData | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch(`/api/v2/book?symbol=${symbol}`, { cache: "no-store" });
        const body = (await res.json()) as BookData & { error?: string };
        if (!cancelled && !body.error) setBook(body);
      } catch {
        // A dropped poll is not worth surfacing; the next one is 3s away.
      }
    };
    const kick = setTimeout(load, 0);
    const id = setInterval(load, 3000);
    return () => {
      cancelled = true;
      clearTimeout(kick);
      clearInterval(id);
    };
  }, [symbol]);

  return book;
}

/** Order book with cumulative-depth shading. */
export function OrderBook({ book, symbol }: { book: BookData | null; symbol: string }) {
  if (!book) {
    return (
      <Panel title="Order book" right={symbol.replace("USDT", "/USDT")}>
        <p className="px-3 py-6 text-center text-[11px] text-[var(--muted)]">loading…</p>
      </Panel>
    );
  }

  return (
    <Panel title="Order book" right={symbol.replace("USDT", "/USDT")}>
      <div className="grid grid-cols-3 px-2.5 pb-1 text-[9px] uppercase tracking-wide text-[var(--muted)]">
        <span>Price</span>
        <span className="text-right">Amount</span>
        <span className="text-right">Total</span>
      </div>
      <BookSide rows={book.asks} colour="#ff5570" maxTotal={book.maxTotal} reverse />
      <div className="flex items-baseline justify-between px-2.5 py-1.5">
        <span className="text-[15px] font-semibold tnum">
          {fmtPrice(book.ticker?.lastPrice ?? 0)}
        </span>
        <span className="text-[9px] text-[var(--muted)]">
          spread {(book.spreadPct * 100).toFixed(3)}%
        </span>
      </div>
      <BookSide rows={book.bids} colour="#22c98b" maxTotal={book.maxTotal} />
    </Panel>
  );
}

/** One side of the book, shaded by cumulative depth. */
function BookSide({
  rows, colour, maxTotal, reverse,
}: {
  rows: BookData["bids"];
  colour: string;
  maxTotal: number;
  reverse?: boolean;
}) {
  const ordered = reverse ? [...rows].reverse() : rows;
  return (
    <>
      {ordered.map((r) => (
        <div key={r.price} className="relative grid grid-cols-3 px-2.5 py-[2px] text-[10px] tnum">
          <span
            className="absolute inset-y-0 right-0"
            style={{
              width: `${Math.min(100, (r.total / (maxTotal || 1)) * 100)}%`,
              background: colour,
              opacity: 0.1,
            }}
          />
          <span className="relative" style={{ color: colour }}>{fmtPrice(r.price)}</span>
          <span className="relative text-right text-[var(--muted)]">{r.qty.toFixed(3)}</span>
          <span className="relative text-right text-[var(--muted)]">{r.total.toFixed(2)}</span>
        </div>
      ))}
    </>
  );
}

/** Live trade tape. */
export function TradeTape({ book }: { book: BookData | null }) {
  return (
    <Panel title="Market trades">
      <div className="grid grid-cols-3 px-2.5 pb-1 text-[9px] uppercase tracking-wide text-[var(--muted)]">
        <span>Price</span>
        <span className="text-right">Amount</span>
        <span className="text-right">Time</span>
      </div>
      <div className="max-h-[200px] overflow-y-auto no-bar">
        {(book?.trades ?? []).map((t) => (
          <div key={t.id} className="grid grid-cols-3 px-2.5 py-[2px] text-[10px] tnum">
            <span className={t.side === "buy" ? "text-[var(--up)]" : "text-[var(--down)]"}>
              {fmtPrice(t.price)}
            </span>
            <span className="text-right text-[var(--muted)]">{t.qty.toFixed(4)}</span>
            <span className="text-right text-[var(--muted)]">
              {new Date(t.time).toLocaleTimeString("en-GB", { hour12: false })}
            </span>
          </div>
        ))}
        {!book && <p className="px-3 py-4 text-center text-[11px] text-[var(--muted)]">loading…</p>}
      </div>
    </Panel>
  );
}

export interface StrategyInfo {
  version: string;
  source: string;
  weights: Record<string, number>;
  indicators: Record<string, number | boolean>;
  entry: Record<string, number | boolean>;
  exit: Record<string, unknown>;
}

/**
 * The strategy panel.
 *
 * Read-only on purpose. These values are owned by the improvement loop, which
 * promotes a change only after it beats the incumbent on a backtest; a manual
 * override here would be silently replaced the next time that runs.
 */
export function StrategyPanel({
  info,
  gates,
}: {
  info: StrategyInfo | null;
  gates: { name: string; required: number | string; actual: number | string; passed: boolean }[];
}) {
  if (!info) {
    return (
      <Panel title="Strategy engine">
        <p className="px-3 py-6 text-center text-[11px] text-[var(--muted)]">loading…</p>
      </Panel>
    );
  }

  const active = Object.entries(info.weights)
    .map(([k, v]) => ({ name: k, weight: v }))
    .sort((a, b) => b.weight - a.weight);

  return (
    <Panel title="Strategy engine" right={info.version}>
      <div className="space-y-2 px-2.5 pb-2">
        <p className="text-[10px] leading-relaxed text-[var(--muted)]">
          Multi-timeframe confluence · Elliott Wave + Gann · USDⓈ-M perps.
          Parameters are tuned by the improvement loop, not by hand.
        </p>

        <div>
          <div className="mb-1 text-[9px] uppercase tracking-wide text-[var(--muted)]">
            Indicator weights
          </div>
          <div className="grid grid-cols-2 gap-x-3 gap-y-1">
            {active.map((c) => (
              <div key={c.name} className="flex items-center gap-1.5">
                <span
                  className="h-1.5 w-1.5 shrink-0 rounded-full"
                  style={{
                    background: c.weight > 0.05 ? "var(--up)" : "var(--line)",
                    opacity: c.weight > 0.05 ? Math.min(1, 0.35 + c.weight / 2) : 1,
                  }}
                />
                <span className="flex-1 truncate text-[10px]">
                  {c.name.replace(/([A-Z])/g, " $1").toLowerCase()}
                </span>
                <span className="text-[10px] tnum text-[var(--muted)]">
                  {c.weight.toFixed(2)}
                </span>
              </div>
            ))}
          </div>
        </div>

        {gates.length > 0 && (
          <div>
            <div className="mb-1 text-[9px] uppercase tracking-wide text-[var(--muted)]">
              Entry conditions
            </div>
            <div className="space-y-0.5">
              {gates.map((g) => (
                <div key={g.name} className="flex items-center gap-1.5 text-[10px]">
                  <span className={g.passed ? "text-[var(--up)]" : "text-[var(--down)]"}>
                    {g.passed ? "✓" : "✗"}
                  </span>
                  <span className="flex-1 truncate text-[var(--muted)]">{g.name}</span>
                  <span className="tnum">{g.actual}</span>
                  <span className="tnum text-[var(--muted)]">/ {g.required}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        <div>
          <div className="mb-1 text-[9px] uppercase tracking-wide text-[var(--muted)]">
            Key parameters
          </div>
          <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-[10px]">
            <Param label="EMA fast" value={info.indicators.emaFast} />
            <Param label="EMA slow" value={info.indicators.emaSlow} />
            <Param label="RSI period" value={info.indicators.rsiPeriod} />
            <Param label="ADX floor" value={info.indicators.adxThreshold} />
            <Param label="ATR stop ×" value={info.exit.atrStopMultiple as number} />
            <Param label="Max hold" value={info.exit.maxHoldBars as number} />
            <Param label="Min score" value={info.entry.minScore} />
            <Param label="Min align" value={info.entry.minAlignment} />
          </div>
        </div>
      </div>
    </Panel>
  );
}

function Param({ label, value }: { label: string; value: unknown }) {
  const text =
    typeof value === "number"
      ? Number.isInteger(value) ? String(value) : value.toFixed(2)
      : String(value);
  return (
    <div className="flex items-center justify-between">
      <span className="text-[var(--muted)]">{label}</span>
      <span className="tnum">{text}</span>
    </div>
  );
}

export function Panel({
  title,
  right,
  children,
}: {
  title: string;
  right?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-xl bg-[var(--surface)] overflow-hidden">
      <div className="flex items-center justify-between border-b border-[var(--line)] px-2.5 py-1.5">
        <h2 className="text-[11px] font-medium">{title}</h2>
        {right && <span className="text-[10px] text-[var(--muted)] tnum">{right}</span>}
      </div>
      {children}
    </section>
  );
}

/** Ticker strip shown above the chart. */
export function TickerBar({
  symbol,
  book,
}: {
  symbol: string;
  book: BookData | null;
}) {
  const t = book?.ticker;
  return (
    <div className="flex items-center gap-3 overflow-x-auto no-bar rounded-xl bg-[var(--surface)] px-3 py-2">
      <span className="shrink-0 text-[13px] font-semibold">
        {symbol.replace("USDT", "")}
        <span className="text-[var(--muted)]">/USDT</span>
      </span>
      <span className={`shrink-0 text-[17px] font-semibold tnum ${tone(t?.changePct ?? 0)}`}>
        {fmtPrice(t?.lastPrice ?? 0)}
      </span>
      <Metric label="24h" value={t ? pct(t.changePct) : "—"} cls={tone(t?.changePct ?? 0)} />
      <Metric label="High" value={t ? fmtPrice(t.high) : "—"} />
      <Metric label="Low" value={t ? fmtPrice(t.low) : "—"} />
      <Metric
        label="Vol"
        value={t ? `$${(t.quoteVolume / 1e6).toFixed(1)}M` : "—"}
      />
    </div>
  );
}

function Metric({ label, value, cls }: { label: string; value: string; cls?: string }) {
  return (
    <span className="shrink-0 leading-tight">
      <span className="block text-[8px] uppercase tracking-wide text-[var(--muted)]">{label}</span>
      <span className={`block text-[11px] tnum ${cls ?? ""}`}>{value}</span>
    </span>
  );
}
