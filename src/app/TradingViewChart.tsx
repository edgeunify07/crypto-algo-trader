"use client";

import { useState } from "react";

/**
 * TradingView's chart for the same Binance perpetual the engine trades.
 *
 * The engine's own chart (`Chart.tsx`) draws exactly the series the strategy
 * decided on, which is the right thing to look at when asking *why* it
 * traded. But it depends on this browser reaching Binance's websocket, and
 * that is not available everywhere: Binance restricts by region, and where it
 * is blocked the socket connects and then stays silent, leaving the candle to
 * crawl forward on a server poll. A chart that only moves in some countries
 * is not a chart you can trust at a glance.
 *
 * TradingView streams its own feed from its own domain, so it moves wherever
 * the page loads. It is embedded as an iframe rather than through their
 * loader script, so nothing third-party executes in this page's origin.
 *
 * What it cannot do is show the engine's reasoning: its moving averages are
 * TradingView's defaults, not the tuned lengths the strategy runs, and it
 * knows nothing about the entry, stop and target levels. That is why both
 * charts are kept and the toggle says which is which.
 */

/** Our timeframe names to TradingView's interval codes. */
const INTERVALS: Record<string, string> = {
  "1m": "1",
  "5m": "5",
  "15m": "15",
  "1h": "60",
  "4h": "240",
  "1d": "D",
};

const TIMEFRAMES = ["1m", "5m", "15m", "1h", "4h", "1d"];

export default function TradingViewChart({
  symbol,
  timeframe,
  onTimeframe,
}: {
  symbol: string;
  timeframe: string;
  onTimeframe?: (tf: string) => void;
}) {
  const [tf, setTf] = useState(timeframe);

  // A changed symbol or interval means a different chart, so the iframe is
  // remounted rather than mutated — the embed has no API to steer it.
  const interval = INTERVALS[tf] ?? "60";
  const src =
    "https://s.tradingview.com/widgetembed/?" +
    new URLSearchParams({
      // `.P` is the perpetual contract, which is what this account trades;
      // the bare symbol would be spot, and a different market.
      symbol: `BINANCE:${symbol}.P`,
      interval,
      theme: "dark",
      style: "1",
      timezone: "Etc/UTC",
      locale: "en",
      toolbarbg: "0b0e14",
      hidesidetoolbar: "1",
      symboledit: "0",
      saveimage: "0",
      withdateranges: "0",
      studies: JSON.stringify(["MAExp@tv-basicstudies", "RSI@tv-basicstudies"]),
    }).toString();

  const pick = (next: string) => {
    setTf(next);
    onTimeframe?.(next);
  };

  return (
    <div className="rounded-xl bg-[var(--surface)] overflow-hidden">
      <div className="flex items-center gap-1 overflow-x-auto no-bar px-2 py-1.5">
        {TIMEFRAMES.map((t) => (
          <button
            key={t}
            onClick={() => pick(t)}
            className={`shrink-0 rounded-md px-2 py-1 text-[11px] font-medium ${
              tf === t
                ? "bg-[var(--surface-2)] text-[var(--text)]"
                : "text-[var(--muted)]"
            }`}
          >
            {t}
          </button>
        ))}
        <span className="ml-auto shrink-0 pr-1 text-[9px] text-[var(--muted)]">
          TradingView · live
        </span>
      </div>
      <div className="relative" style={{ height: 420 }}>
        <Frame key={src} src={src} label={symbol.replace("USDT", "")} />
      </div>
    </div>
  );
}

/**
 * The embed, with its own loading state.
 *
 * Separate so that changing symbol or interval — which changes `src` and so
 * the key — remounts it and resets that state along with it. Holding the flag
 * in the parent instead would need an effect to notice the change and clear
 * it, and a setState run synchronously inside an effect is exactly the
 * cascading render React tells you not to write.
 */
function Frame({ src, label }: { src: string; label: string }) {
  const [ready, setReady] = useState(false);
  return (
    <>
      {!ready && (
        <div className="absolute inset-0 grid place-items-center text-[11px] text-[var(--muted)]">
          loading {label} chart…
        </div>
      )}
      <iframe
        src={src}
        onLoad={() => setReady(true)}
        title={`${label} chart`}
        className="h-full w-full border-0"
        allowFullScreen
        // The embed needs nothing from this page; the sandbox keeps a
        // third-party frame from reaching back into it.
        sandbox="allow-scripts allow-same-origin allow-popups"
      />
    </>
  );
}
