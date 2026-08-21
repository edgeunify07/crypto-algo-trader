// Risk guard — a process-wide singleton that every order must pass through.
// This is the safety spine: hard limits + a kill switch that halts all trading.
// State lives in-memory (fine for a single personal instance; swap for a DB if
// you run multiple processes).

export interface RiskLimits {
  maxOrderNotionalUSDT: number; // largest single order allowed
  maxDailyLossUSDT: number; // stop trading once realized loss exceeds this
  maxOpenPositions: number; // concurrent symbols held
}

export const DEFAULT_LIMITS: RiskLimits = {
  maxOrderNotionalUSDT: 50,
  maxDailyLossUSDT: 100,
  maxOpenPositions: 3,
};

interface RiskState {
  limits: RiskLimits;
  killSwitch: boolean;
  realizedPnlToday: number;
  dayStamp: string; // YYYY-MM-DD to auto-reset daily counters
  openSymbols: Set<string>;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

// Persist across hot-reloads / route invocations in dev and in a running server.
const g = globalThis as unknown as { __riskState?: RiskState };
function state(): RiskState {
  if (!g.__riskState) {
    g.__riskState = {
      limits: { ...DEFAULT_LIMITS },
      killSwitch: false,
      realizedPnlToday: 0,
      dayStamp: today(),
      openSymbols: new Set(),
    };
  }
  const s = g.__riskState;
  if (s.dayStamp !== today()) {
    s.dayStamp = today();
    s.realizedPnlToday = 0;
  }
  return s;
}

export interface RiskDecision {
  ok: boolean;
  reason?: string;
}

export const RiskGuard = {
  status() {
    const s = state();
    return {
      killSwitch: s.killSwitch,
      limits: s.limits,
      realizedPnlToday: s.realizedPnlToday,
      openPositions: s.openSymbols.size,
      openSymbols: [...s.openSymbols],
    };
  },

  setLimits(limits: Partial<RiskLimits>) {
    const s = state();
    s.limits = { ...s.limits, ...limits };
  },

  tripKillSwitch(on = true) {
    state().killSwitch = on;
  },

  /** Called before placing a BUY (opening). */
  canOpen(symbol: string, notionalUSDT: number): RiskDecision {
    const s = state();
    if (s.killSwitch) return { ok: false, reason: "kill switch is engaged" };
    if (notionalUSDT > s.limits.maxOrderNotionalUSDT)
      return { ok: false, reason: `order ${notionalUSDT} > max ${s.limits.maxOrderNotionalUSDT} USDT` };
    if (s.realizedPnlToday <= -Math.abs(s.limits.maxDailyLossUSDT))
      return { ok: false, reason: "daily loss limit reached" };
    if (!s.openSymbols.has(symbol) && s.openSymbols.size >= s.limits.maxOpenPositions)
      return { ok: false, reason: "max open positions reached" };
    return { ok: true };
  },

  /** Called before placing a SELL (closing) — closing is allowed even under most limits. */
  canClose(): RiskDecision {
    const s = state();
    if (s.killSwitch) return { ok: false, reason: "kill switch is engaged" };
    return { ok: true };
  },

  markOpen(symbol: string) {
    state().openSymbols.add(symbol);
  },

  markClosed(symbol: string, realizedPnlUSDT: number) {
    const s = state();
    s.openSymbols.delete(symbol);
    s.realizedPnlToday += realizedPnlUSDT;
  },
};
