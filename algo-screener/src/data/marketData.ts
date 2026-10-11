import { config } from "../config.js";
import { createLogger } from "../util/logger.js";
import { CandleSeries } from "./candleSeries.js";
import { KlineStream, type KlineUpdate } from "../binance/stream.js";
import { fetchKlines, fetch24hTickers, fetchExchangeInfo, type SymbolFilters } from "../binance/rest.js";
import type { Candle, Timeframe } from "../types.js";

const log = createLogger("marketdata");

function key(symbol: string, timeframe: Timeframe): string {
  return `${symbol}:${timeframe}`;
}

export type BarCloseHandler = (
  symbol: string,
  timeframe: Timeframe,
  series: CandleSeries,
) => void;

/**
 * Owns every symbol/timeframe series: REST warm-up, live websocket updates,
 * and periodic gap healing. Analysis layers read from here and never touch the
 * network themselves.
 */
export class MarketData {
  private readonly series = new Map<string, CandleSeries>();
  private readonly handlers: BarCloseHandler[] = [];
  private stream: KlineStream | null = null;
  private healTimer: NodeJS.Timeout | null = null;
  private filters = new Map<string, SymbolFilters>();
  private volume24h = new Map<string, number>();

  constructor(
    readonly symbols: string[],
    readonly timeframes: Timeframe[],
    private readonly historyBars = config.historyBars,
  ) {}

  /** Resolve the trading universe: explicit list, or top symbols by 24h volume. */
  static async resolveUniverse(): Promise<string[]> {
    if (config.universe.symbols.length > 0) return [...config.universe.symbols];

    const tickers = await fetch24hTickers();
    const exclude = new Set(config.universe.exclude);
    const quote = config.universe.quoteAsset;

    return tickers
      .filter(
        (t) =>
          t.symbol.endsWith(quote) &&
          !exclude.has(t.symbol) &&
          // Leveraged tokens (BTCUP/BTCDOWN) track an index, not spot structure.
          !/(UP|DOWN|BULL|BEAR)$/.test(t.symbol.slice(0, -quote.length)) &&
          t.quoteVolume >= config.universe.minQuoteVolume24h,
      )
      .sort((a, b) => b.quoteVolume - a.quoteVolume)
      .slice(0, config.universe.topN)
      .map((t) => t.symbol);
  }

  get(symbol: string, timeframe: Timeframe): CandleSeries | undefined {
    return this.series.get(key(symbol, timeframe));
  }

  /** Series for a symbol across every loaded timeframe. */
  forSymbol(symbol: string): Map<Timeframe, CandleSeries> {
    const out = new Map<Timeframe, CandleSeries>();
    for (const tf of this.timeframes) {
      const s = this.series.get(key(symbol, tf));
      if (s) out.set(tf, s);
    }
    return out;
  }

  symbolFilters(symbol: string): SymbolFilters | undefined {
    return this.filters.get(symbol);
  }

  quoteVolume24h(symbol: string): number {
    return this.volume24h.get(symbol) ?? 0;
  }

  price(symbol: string): number {
    // Prefer the fastest timeframe — it has the freshest tick.
    for (const tf of this.timeframes) {
      const s = this.series.get(key(symbol, tf));
      if (s && s.price > 0) return s.price;
    }
    return 0;
  }

  onBarClose(handler: BarCloseHandler): void {
    this.handlers.push(handler);
  }

  /** Warm up every series from REST. Runs with bounded concurrency. */
  async warmUp(concurrency = 6): Promise<void> {
    const [filters, tickers] = await Promise.all([
      fetchExchangeInfo().catch(() => new Map<string, SymbolFilters>()),
      fetch24hTickers().catch(() => []),
    ]);
    this.filters = filters;
    for (const t of tickers) this.volume24h.set(t.symbol, t.quoteVolume);

    const jobs: { symbol: string; timeframe: Timeframe }[] = [];
    for (const symbol of this.symbols) {
      for (const timeframe of this.timeframes) {
        jobs.push({ symbol, timeframe });
      }
    }

    let cursor = 0;
    let loaded = 0;
    const workers = Array.from({ length: concurrency }, async () => {
      for (;;) {
        const job = jobs[cursor++];
        if (!job) return;
        try {
          const candles = await fetchKlines(
            job.symbol,
            job.timeframe,
            this.historyBars,
          );
          const series = new CandleSeries(
            job.symbol,
            job.timeframe,
            this.historyBars,
          );
          series.seed(candles);
          this.series.set(key(job.symbol, job.timeframe), series);
          loaded++;
        } catch (err) {
          log.warn(`warm-up failed for ${job.symbol} ${job.timeframe}`, err);
        }
      }
    });
    await Promise.all(workers);
    log.info(`warmed up ${loaded}/${jobs.length} series`);
  }

  /** Begin streaming live updates and healing gaps. */
  start(): void {
    const subscriptions = this.symbols.flatMap((symbol) =>
      this.timeframes.map((timeframe) => ({ symbol, timeframe })),
    );
    this.stream = new KlineStream(subscriptions, (u) => this.handleUpdate(u));
    this.stream.start();

    // Websockets drop messages; a periodic REST sweep repairs any gaps.
    this.healTimer = setInterval(() => void this.healGaps(), 120_000);
  }

  stop(): void {
    this.stream?.stop();
    this.stream = null;
    if (this.healTimer) clearInterval(this.healTimer);
    this.healTimer = null;
  }

  private handleUpdate(update: KlineUpdate): void {
    const series = this.series.get(key(update.symbol, update.timeframe));
    if (!series) return;
    if (series.apply(update.candle)) {
      for (const handler of this.handlers) {
        try {
          handler(update.symbol, update.timeframe, series);
        } catch (err) {
          log.error("bar-close handler threw", err);
        }
      }
    }
  }

  private async healGaps(): Promise<void> {
    const now = Date.now();
    const stale = [...this.series.values()].filter((s) => s.isStale(now));
    if (stale.length === 0) return;
    log.warn(`backfilling ${stale.length} stale series`);
    for (const series of stale.slice(0, 20)) {
      try {
        const candles = await fetchKlines(series.symbol, series.timeframe, 200);
        for (const candle of candles) series.apply(candle);
      } catch (err) {
        log.warn(`backfill failed for ${series.symbol} ${series.timeframe}`, err);
      }
    }
  }

  /** Build a series directly from candles — used by the backtester. */
  static fromCandles(
    symbol: string,
    timeframe: Timeframe,
    candles: Candle[],
    maxBars = config.historyBars,
  ): CandleSeries {
    const series = new CandleSeries(symbol, timeframe, maxBars);
    series.seed(candles);
    return series;
  }
}
