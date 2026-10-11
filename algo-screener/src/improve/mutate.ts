import { clamp } from "../util/math.js";
import { sanitiseParams, type StrategyParams } from "../strategy/params.js";

/**
 * Local random-mutation search.
 *
 * This is the fallback when no `ANTHROPIC_API_KEY` is configured, and a useful
 * control group when one is: if random perturbation matches the LLM's
 * proposals, the LLM isn't adding anything on this problem. It perturbs a small
 * random subset of parameters so each candidate stays attributable, the same
 * discipline the LLM is asked to follow.
 */

type Mutator = (params: StrategyParams, scale: number) => string;

function jitter(value: number, scale: number, min: number, max: number): number {
  const span = (max - min) * scale;
  return clamp(value + (Math.random() * 2 - 1) * span, min, max);
}

function jitterInt(value: number, scale: number, min: number, max: number): number {
  return Math.round(jitter(value, scale, min, max));
}

const MUTATORS: Mutator[] = [
  (p, s) => {
    const keys = Object.keys(p.weights) as (keyof StrategyParams["weights"])[];
    const key = keys[Math.floor(Math.random() * keys.length)] as keyof StrategyParams["weights"];
    const before = p.weights[key];
    p.weights[key] = jitter(before, s, 0, 3);
    return `weights.${key}: ${before.toFixed(2)} -> ${p.weights[key].toFixed(2)}`;
  },
  (p, s) => {
    const before = p.entry.minScore;
    p.entry.minScore = jitter(before, s, 0.1, 0.95);
    return `entry.minScore: ${before.toFixed(2)} -> ${p.entry.minScore.toFixed(2)}`;
  },
  (p, s) => {
    const before = p.entry.minAlignment;
    p.entry.minAlignment = jitter(before, s, 0, 1);
    return `entry.minAlignment: ${before.toFixed(2)} -> ${p.entry.minAlignment.toFixed(2)}`;
  },
  (p, s) => {
    const before = p.entry.minConfidence;
    p.entry.minConfidence = jitter(before, s, 0, 1);
    return `entry.minConfidence: ${before.toFixed(2)} -> ${p.entry.minConfidence.toFixed(2)}`;
  },
  (p, s) => {
    const before = p.exit.atrStopMultiple;
    p.exit.atrStopMultiple = jitter(before, s, 0.5, 6);
    return `exit.atrStopMultiple: ${before.toFixed(2)} -> ${p.exit.atrStopMultiple.toFixed(2)}`;
  },
  (p, s) => {
    const before = p.exit.trailStartR;
    p.exit.trailStartR = jitter(before, s, 0, 5);
    return `exit.trailStartR: ${before.toFixed(2)} -> ${p.exit.trailStartR.toFixed(2)}`;
  },
  (p, s) => {
    const before = p.exit.trailAtrMultiple;
    p.exit.trailAtrMultiple = jitter(before, s, 0.3, 6);
    return `exit.trailAtrMultiple: ${before.toFixed(2)} -> ${p.exit.trailAtrMultiple.toFixed(2)}`;
  },
  (p, s) => {
    const before = [...p.exit.takeProfitRMultiples];
    p.exit.takeProfitRMultiples = before.map((r) => jitter(r, s, 0.3, 10));
    return `exit.takeProfitRMultiples: [${before.map((r) => r.toFixed(1))}] -> [${p.exit.takeProfitRMultiples.map((r) => r.toFixed(1))}]`;
  },
  (p, s) => {
    const before = p.exit.maxHoldBars;
    p.exit.maxHoldBars = jitterInt(before, s, 5, 2000);
    return `exit.maxHoldBars: ${before} -> ${p.exit.maxHoldBars}`;
  },
  (p, s) => {
    const before = p.exit.breakEvenR;
    p.exit.breakEvenR = jitter(before, s, 0, 5);
    return `exit.breakEvenR: ${before.toFixed(2)} -> ${p.exit.breakEvenR.toFixed(2)}`;
  },
  (p, s) => {
    const before = p.indicators.emaFast;
    p.indicators.emaFast = jitterInt(before, s, 5, 60);
    return `indicators.emaFast: ${before} -> ${p.indicators.emaFast}`;
  },
  (p, s) => {
    const before = p.indicators.emaSlow;
    p.indicators.emaSlow = jitterInt(before, s, 20, 250);
    return `indicators.emaSlow: ${before} -> ${p.indicators.emaSlow}`;
  },
  (p, s) => {
    const before = p.indicators.zigzagAtrMultiple;
    p.indicators.zigzagAtrMultiple = jitter(before, s, 0.8, 6);
    return `indicators.zigzagAtrMultiple: ${before.toFixed(2)} -> ${p.indicators.zigzagAtrMultiple.toFixed(2)}`;
  },
  (p, s) => {
    const before = p.indicators.adxThreshold;
    p.indicators.adxThreshold = jitter(before, s, 10, 40);
    return `indicators.adxThreshold: ${before.toFixed(1)} -> ${p.indicators.adxThreshold.toFixed(1)}`;
  },
  (p, s) => {
    const keys = Object.keys(p.timeframeWeights);
    const key = keys[Math.floor(Math.random() * keys.length)];
    if (key === undefined) return "no timeframe weights to mutate";
    const before = p.timeframeWeights[key] ?? 1;
    p.timeframeWeights[key] = jitter(before, s, 0, 5);
    return `timeframeWeights.${key}: ${before.toFixed(2)} -> ${(p.timeframeWeights[key] as number).toFixed(2)}`;
  },
  (p) => {
    p.entry.requireElliottAgreement = !p.entry.requireElliottAgreement;
    return `entry.requireElliottAgreement -> ${p.entry.requireElliottAgreement}`;
  },
  (p) => {
    p.entry.requireGannAgreement = !p.entry.requireGannAgreement;
    return `entry.requireGannAgreement -> ${p.entry.requireGannAgreement}`;
  },
  (p) => {
    p.entry.avoidGannTimeCycle = !p.entry.avoidGannTimeCycle;
    return `entry.avoidGannTimeCycle -> ${p.entry.avoidGannTimeCycle}`;
  },
  (p) => {
    p.exit.useStructuralTargets = !p.exit.useStructuralTargets;
    return `exit.useStructuralTargets -> ${p.exit.useStructuralTargets}`;
  },
];

