/**
 * How much of the dashboard's backtest return was look-ahead?
 *
 * The panel used to replay the strategy over *today's* top ten by volume.
 * Those are the coins that already had the biggest month, so the replay was
 * scored on the winners of a race it was pretending to predict. This measures
 * the gap: the same window, same parameters, run once the old way and once
 * with the universe re-ranked from the volume each step actually had.
 */
import { runFuturesBacktest, type BacktestInput } from "@/lib/improve2/backtest";
import { DEFAULT_PARAMS } from "@/lib/algo/strategy/params";
import type { Candle, Timeframe } from "@/lib/algo/types";

const HOST = "https://www.binance.com";
const DAYS = Number(process.env.DAYS ?? "30");
const POOL = Number(process.env.POOL ?? "20");
const LIVE = Number(process.env.LIVE ?? "10");
const TFS: Timeframe[] = ["15m", "1h", "4h"];

type RawKline = [number, string, string, string, string, string, number, string, number, string, string, string];

async function klines(symbol: string, interval: Timeframe, bars: number): Promise<Candle[]> {
  const q = new URLSearchParams({ symbol, interval, limit: String(Math.min(1500, bars)) });
  const res = await fetch(`${HOST}/fapi/v1/klines?${q}`, { cache: "no-store" });
  if (!res.ok) return [];
  const raw = (await res.json()) as RawKline[];
  return raw
    .map((k) => ({
      openTime: k[0], open: +k[1], high: +k[2], low: +k[3], close: +k[4],
      volume: +k[5], closeTime: k[6], quoteVolume: +k[7], trades: k[8], closed: true,
    }))
    .filter((c) => c.closeTime < Date.now());
}

const EXCLUDED = new Set(["USDCUSDT", "BUSDUSDT", "FDUSDUSDT", "TUSDUSDT"]);

const tickers = (await (await fetch(`${HOST}/fapi/v1/ticker/24hr`, { cache: "no-store" })).json()) as {
  symbol: string; quoteVolume: string; lastPrice: string;
}[];
const ranked = tickers
  .filter((t) => t.symbol.endsWith("USDT") && !EXCLUDED.has(t.symbol) && +t.quoteVolume > 0 && +t.lastPrice > 0)
  .sort((a, b) => +b.quoteVolume - +a.quoteVolume)
  .map((t) => t.symbol);

const pool = ranked.slice(0, POOL);
const topTen = ranked.slice(0, LIVE);
console.log(`today's top ${LIVE}: ${topTen.join(" ")}`);
console.log(`wider pool (+${POOL - LIVE}): ${pool.slice(LIVE).join(" ")}\n`);

const bars: Record<string, number> = {
  "15m": Math.min(1500, DAYS * 96 + 300),
  "1h": Math.min(1500, DAYS * 24 + 300),
  "4h": Math.min(1500, DAYS * 6 + 200),
};

const loaded = await Promise.all(
  pool.flatMap((s) => TFS.map(async (tf) => ({ s, tf, c: await klines(s, tf, bars[tf]!) }))),
);
const bySym = new Map<string, Map<Timeframe, Candle[]>>();
for (const { s, tf, c } of loaded) {
  if (c.length === 0) continue;
  const m = bySym.get(s) ?? new Map<Timeframe, Candle[]>();
  m.set(tf, c);
  bySym.set(s, m);
}
const all: BacktestInput[] = [...bySym].map(([symbol, byTimeframe]) => ({ symbol, byTimeframe }));
const narrow = all.filter((d) => topTen.includes(d.symbol));

const latest = Math.max(...all.flatMap((d) => (d.byTimeframe.get("1h") ?? []).map((c) => c.closeTime)));
const from = latest - DAYS * 86_400_000;
const common = { stepTimeframe: "1h" as const, startingBalance: 100, from, to: latest };

const show = (label: string, r: ReturnType<typeof runFuturesBacktest>) =>
  console.log(
    `${label.padEnd(34)} ${String(r.trades.length).padStart(3)}t ` +
      `${(r.totalReturn * 100).toFixed(2).padStart(7)}%  DD ${(r.maxDrawdown * 100).toFixed(1).padStart(4)}%  ` +
      `PF ${r.profitFactor.toFixed(2).padStart(5)}  fees $${r.totalFees.toFixed(2)}`,
  );

console.log(`window ${new Date(from).toISOString().slice(0, 10)} -> ${new Date(latest).toISOString().slice(0, 10)}`);
console.log(`loaded ${all.length} symbols\n`);

show("OLD  today's top 10, no re-rank", runFuturesBacktest(narrow, DEFAULT_PARAMS, common));
show(`NEW  ${all.length} pooled, point-in-time`, runFuturesBacktest(all, DEFAULT_PARAMS, { ...common, universeSize: LIVE }));
show(`     ${all.length} pooled, no re-rank`, runFuturesBacktest(all, DEFAULT_PARAMS, common));
