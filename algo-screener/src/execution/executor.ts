import { config } from "../config.js";
import { createLogger } from "../util/logger.js";
import { PaperBroker } from "./paperBroker.js";
import { checkRisk, scalePlan } from "./riskManager.js";
import { placeMarketOrder, placeStopLoss } from "./binanceLive.js";
import type { ClosedTrade, ExitReason, Position, TradePlan } from "../types.js";
import type { StrategyParams } from "../strategy/params.js";
import type { MarketData } from "../data/marketData.js";

const log = createLogger("executor");

export type ExecutionMode = "paper" | "live";

export interface ExecutionResult {
  accepted: boolean;
  reason: string;
  position?: Position;
}

/**
 * Routes trade plans to either the paper broker or the real exchange.
 *
 * Live mode still mirrors every fill into the paper broker, so position state,
 * stop management and reporting work identically in both modes and the
 * improvement loop sees one consistent trade history.
 */
export class Executor {
  readonly broker: PaperBroker;

  constructor(
    readonly mode: ExecutionMode,
    private readonly market: MarketData | null,
    startingCash = config.account.startingCash,
  ) {
    this.broker = new PaperBroker(startingCash);
    if (mode === "live") {
      log.warn("executor is in LIVE mode — orders will be sent to Binance");
    }
  }

  prices(): Map<string, number> {
    const out = new Map<string, number>();
    if (!this.market) return out;
    for (const symbol of this.market.symbols) {
      const price = this.market.price(symbol);
      if (price > 0) out.set(symbol, price);
    }
    return out;
  }

  async enter(
    plan: TradePlan,
    params: StrategyParams,
    paramsVersion: string,
    time = Date.now(),
  ): Promise<ExecutionResult> {
    const prices = this.prices();
    prices.set(plan.symbol, plan.entry);

    const verdict = checkRisk(plan, this.broker, prices, params);
    if (!verdict.allowed) {
      return { accepted: false, reason: verdict.reason };
    }
    const sized = scalePlan(plan, verdict.sizeMultiplier);

    if (this.mode === "live") {
      try {
        const filters = this.market?.symbolFilters(sized.symbol);
        const order = await placeMarketOrder(sized, filters);
        // Mirror the real fill price into the paper book.
        const filled: TradePlan = {
          ...sized,
          entry: order.avgPrice,
          quantity: order.quantity,
          notional: order.avgPrice * order.quantity,
        };
        const position = this.broker.open(filled, time, { paramsVersion });
        if (!position) {
          return { accepted: false, reason: "live fill could not be mirrored locally" };
        }
        // Park a protective stop on the exchange so it survives a restart.
        try {
          await placeStopLoss(
            filled.symbol,
            filled.side,
            order.quantity,
            filled.stopLoss,
            filters,
          );
        } catch (err) {
          log.error(
            `${filled.symbol}: entry filled but the protective stop was REJECTED — manage this position manually`,
            err,
          );
        }
        return { accepted: true, reason: "live order filled", position };
      } catch (err) {
        return {
          accepted: false,
          reason: `live order failed: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }

    const position = this.broker.open(sized, time, { paramsVersion });
    if (!position) return { accepted: false, reason: "paper broker rejected the order" };
    return { accepted: true, reason: "paper order filled", position };
  }

  async exit(
    symbol: string,
    price: number,
    reason: ExitReason,
    fraction = 1,
    time = Date.now(),
  ): Promise<ClosedTrade | null> {
    const position = this.broker.position(symbol);
    if (!position) return null;

    if (this.mode === "live") {
      try {
        const filters = this.market?.symbolFilters(symbol);
        const closingPlan: TradePlan = {
          symbol,
          // Closing a long is a sell; the plan's `side` drives order direction.
          side: position.side === "long" ? "short" : "long",
          timeframe: position.timeframe,
          entry: price,
          stopLoss: price,
          takeProfits: [],
          riskFraction: 0,
          quantity: position.quantity * fraction,
          notional: position.quantity * fraction * price,
          rMultiple: 0,
          confidence: 1,
          reasons: [`exit: ${reason}`],
          createdAt: time,
        };
        const order = await placeMarketOrder(closingPlan, filters);
        return this.broker.close(symbol, order.avgPrice, time, reason, fraction);
      } catch (err) {
        log.error(`live exit failed for ${symbol}; position left open`, err);
        return null;
      }
    }

    return this.broker.close(symbol, price, time, reason, fraction);
  }

  updateStop(symbol: string, stopLoss: number): void {
    this.broker.setStop(symbol, stopLoss);
  }
}
