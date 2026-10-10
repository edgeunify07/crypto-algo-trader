import type { Candle, Timeframe } from "../types.js";
import { TIMEFRAME_MS } from "../types.js";

/**
 * Rolling OHLCV buffer for one symbol/timeframe.
 *
 * Closed candles live in `bars`; the still-forming candle is kept separately so
 * analysis never accidentally reads a half-finished bar. Repainting indicators
 * are the most common source of backtest/live divergence, so the split is
 * enforced here rather than left to each caller.
 */
export class CandleSeries {
  private bars: Candle[] = [];
  private forming: Candle | null = null;

  constructor(
    readonly symbol: string,
    readonly timeframe: Timeframe,
    private readonly maxBars: number,
  ) {}

  /** Closed candles, oldest first. */
  get closed(): readonly Candle[] {
    return this.bars;
  }

  get length(): number {
    return this.bars.length;
  }

  /** The live, still-forming candle, if one has been seen. */
  get live(): Candle | null {
    return this.forming;
  }

  get lastClosed(): Candle | null {
    return this.bars.at(-1) ?? null;
  }

  /** Most recent traded price: the forming candle's close, else the last closed. */
  get price(): number {
    return this.forming?.close ?? this.lastClosed?.close ?? 0;
  }

  /** Replace the buffer with a REST warm-up batch (closed candles only). */
  seed(candles: Candle[]): void {
    this.bars = candles
      .filter((c) => c.closed)
      .slice(-this.maxBars)
      .sort((a, b) => a.openTime - b.openTime);
  }

  /**
   * Apply a candle update. Returns true when a bar *closed*, which is the
   * trigger for re-running analysis.
   */
  apply(candle: Candle): boolean {
    if (!candle.closed) {
      this.forming = candle;
      return false;
    }

    const last = this.bars.at(-1);
    if (last && candle.openTime === last.openTime) {
      // Late correction of the bar we already stored.
      this.bars[this.bars.length - 1] = candle;
    } else if (!last || candle.openTime > last.openTime) {
      this.bars.push(candle);
      if (this.bars.length > this.maxBars) {
        this.bars.splice(0, this.bars.length - this.maxBars);
      }
    } else {
      // Out-of-order historical bar — ignore rather than corrupt ordering.
      return false;
    }

    if (this.forming && this.forming.openTime <= candle.openTime) {
      this.forming = null;
    }
    return true;
  }

  /**
   * True when the newest closed bar is older than it should be, which means the
   * websocket dropped updates and the series needs a REST backfill.
   */
  isStale(now = Date.now()): boolean {
    const last = this.lastClosed;
    if (!last) return true;
    // Allow two intervals of slack before declaring a gap.
    return now - last.closeTime > TIMEFRAME_MS[this.timeframe] * 2;
  }

  /** Column extractors — indicators consume plain number arrays. */
  closes(): number[] {
    return this.bars.map((c) => c.close);
  }
  highs(): number[] {
    return this.bars.map((c) => c.high);
  }
  lows(): number[] {
    return this.bars.map((c) => c.low);
  }
  volumes(): number[] {
    return this.bars.map((c) => c.volume);
  }
}
