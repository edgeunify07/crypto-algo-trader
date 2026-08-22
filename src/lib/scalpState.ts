/** Last scalp backtest metadata — used by promotion gate (§4.6). */
interface ScalpGateState {
  klineOnly: boolean;
  makerFillRatio: number;
  strategyId: string | null;
}

const g = globalThis as unknown as { __scalpGate?: ScalpGateState };
function state(): ScalpGateState {
  if (!g.__scalpGate) g.__scalpGate = { klineOnly: true, makerFillRatio: 0, strategyId: null };
  return g.__scalpGate;
}

export function setScalpBacktestMeta(meta: { klineOnly: boolean; makerFillRatio: number; strategyId: string }) {
  const s = state();
  s.klineOnly = meta.klineOnly;
  s.makerFillRatio = meta.makerFillRatio;
  s.strategyId = meta.strategyId;
}

export function getScalpBacktestMeta(): ScalpGateState {
  return { ...state() };
}

/** Bot runtime maker fill tracking. */
interface MakerStats {
  maker: number;
  taker: number;
}

const g2 = globalThis as unknown as { __makerStats?: MakerStats };
export function recordMakerFill(maker: boolean) {
  if (!g2.__makerStats) g2.__makerStats = { maker: 0, taker: 0 };
  if (maker) g2.__makerStats.maker++;
  else g2.__makerStats.taker++;
}

export function makerFillRatio(): number {
  const s = g2.__makerStats;
  if (!s) return 1;
  const total = s.maker + s.taker;
  return total > 0 ? s.maker / total : 1;
}

export function resetMakerStats() {
  g2.__makerStats = { maker: 0, taker: 0 };
}
