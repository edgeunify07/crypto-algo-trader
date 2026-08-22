"use client";

import { useEffect, useState } from "react";
import type { CandleInterval } from "@/lib/types";
import { INDICATOR_TOGGLES, PARAM_GROUPS } from "@/lib/strategies/indicatorToggles";

export interface StrategyMeta {
  id: string;
  name: string;
  description: string;
  params: Record<string, number>;
}

export interface BotStatusLite {
  running: boolean;
  risk: {
    killSwitch: boolean;
    killReason?: string | null;
    limits: { maxOrderNotionalUSDT: number; maxDailyLossUSDT: number; maxOpenPositions: number };
    consecutiveLosses?: number;
  };
  server?: { env: string; live: boolean };
  config?: { symbol?: string; interval?: string; mode?: string; strategyId?: string; tradeNotionalUSDT?: number; universeMode?: boolean } | null;
  watchlist?: string[];
  bestCandidate?: { symbol: string; score: number; reason?: string } | null;
}

interface Props {
  symbol: string;
  interval: CandleInterval;
  strategies: StrategyMeta[];
  strategyId: string;
  onStrategy: (id: string) => void;
  params: Record<string, number>;
  onParams: (p: Record<string, number>) => void;
  mode: "paper" | "live";
  onMode: (m: "paper" | "live") => void;
  tradeNotional: number;
  onTradeNotional: (n: number) => void;
  status: BotStatusLite | null;
  onChanged: () => void;
}

async function post(url: string, body: unknown) {
  return fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());
}

