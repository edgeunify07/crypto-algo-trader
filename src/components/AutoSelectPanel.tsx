"use client";

import { useCallback, useEffect, useState } from "react";

interface GateCheck { id: string; label: string; pass: boolean; detail: string }
interface Metrics {
  numTrades: number; winRate: number; profitFactor: number; expectancy: number;
  totalReturnPct: number; buyHoldReturnPct: number; alphaPct: number;
  maxDrawdownPct: number; avgWinPct: number; avgLossPct: number;
}
interface Candidate {
  symbol: string; interval: string; strategyId: string; params: Record<string, number>;
  train: Metrics; oos: Metrics; gates: GateCheck[]; passed: boolean; score: number;
  bars: { train: number; test: number };
}
interface Run {
  startedAt: string; finishedAt: string;
  gates: { minOosTrades: number; minWinRatePct: number; minProfitFactor: number; maxDrawdownPct: number; mustBeatBuyHold: boolean };
  symbolsScanned: string[]; intervals: string[]; configsPerSymbol: number; totalBacktests: number;
  candidates: Candidate[]; best: Candidate | null;
  bestValidWinRate: { winRate: number; symbol: string; interval: string; numTrades: number } | null;
  notes: string[];
}

const pct = (n: number, d = 2) => `${n >= 0 ? "" : ""}${n.toFixed(d)}%`;

