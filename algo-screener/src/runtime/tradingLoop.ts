import { config } from "../config.js";
import { createLogger } from "../util/logger.js";
import { MarketData } from "../data/marketData.js";
import { Executor, type ExecutionMode } from "../execution/executor.js";
import { screenAll, screenSymbol } from "../screener/screener.js";
import { evaluateExits } from "../strategy/strategy.js";
import { analyseTimeframe } from "../screener/analyse.js";
import { loadActiveParams } from "../improve/paramStore.js";
import { appendJsonl, dataPath, readJson, writeJson } from "../util/fsStore.js";
import {
  TIMEFRAME_MS,
  type ClosedTrade,
  type Position,
  type ScreenerRow,
  type Timeframe,
} from "../types.js";
import type { VersionedParams } from "../strategy/params.js";

const log = createLogger("runtime");

export interface TradingLoopOptions {
  mode: ExecutionMode;
  symbols?: string[];
  timeframes?: Timeframe[];
  startingCash?: number;
  /** Persist broker state so a restart resumes the same paper account. */
  persist?: boolean;
  /** Reload params from disk between scans, picking up promotions live. */
  hotReloadParams?: boolean;
}

interface PersistedState {
  savedAt: number;
  mode: string;
  paramsVersion: string;
  broker: {
    cash: number;
    realisedPnl: number;
    positions: Position[];
    trades: ClosedTrade[];
  };
}

const STATE_FILE = () => dataPath("runtime", "state.json");
const TRADE_LOG = () => dataPath("runtime", "trades.jsonl");
const SIGNAL_LOG = () => dataPath("runtime", "signals.jsonl");

/**
 * Real-time trading loop.
 *
 * Drives paper (or live) trading off the same screener and strategy the
 * backtester uses. Two clocks run concurrently:
 *
 *  - **Bar close** — when a timeframe prints a closed bar, that symbol is
 *    re-analysed and entries are considered. This is the signal clock.
 *  - **Tick** — every few seconds, open positions are checked against the live
 *    price so stops and targets act intrabar rather than waiting for a close.
 */