export default function TradePanel(p: Props) {
  const running = p.status?.running ?? false;
  const killed = p.status?.risk.killSwitch ?? false;
  const armed = p.status?.server?.live ?? false;
  const limits = p.status?.risk.limits;
  const [promotion, setPromotion] = useState<{ ready: boolean; criteria: { label: string; pass: boolean; detail: string }[] } | null>(null);
  const [minNotionalWarn, setMinNotionalWarn] = useState<string | null>(null);
  const [riskPct, setRiskPct] = useState(2);
  const [stopAtrMult, setStopAtrMult] = useState(2);
  const [botMsg, setBotMsg] = useState<string | null>(null);
  const [botErr, setBotErr] = useState<string | null>(null);
  const [universeMode, setUniverseMode] = useState(true);

  useEffect(() => {
    fetch(`/api/promotion?symbol=${p.symbol}&equity=100&riskPct=${riskPct}`)
      .then((r) => r.json())
      .then((j) => {
        setPromotion(j.gate ?? null);
        setMinNotionalWarn(j.minNotionalWarning ?? null);
      })
      .catch(() => {});
  }, [p.symbol, riskPct, p.status?.running]);

  const start = async () => {
    if (!p.strategyId) {
      setBotErr("Pick a strategy before starting the bot.");
      return;
    }
    setBotErr(null);
    setBotMsg(null);
    const res = await fetch("/api/bot", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "start",
        config: {
          symbol: p.symbol, interval: p.interval, strategyId: p.strategyId, params: p.params,
          mode: p.mode, tradeNotionalUSDT: p.tradeNotional, pollMs: 5000, stopLossAtrMult: stopAtrMult,
          universeMode,
          universeLimit: 20,
        },
      }),
    });
    const j = await res.json();
    if (!res.ok) {
      setBotErr(j.error ?? "Failed to start bot");
      return;
    }
    setBotMsg(
      universeMode
        ? `Bot scanning top markets · picks best trade · check Execution Log`
        : `Bot running on ${p.symbol} ${p.interval} only`,
    );
    p.onChanged();
  };
  const stop = async () => {
    setBotErr(null);
    const res = await fetch("/api/bot", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "stop" }) });
    const j = await res.json();
    if (!res.ok) setBotErr(j.error ?? "Failed to stop");
    else setBotMsg("Bot stopped");
    p.onChanged();
  };
  const kill = async () => { await post("/api/risk", { killSwitch: !killed }); p.onChanged(); };
  const setLimit = async (k: string, v: number) => { await post("/api/risk", { limits: { [k]: v } }); p.onChanged(); };

  const cur = p.strategies.find((s) => s.id === p.strategyId);
  const liveBlocked = p.mode === "live" && !promotion?.ready;

  return (
    <div className="flex h-full flex-col overflow-auto scroll-thin">
      <div className="border-b border-line px-3 py-2 text-[11px] font-medium text-muted">Strategy Engine</div>
      <div className="space-y-3 p-3">
        <select
          value={p.strategyId}
          onChange={(e) => {
            p.onStrategy(e.target.value);
            const s = p.strategies.find((x) => x.id === e.target.value);
            if (s) p.onParams(s.params);
          }}
          className="w-full rounded bg-panel2 px-2 py-1.5 text-xs text-text outline-none"
        >
          {p.strategies.map((s) => (
            <option key={s.id} value={s.id}>{s.name}</option>
          ))}
        </select>
        {cur && (
          <p className="text-[11px] leading-snug text-muted">
            <span className="font-medium text-text">{cur.name}</span>
            {" · "}id <span className="nums text-accent">{p.strategyId}</span>
            {" · "}mode {p.params.mode >= 1 ? "scalp" : "swing"}
            <br />{cur.description}
          </p>
        )}

        <label className="flex cursor-pointer items-center gap-2 rounded border border-line px-2 py-1.5 text-[10px] text-text">
          <input type="checkbox" checked={universeMode} onChange={(e) => setUniverseMode(e.target.checked)} />
          <span>
            <span className="font-medium">Scan all markets</span>
            <span className="block text-muted">Rank top 20 USDT pairs and only take the best high-confidence BUY</span>
          </span>
        </label>
        {running && p.status?.config?.strategyId && p.status.config.strategyId !== p.strategyId && (
          <p className="rounded border border-accent/40 bg-accent/10 px-2 py-1 text-[10px] text-accent">
            Bot still runs <strong>{p.status.config.strategyId}</strong>. Stop → Start to apply <strong>{p.strategyId}</strong>.
          </p>
        )}

        <div className="space-y-2 rounded border border-line p-2">
          <div className="text-[10px] font-medium text-muted">Indicators (toggle on/off)</div>
          <div className="grid grid-cols-2 gap-1">
            {Object.entries(INDICATOR_TOGGLES).map(([k, label]) => (
              <label key={k} className="flex cursor-pointer items-center gap-1.5 text-[10px] text-text">
                <input
                  type="checkbox"
                  checked={(p.params[k] ?? 1) >= 1}
                  onChange={(e) => p.onParams({ ...p.params, [k]: e.target.checked ? 1 : 0 })}
                  className="rounded"
                />
                {label}
              </label>
            ))}
          </div>
        </div>

        {([
          ["Trend", PARAM_GROUPS.trend],
          ["Momentum", PARAM_GROUPS.momentum],
          ["Regime & entry", PARAM_GROUPS.regime],
          ["Risk (scalp)", PARAM_GROUPS.risk],
        ] as const).map(([title, keys]) => {
          const visible = keys.filter((k) => k in p.params);
          if (!visible.length) return null;
          return (
            <div key={title} className="space-y-1">
              <div className="text-[10px] font-medium text-muted">{title}</div>
              <div className="grid grid-cols-2 gap-2">
                {visible.map((k) => (
                  <label key={k} className="text-[10px] text-muted">
                    {k}
                    <input
                      type="number"
                      value={p.params[k]}
                      onChange={(e) => p.onParams({ ...p.params, [k]: Number(e.target.value) })}
                      className="mt-0.5 w-full rounded bg-panel2 px-2 py-1 text-xs text-text outline-none nums"
                    />
                  </label>
                ))}
              </div>
            </div>
          );
        })}

        <details className="text-[10px] text-muted">
          <summary className="cursor-pointer font-medium">Factor weights (advanced)</summary>
          <div className="mt-2 grid grid-cols-2 gap-2">
            {PARAM_GROUPS.weights.filter((k) => k in p.params).map((k) => (
              <label key={k} className="text-[10px] text-muted">
                {k}
                <input
                  type="number"
                  value={p.params[k]}
                  onChange={(e) => p.onParams({ ...p.params, [k]: Number(e.target.value) })}
                  className="mt-0.5 w-full rounded bg-panel2 px-2 py-1 text-xs text-text outline-none nums"
                />
              </label>
            ))}
          </div>
        </details>

        <label className="block text-[10px] text-muted">
          Order size (USDT) — $100 profile default ~$25 max
          <input type="number" value={p.tradeNotional} onChange={(e) => p.onTradeNotional(Number(e.target.value))}
            className="mt-0.5 w-full rounded bg-panel2 px-2 py-1.5 text-xs text-text outline-none nums" />
        </label>

        <label className="block text-[10px] text-muted">
          Risk per trade (% of equity)
          <input type="number" value={riskPct} onChange={(e) => setRiskPct(Number(e.target.value))}
            className="mt-0.5 w-full rounded bg-panel2 px-2 py-1 text-xs text-text outline-none nums" />
        </label>

        <label className="block text-[10px] text-muted">
          Stop loss (ATR × mult)
          <input type="number" value={stopAtrMult} onChange={(e) => setStopAtrMult(Number(e.target.value))}
            className="mt-0.5 w-full rounded bg-panel2 px-2 py-1 text-xs text-text outline-none nums" />
        </label>

        {minNotionalWarn && <p className="text-[10px] text-accent">{minNotionalWarn}</p>}

        <div className="grid grid-cols-2 gap-1 rounded bg-panel2 p-1">
          {(["paper", "live"] as const).map((m) => (
            <button key={m} onClick={() => !liveBlocked || m === "paper" ? p.onMode(m) : undefined}
              disabled={m === "live" && liveBlocked}
              className={`rounded py-1 text-xs font-medium ${p.mode === m ? (m === "live" ? "bg-down/20 text-down" : "bg-up/20 text-up") : "text-muted"} ${m === "live" && liveBlocked ? "opacity-40" : ""}`}>
              {m === "paper" ? "Paper" : "Live"}
            </button>
          ))}
        </div>

        {promotion && (
          <div className="rounded border border-line p-2 text-[10px]">
            <div className="mb-1 font-medium text-muted">Promotion gate {promotion.ready ? "✓" : "✗"}</div>
            {promotion.criteria.map((c) => (
              <div key={c.label} className={c.pass ? "text-up" : "text-muted"}>{c.pass ? "✓" : "○"} {c.label} — {c.detail}</div>
            ))}
          </div>
        )}

        {p.mode === "live" && !armed && (
          <p className="text-[10px] text-accent">Server not armed — BINANCE_ENV=live + TRADING_ENABLED=true required.</p>
        )}

        {botErr && <p className="text-[10px] text-down">{botErr}</p>}
        {botMsg && <p className="text-[10px] text-up">{botMsg}</p>}

        <div className="grid grid-cols-2 gap-2">
          {!running ? (
            <button
              onClick={start}
              disabled={!p.strategyId || killed}
              className="rounded bg-up py-2 text-xs font-semibold text-black hover:opacity-90 disabled:opacity-40"
            >
              Start Bot
            </button>
          ) : (
            <button onClick={stop} className="rounded bg-panel2 py-2 text-xs font-semibold text-text hover:bg-hover">Stop Bot</button>
          )}
          <button onClick={kill} className={`rounded py-2 text-xs font-bold ${killed ? "bg-accent text-black" : "bg-down text-white hover:opacity-90"}`}>
            {killed ? "Release Kill" : "KILL"}
          </button>
        </div>
        {p.status?.risk.killReason && <p className="text-[10px] text-down">Halt: {p.status.risk.killReason}</p>}

        <div className="border-t border-line pt-2">
          <div className="mb-1 text-[10px] font-medium text-muted">Risk limits ($100 profile)</div>
          {limits && ([
            ["maxOrderNotionalUSDT", "Max order $"],
            ["maxDailyLossUSDT", "Max daily loss $"],
            ["maxOpenPositions", "Max positions"],
          ] as const).map(([k, label]) => (
            <div key={k} className="mb-1 flex items-center justify-between gap-2">
              <span className="text-[10px] text-muted">{label}</span>
              <input type="number" defaultValue={limits[k]} onBlur={(e) => setLimit(k, Number(e.target.value))}
                className="w-20 rounded bg-panel2 px-2 py-0.5 text-right text-[11px] text-text outline-none nums" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