export default function AutoSelectPanel({ onApplied }: { onApplied?: () => void }) {
  const [run, setRun] = useState<Run | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [winRateFloor, setWinRateFloor] = useState(0);
  const [universeLimit, setUniverseLimit] = useState(20);

  useEffect(() => {
    fetch("/api/autoselect").then((r) => r.json()).then((j) => { if (j.run) setRun(j.run); }).catch(() => {});
  }, []);

  const scan = useCallback(async (apply: boolean) => {
    setBusy(apply ? "applying" : "scanning");
    setErr(null); setMsg(null);
    try {
      const r = await fetch("/api/autoselect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          universeLimit, intervals: ["15m"], gridSize: "small",
          gates: { minWinRatePct: winRateFloor }, apply, mode: "paper", tradeNotionalUSDT: 25,
        }),
      });
      const j = await r.json();
      if (j.run) setRun(j.run);
      if (!r.ok) { setErr(j.error ?? "failed"); return; }
      if (j.applied) { setMsg(`Bot started on ${j.appliedTo.symbol} ${j.appliedTo.interval} (paper)`); onApplied?.(); }
    } catch (e) {
      setErr(e instanceof Error ? e.message : "failed");
    } finally { setBusy(null); }
  }, [winRateFloor, universeLimit, onApplied]);

  const passing = run?.candidates.filter((c) => c.passed) ?? [];

  return (
    <div className="nums text-xs">
      <div className="flex flex-wrap items-center gap-3 border-b border-line px-3 py-2">
        <span className="text-[11px] font-medium text-muted">Auto-Select · train/test split · live exit policy</span>
        <label className="flex items-center gap-1 text-[10px] text-muted">
          Win-rate floor
          <input type="number" value={winRateFloor} onChange={(e) => setWinRateFloor(Number(e.target.value))}
            className="w-14 rounded bg-panel2 px-1.5 py-0.5 text-right text-text outline-none" />%
        </label>
        <label className="flex items-center gap-1 text-[10px] text-muted">
          Symbols
          <input type="number" value={universeLimit} onChange={(e) => setUniverseLimit(Number(e.target.value))}
            className="w-14 rounded bg-panel2 px-1.5 py-0.5 text-right text-text outline-none" />
        </label>
        <button onClick={() => scan(false)} disabled={!!busy}
          className="rounded bg-panel2 px-3 py-1 text-[11px] text-text hover:bg-hover disabled:opacity-50">
          {busy === "scanning" ? "Scanning…" : "Scan"}
        </button>
        <button onClick={() => scan(true)} disabled={!!busy}
          className="rounded bg-accent px-3 py-1 text-[11px] font-semibold text-black hover:opacity-90 disabled:opacity-50">
          {busy === "applying" ? "Working…" : "Scan + trade winner (paper)"}
        </button>
      </div>

      {err && <div className="border-b border-line bg-down/10 px-3 py-2 text-[11px] text-down">{err}</div>}
      {msg && <div className="border-b border-line bg-up/10 px-3 py-2 text-[11px] text-up">{msg}</div>}

      {!run && !busy && <p className="px-3 py-6 text-center text-[11px] text-muted">Run a scan to rank configurations by out-of-sample performance.</p>}
      {busy && !run && <p className="px-3 py-6 text-center text-[11px] text-muted">Scanning the universe — this runs hundreds of real backtests.</p>}

      {run && (
        <>
          <div className="grid grid-cols-2 gap-px bg-line sm:grid-cols-5">
            <Cell label="Passing gates" value={`${passing.length}`} tone={passing.length ? "up" : "down"} />
            <Cell label="Candidates" value={`${run.candidates.length}`} />
            <Cell label="Backtests run" value={`${run.totalBacktests}`} />
            <Cell label="Symbols" value={`${run.symbolsScanned.length}`} />
            <Cell
              label={`Best WR (>=${run.gates.minOosTrades} OOS trades)`}
              value={run.bestValidWinRate ? `${run.bestValidWinRate.winRate.toFixed(1)}%` : "none"}
              tone={run.bestValidWinRate ? undefined : "down"}
            />
          </div>

          {!passing.length && (
            <div className="border-y border-down/30 bg-down/10 px-3 py-2 text-[11px] text-down">
              No configuration passed the out-of-sample gates. The bot will not be started — trading nothing is the
              correct outcome here, not picking the least-bad option.
            </div>
          )}

          <table className="w-full text-left">
            <thead className="text-[10px] text-muted">
              <tr>
                <th className="px-3 py-1.5">Symbol</th>
                <th className="px-3 py-1.5">TF</th>
                <th className="px-3 py-1.5 text-right">OOS n</th>
                <th className="px-3 py-1.5 text-right">OOS WR</th>
                <th className="px-3 py-1.5 text-right">Exp/trade</th>
                <th className="px-3 py-1.5 text-right">Return</th>
                <th className="px-3 py-1.5 text-right">Buy&amp;Hold</th>
                <th className="px-3 py-1.5 text-right">Alpha</th>
                <th className="px-3 py-1.5 text-right">Max DD</th>
                <th className="px-3 py-1.5">Failed gates</th>
              </tr>
            </thead>
            <tbody>
              {run.candidates.map((c) => (
                <tr key={`${c.symbol}-${c.interval}`} className={`border-t border-line ${c.passed ? "bg-up/5" : ""}`}>
                  <td className="px-3 py-1 text-text">{c.symbol}</td>
                  <td className="px-3 py-1 text-muted">{c.interval}</td>
                  <td className="px-3 py-1 text-right text-text">{c.oos.numTrades}</td>
                  <td className="px-3 py-1 text-right text-text">{c.oos.winRate.toFixed(0)}%</td>
                  <td className={`px-3 py-1 text-right ${c.oos.expectancy >= 0 ? "text-up" : "text-down"}`}>${c.oos.expectancy.toFixed(2)}</td>
                  <td className={`px-3 py-1 text-right ${c.oos.totalReturnPct >= 0 ? "text-up" : "text-down"}`}>{pct(c.oos.totalReturnPct)}</td>
                  <td className="px-3 py-1 text-right text-muted">{pct(c.oos.buyHoldReturnPct)}</td>
                  <td className={`px-3 py-1 text-right ${c.oos.alphaPct >= 0 ? "text-up" : "text-down"}`}>{pct(c.oos.alphaPct)}</td>
                  <td className="px-3 py-1 text-right text-down">{c.oos.maxDrawdownPct.toFixed(1)}%</td>
                  <td className="px-3 py-1 text-[10px] text-muted">
                    {c.passed ? <span className="text-up">PASS</span> : c.gates.filter((g) => !g.pass).map((g) => g.id).join(", ")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {run.notes.length > 0 && (
            <div className="border-t border-line px-3 py-2 text-[10px] leading-relaxed text-muted">
              {run.notes.slice(0, 6).map((n, i) => <div key={i}>· {n}</div>)}
            </div>
          )}
          <p className="px-3 pb-3 text-[10px] leading-relaxed text-muted">
            Parameters are fit on the first 70% of history and scored once on the untouched last 30%.
            Backtests model the same ATR stop / take-profit the live bot uses. Win rate is reported, not optimised —
            a high win rate with poor reward:risk still loses money after the 0.30% round-trip cost.
          </p>
        </>
      )}
    </div>
  );
}

function Cell({ label, value, tone }: { label: string; value: string; tone?: "up" | "down" }) {
  const cls = tone === "up" ? "text-up" : tone === "down" ? "text-down" : "text-text";
  return (
    <div className="bg-panel px-3 py-2">
      <div className="text-[10px] text-muted">{label}</div>
      <div className={`text-sm font-semibold ${cls}`}>{value}</div>
    </div>
  );
}
