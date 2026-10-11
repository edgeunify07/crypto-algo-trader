import fs from "node:fs";
import {
  DEFAULT_PARAMS,
  StrategyParamsSchema,
  defaultVersionedParams,
  paramsVersionId,
  sanitiseParams,
  type StrategyParams,
  type VersionedParams,
} from "../strategy/params.js";
import { appendJsonl, dataPath, readJson, readJsonl, writeJson } from "../util/fsStore.js";
import { createLogger } from "../util/logger.js";

const log = createLogger("params");

const ACTIVE_FILE = () => dataPath("params", "active.json");
const HISTORY_FILE = () => dataPath("params", "history.jsonl");

/**
 * Versioned parameter storage.
 *
 * Every promotion is appended to an immutable history alongside the evidence
 * that justified it, so a live run can always be traced back to the backtest
 * that produced its settings — and rolled back when a promotion turns out to
 * have been a fluke.
 */

export interface PromotionRecord extends VersionedParams {
  evidence: {
    trainFitness: number;
    validationFitness: number;
    trades: number;
    totalReturn: number;
    maxDrawdown: number;
    sharpe: number;
    foldConsistency: number;
  };
}

export function loadActiveParams(): VersionedParams {
  const stored = readJson<VersionedParams | null>(ACTIVE_FILE(), null);
  if (!stored) return defaultVersionedParams();

  const parsed = StrategyParamsSchema.safeParse(stored.params);
  if (!parsed.success) {
    log.warn("stored active params failed validation; falling back to defaults");
    return defaultVersionedParams();
  }
  return { ...stored, params: sanitiseParams(parsed.data).params };
}

export function saveActiveParams(versioned: VersionedParams): void {
  writeJson(ACTIVE_FILE(), versioned);
}

export function recordPromotion(record: PromotionRecord): void {
  appendJsonl(HISTORY_FILE(), record);
  saveActiveParams(record);
  log.info(`promoted params ${record.version} (parent ${record.parentVersion ?? "none"})`);
}

export function loadHistory(): PromotionRecord[] {
  return readJsonl<PromotionRecord>(HISTORY_FILE());
}

/** Roll back to a previous version by id, or to the defaults. */
export function rollback(version: string): VersionedParams | null {
  if (version === "default") {
    const fallback = defaultVersionedParams();
    saveActiveParams(fallback);
    return fallback;
  }
  const record = loadHistory().find((r) => r.version === version);
  if (!record) return null;
  saveActiveParams(record);
  return record;
}

export function newVersion(
  params: StrategyParams,
  source: string,
  rationale: string,
  parentVersion: string | null,
): VersionedParams {
  return {
    version: paramsVersionId(source),
    createdAt: Date.now(),
    source,
    rationale,
    parentVersion,
    params,
  };
}

/** Short textual history fed back to the LLM so it doesn't repeat itself. */
export function recentAttemptSummary(limit = 6): string {
  const history = loadHistory().slice(-limit);
  if (history.length === 0) return "";
  return history
    .map(
      (r) =>
        `- ${r.version} (${r.source}): ${r.rationale.slice(0, 180)} | ` +
        `OOS fitness ${r.evidence.validationFitness.toFixed(3)}, return ${(r.evidence.totalReturn * 100).toFixed(1)}%, ` +
        `DD ${(r.evidence.maxDrawdown * 100).toFixed(1)}%, ${r.evidence.trades} trades`,
    )
    .join("\n");
}

export function ensureDefaultsExist(): void {
  if (!fs.existsSync(ACTIVE_FILE())) {
    saveActiveParams(defaultVersionedParams());
  }
}

export { DEFAULT_PARAMS };