export interface MutationCandidate {
  name: string;
  hypothesis: string;
  changes: string[];
  params: StrategyParams;
}

/** Produce `count` mutated variants of `base`. */
export function mutateParams(
  base: StrategyParams,
  count: number,
  options: { scale?: number; changesPerCandidate?: number } = {},
): MutationCandidate[] {
  const { scale = 0.25, changesPerCandidate = 3 } = options;
  const out: MutationCandidate[] = [];

  for (let i = 0; i < count; i++) {
    const draft = structuredClone(base);
    const changes: string[] = [];
    const used = new Set<number>();
    const mutations = 1 + Math.floor(Math.random() * changesPerCandidate);

    for (let m = 0; m < mutations; m++) {
      let index = Math.floor(Math.random() * MUTATORS.length);
      // Don't apply the same mutator twice in one candidate.
      for (let guard = 0; used.has(index) && guard < MUTATORS.length; guard++) {
        index = (index + 1) % MUTATORS.length;
      }
      used.add(index);
      const mutator = MUTATORS[index];
      if (mutator) changes.push(mutator(draft, scale));
    }

    const { params, repairs } = sanitiseParams(draft);
    out.push({
      name: `random-${i + 1}`,
      hypothesis: "Random local perturbation (control group for the LLM proposals).",
      changes: [...changes, ...repairs.map((r) => `repair: ${r}`)],
      params,
    });
  }
  return out;
}
