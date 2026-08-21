"use client";

import type { CandleInterval } from "@/lib/types";

export interface StrategyMeta {
  id: string;
  name: string;
  description: string;
  params: Record<string, number>;
}

export interface BotStatusLite {
  running: boolean;
  risk: { killSwitch: boolean; limits: { maxOrderNotionalUSDT: number; maxDailyLossUSDT: number; maxOpenPositions: number } };
  server?: { env: string; live: boolean };
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

  const start = async () => {
    await post("/api/bot", {
      action: "start",
      config: { symbol: p.symbol, interval: p.interval, strategyId: p.strategyId, params: p.params, mode: p.mode, tradeNotionalUSDT: p.tradeNotional, pollMs: 4000 },
    });
    p.onChanged();
  };
  const stop = async () => { await post("/api/bot", { action: "stop" }); p.onChanged(); };
  const kill = async () => { await post("/api/risk", { killSwitch: !killed }); p.onChanged(); };
  const setLimit = async (k: string, v: number) => { await post("/api/risk", { limits: { [k]: v } }); p.onChanged(); };

  const cur = p.strategies.find((s) => s.id === p.strategyId);

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
        {cur && <p className="text-[11px] leading-snug text-muted">{cur.description}</p>}

        <div className="grid grid-cols-2 gap-2">
          {Object.entries(p.params).map(([k, v]) => (
            <label key={k} className="text-[10px] text-muted">
              {k}
              <input
                type="number"
                value={v}
                onChange={(e) => p.onParams({ ...p.params, [k]: Number(e.target.value) })}
                className="mt-0.5 w-full rounded bg-panel2 px-2 py-1 text-xs text-text outline-none nums"
              />
            </label>
          ))}
        </div>

        <label className="block text-[10px] text-muted">
          Order size (USDT)
          <input
            type="number"
            value={p.tradeNotional}
            onChange={(e) => p.onTradeNotional(Number(e.target.value))}
            className="mt-0.5 w-full rounded bg-panel2 px-2 py-1.5 text-xs text-text outline-none nums"
          />
        </label>

        <div className="grid grid-cols-2 gap-1 rounded bg-panel2 p-1">
          {(["paper", "live"] as const).map((m) => (
            <button
              key={m}
              onClick={() => p.onMode(m)}
              className={`rounded py-1 text-xs font-medium ${p.mode === m ? (m === "live" ? "bg-down/20 text-down" : "bg-up/20 text-up") : "text-muted"}`}
            >
              {m === "paper" ? "Paper" : "Live"}
            </button>
          ))}
        </div>
        {p.mode === "live" && !armed && (
          <p className="text-[10px] text-accent">Server not armed — still simulated until BINANCE_ENV=live + TRADING_ENABLED=true.</p>
        )}

        <div className="grid grid-cols-2 gap-2">
          {!running ? (
            <button onClick={start} className="rounded bg-up py-2 text-xs font-semibold text-black hover:opacity-90">Start Bot</button>
          ) : (
            <button onClick={stop} className="rounded bg-panel2 py-2 text-xs font-semibold text-text hover:bg-hover">Stop Bot</button>
          )}
          <button onClick={kill} className={`rounded py-2 text-xs font-bold ${killed ? "bg-accent text-black" : "bg-down text-white hover:opacity-90"}`}>
            {killed ? "Release Kill" : "KILL"}
          </button>
        </div>

        <div className="border-t border-line pt-2">
          <div className="mb-1 text-[10px] font-medium text-muted">Risk limits</div>
          {limits && ([
            ["maxOrderNotionalUSDT", "Max order $"],
            ["maxDailyLossUSDT", "Max daily loss $"],
            ["maxOpenPositions", "Max positions"],
          ] as const).map(([k, label]) => (
            <div key={k} className="mb-1 flex items-center justify-between gap-2">
              <span className="text-[10px] text-muted">{label}</span>
              <input
                type="number"
                defaultValue={limits[k]}
                onBlur={(e) => setLimit(k, Number(e.target.value))}
                className="w-20 rounded bg-panel2 px-2 py-0.5 text-right text-[11px] text-text outline-none nums"
              />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
