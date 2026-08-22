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
  maxOrderNotionalUSDT: 25,
  maxDailyLossUSDT: 5,
  maxOpenPositions: 2,
};

export const SMALL_ACCOUNT_LIMITS: RiskLimits = DEFAULT_LIMITS;

interface RiskState {
  limits: RiskLimits;
  killSwitch: boolean;
  killReason: string | null;
  realizedPnlToday: number;
  dayStamp: string;
  openSymbols: Set<string>;
  consecutiveLosses: number;
  peakEquity: number;
  currentEquity: number;
  lastHeartbeat: number;
  maxDrawdownPct: number;
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
      killReason: null,
      realizedPnlToday: 0,
      dayStamp: today(),
      openSymbols: new Set(),
      consecutiveLosses: 0,
      peakEquity: 100,
      currentEquity: 100,
      lastHeartbeat: Date.now(),
      maxDrawdownPct: 0,
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
      killReason: s.killReason,
      limits: s.limits,
      realizedPnlToday: s.realizedPnlToday,
      openPositions: s.openSymbols.size,
      openSymbols: [...s.openSymbols],
      consecutiveLosses: s.consecutiveLosses,
      maxDrawdownPct: s.maxDrawdownPct,
      lastHeartbeat: s.lastHeartbeat,
    };
  },

  heartbeat() {
    state().lastHeartbeat = Date.now();
  },

  checkStale(maxAgeMs = 120_000): RiskDecision {
    const s = state();
    if (Date.now() - s.lastHeartbeat > maxAgeMs) {
      s.killSwitch = true;
      s.killReason = "stale data — no heartbeat";
      return { ok: false, reason: s.killReason };
    }
    return { ok: true };
  },

  updateEquity(equity: number) {
    const s = state();
    s.currentEquity = equity;
    if (equity > s.peakEquity) s.peakEquity = equity;
    const dd = s.peakEquity > 0 ? ((s.peakEquity - equity) / s.peakEquity) * 100 : 0;
    if (dd > s.maxDrawdownPct) s.maxDrawdownPct = dd;
    if (dd >= 15) {
      s.killSwitch = true;
      s.killReason = `max drawdown ${dd.toFixed(1)}%`;
    }
  },

  tripKillSwitch(on = true, reason = "manual kill") {
    const s = state();
    s.killSwitch = on;
    s.killReason = on ? reason : null;
  },

  setLimits(limits: Partial<RiskLimits>) {
    const s = state();
    s.limits = { ...s.limits, ...limits };
  },

  /** Called before placing a BUY (opening). */
  canOpen(symbol: string, notionalUSDT: number): RiskDecision {
    const s = state();
    if (s.killSwitch) return { ok: false, reason: s.killReason ?? "kill switch is engaged" };
    if (s.consecutiveLosses >= 5) return { ok: false, reason: "max consecutive losses reached" };
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
    if (realizedPnlUSDT < 0) {
      s.consecutiveLosses++;
      if (s.consecutiveLosses >= 5) {
        s.killSwitch = true;
        s.killReason = "5 consecutive losses";
      }
    } else {
      s.consecutiveLosses = 0;
    }
  },
};