export class TradingLoop {
  readonly market: MarketData;
  readonly executor: Executor;
  private params: VersionedParams;
  private latestRows = new Map<string, ScreenerRow>();
  private scanTimer: NodeJS.Timeout | null = null;
  private tickTimer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly options: TradingLoopOptions,
    symbols: string[],
  ) {
    this.params = loadActiveParams();
    this.market = new MarketData(
      symbols,
      options.timeframes ?? [...config.timeframes],
    );
    this.executor = new Executor(
      options.mode,
      this.market,
      options.startingCash ?? config.account.startingCash,
    );
  }

  get activeParams(): VersionedParams {
    return this.params;
  }

  get rows(): ScreenerRow[] {
    return [...this.latestRows.values()].sort(
      (a, b) => Math.abs(b.score) * b.confidence - Math.abs(a.score) * a.confidence,
    );
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    log.info(
      `starting ${this.options.mode} loop on ${this.market.symbols.length} symbols ` +
        `× ${this.market.timeframes.length} timeframes with params ${this.params.version}`,
    );

    await this.market.warmUp();
    if (this.options.persist !== false) this.restoreState();

    // Re-analyse a symbol as soon as any of its timeframes closes a bar.
    this.market.onBarClose((symbol) => {
      void this.evaluateSymbol(symbol).catch((err) =>
        log.error(`evaluation failed for ${symbol}`, err),
      );
    });

    this.market.start();

    // Full universe rescan — catches symbols whose bars haven't closed recently.
    this.scanTimer = setInterval(
      () => void this.scan().catch((err) => log.error("scan failed", err)),
      config.runtime.scanIntervalSec * 1000,
    );
    // Intrabar stop/target management.
    this.tickTimer = setInterval(() => void this.manageOpenPositions(), 5_000);

    await this.scan();
  }

  stop(): void {
    this.running = false;
    this.market.stop();
    if (this.scanTimer) clearInterval(this.scanTimer);
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.scanTimer = null;
    this.tickTimer = null;
    if (this.options.persist !== false) this.saveState();
    log.info("trading loop stopped");
  }

  /** Re-read promoted parameters without restarting the loop. */
  reloadParams(): void {
    const latest = loadActiveParams();
    if (latest.version !== this.params.version) {
      log.info(`params hot-reloaded: ${this.params.version} -> ${latest.version}`);
      this.params = latest;
    }
  }

  private async scan(): Promise<void> {
    if (this.options.hotReloadParams !== false) this.reloadParams();

    const equity = this.executor.broker.equity(this.executor.prices());
    const rows = screenAll(this.market, this.params.params, equity);
    for (const row of rows) this.latestRows.set(row.symbol, row);

    const actionable = rows.filter((r) => r.plan !== null);
    log.info(
      `scan: ${rows.length} symbols, ${actionable.length} with a trade plan, ` +
        `equity ${equity.toFixed(2)}, ${this.executor.broker.openPositions.length} open`,
    );

    for (const row of actionable) {
      await this.considerEntry(row);
    }
    this.manageOpenPositions();
    if (this.options.persist !== false) this.saveState();
  }

  private async evaluateSymbol(symbol: string): Promise<void> {
    const equity = this.executor.broker.equity(this.executor.prices());
    const row = screenSymbol(this.market, symbol, this.params.params, equity);
    if (!row) return;
    this.latestRows.set(symbol, row);

    appendJsonl(SIGNAL_LOG(), {
      time: Date.now(),
      symbol,
      score: row.score,
      confidence: row.confidence,
      alignment: row.alignment,
      direction: row.direction,
      anchorTimeframe: row.anchorTimeframe,
      hasPlan: row.plan !== null,
    });

    if (row.plan) await this.considerEntry(row);
  }

  private async considerEntry(row: ScreenerRow): Promise<void> {
    if (!row.plan) return;
    if (this.executor.broker.position(row.symbol)) return;

    // Always price the entry off the live book, not the bar that triggered it.
    const livePrice = this.market.price(row.symbol);
    const plan = livePrice > 0 ? { ...row.plan, entry: livePrice } : row.plan;

    const result = await this.executor.enter(
      plan,
      this.params.params,
      this.params.version,
    );
    if (result.accepted) {
      log.info(
        `ENTER ${plan.side} ${plan.symbol} @ ${plan.entry.toFixed(6)} ` +
          `stop ${plan.stopLoss.toFixed(6)} size ${plan.quantity.toFixed(6)} — ${plan.reasons[0] ?? ""}`,
      );
      appendJsonl(TRADE_LOG(), { type: "entry", time: Date.now(), plan });
    } else {
      log.debug(`skipped ${plan.symbol}: ${result.reason}`);
    }
  }

  /** Check every open position against the live price. */
  private manageOpenPositions(): void {
    for (const position of this.executor.broker.openPositions) {
      const price = this.market.price(position.symbol);
      if (!(price > 0)) continue;

      this.executor.broker.updateExtreme(position.symbol, price, price);

      const series = this.market.get(position.symbol, position.timeframe);
      const analysis = series
        ? analyseTimeframe(
            position.symbol,
            position.timeframe,
            [...series.closed],
            this.params.params,
          )
        : null;
      const row = this.latestRows.get(position.symbol);
      const score = row?.score ?? 0;
      const atr = analysis?.atr ?? 0;
      const barsHeld = Math.floor(
        (Date.now() - position.openedAt) / TIMEFRAME_MS[position.timeframe],
      );

      // The live price is treated as a zero-range bar: a stop or target is only
      // triggered by a price actually printed, never by an assumed intrabar path.
      const decisions = evaluateExits(
        position,
        { high: price, low: price, close: price },
        score,
        atr,
        barsHeld,
        this.params.params,
      );

      for (const decision of decisions) {
        if (decision.action === "update_stop") {
          this.executor.updateStop(position.symbol, decision.stopLoss);
        } else if (decision.action === "close") {
          void this.executor
            .exit(position.symbol, price, decision.reason, decision.fraction)
            .then((trade) => {
              if (trade) {
                log.info(
                  `EXIT ${trade.symbol} ${trade.exitReason} @ ${trade.exitPrice.toFixed(6)} ` +
                    `PnL ${trade.pnl.toFixed(2)} (${trade.rMultiple.toFixed(2)}R)`,
                );
                appendJsonl(TRADE_LOG(), { type: "exit", time: Date.now(), trade });
              }
            })
            .catch((err) => log.error(`exit failed for ${position.symbol}`, err));
          break;
        }
      }
    }

    this.executor.broker.snapshot(Date.now(), this.executor.prices());
  }

  private saveState(): void {
    writeJson(STATE_FILE(), {
      savedAt: Date.now(),
      mode: this.options.mode,
      paramsVersion: this.params.version,
      broker: this.executor.broker.toJSON(),
    });
  }

  private restoreState(): void {
    const state = readJson<PersistedState | null>(STATE_FILE(), null);
    if (!state?.broker) return;
    // Never resume a live book into a paper run or vice versa.
    if (state.mode !== this.options.mode) {
      log.warn(
        `saved state was from ${state.mode} mode; starting ${this.options.mode} fresh`,
      );
      return;
    }
    this.executor.broker.restore(state.broker);
    log.info(
      `restored ${this.executor.broker.openPositions.length} open positions and ` +
        `${this.executor.broker.closedTrades.length} closed trades`,
    );
  }
}
