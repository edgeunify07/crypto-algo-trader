"use client";

import { useState } from "react";
import type { CandleInterval } from "@/lib/types";
import type { BacktestResult } from "@/lib/backtest";
import AccountPanel from "./AccountPanel";
import ArenaPanel from "./ArenaPanel";

const fmt = (n: number, d = 2) => new Intl.NumberFormat("en-US", { minimumFractionDigits: d, maximumFractionDigits: d }).format(n);

export interface BotStatusFull {
  positions: { symbol: string; qty: number; entryPrice: number }[];
  events: { time: number; symbol: string; action: string; price: number; pnl?: number; reason?: string; mode: string; live: boolean }[];
  risk: { realizedPnlToday: number };
}

interface Props {
  symbol: string;
  interval: CandleInterval;
  strategyId: string;
  params: Record<string, number>;
  status: BotStatusFull | null;
  onUseStrategy: (id: string) => void;
}

type Tab = "arena" | "account" | "positions" | "log" | "backtest";

export default function BottomTabs(p: Props) {
  const [tab, setTab] = useState<Tab>("arena");
  const [result, setResult] = useState<BacktestResult | null>(null);
  const [running, setRunning] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const runBacktest = async () => {
    setRunning(true);
    setErr(null);
    try {
      const r = await fetch("/api/backtest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbol: p.symbol, interval: p.interval, strategyId: p.strategyId, params: p.params }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? "failed");
      setResult(j.result);
      setTab("backtest");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "failed");
    } finally {
      setRunning(false);
    }
  };

  const positions = p.status?.positions ?? [];
  const events = p.status?.events ?? [];

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-4 border-b border-line px-3">
        {(["arena", "account", "positions", "log", "backtest"] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`border-b-2 py-2 text-xs capitalize ${tab === t ? "border-accent text-text" : "border-transparent text-muted hover:text-text"}`}
          >
            {t === "log" ? "Execution Log" : t === "account" ? "Account (real)" : t === "positions" ? "Bot Positions" : t === "arena" ? "Compare Algos" : t}
            {t === "positions" && positions.length > 0 ? ` (${positions.length})` : ""}
          </button>
        ))}
        <button
          onClick={runBacktest}
          disabled={running}
          className="ml-auto rounded bg-accent px-3 py-1 text-xs font-semibold text-black hover:opacity-90 disabled:opacity-50"
        >
          {running ? "Running…" : "Run Backtest"}
        </button>
      </div>
      {err && <div className="px-3 py-1 text-[11px] text-down">{err}</div>}

      <div className="scroll-thin flex-1 overflow-auto nums text-xs">
        {tab === "arena" && <ArenaPanel symbol={p.symbol} interval={p.interval} onUseStrategy={p.onUseStrategy} />}

        {tab === "account" && <AccountPanel />}

        {tab === "positions" && (
          positions.length ? (
            <Table head={["Symbol", "Qty", "Entry", "P&L today"]}>
              {positions.map((pos) => (
                <tr key={pos.symbol} className="border-t border-line">
                  <Td>{pos.symbol}</Td>
                  <Td right>{fmt(pos.qty, 5)}</Td>
                  <Td right>${fmt(pos.entryPrice)}</Td>
                  <Td right cls={(p.status?.risk.realizedPnlToday ?? 0) >= 0 ? "text-up" : "text-down"}>
                    ${fmt(p.status?.risk.realizedPnlToday ?? 0)}
                  </Td>
                </tr>
              ))}
            </Table>
          ) : <Empty text="No open positions. Start the bot to trade." />
        )}

        {tab === "log" && (
          events.length ? (
            <Table head={["Time", "Action", "Symbol", "Price", "P&L"]}>
              {events.map((e, i) => (
                <tr key={i} className="border-t border-line">
                  <Td>{new Date(e.time * 1000).toLocaleTimeString("en-US", { hour12: false })}</Td>
                  <Td cls={e.action === "BUY" ? "text-up" : e.action === "SELL" ? "text-down" : "text-muted"}>
                    {e.action}{e.live ? " ·live" : ""}{e.reason ? ` (${e.reason})` : ""}
                  </Td>
                  <Td>{e.symbol}</Td>
                  <Td right>{e.price ? `$${fmt(e.price)}` : "—"}</Td>
                  <Td right cls={(e.pnl ?? 0) >= 0 ? "text-up" : "text-down"}>{e.pnl != null ? `$${fmt(e.pnl)}` : "—"}</Td>
                </tr>
              ))}
            </Table>
          ) : <Empty text="No executions yet." />
        )}

        {tab === "backtest" && (
          result ? <BacktestView r={result} /> : <Empty text="Run a backtest with the current strategy to see results." />
        )}
      </div>
    </div>
  );
}

function BacktestView({ r }: { r: BacktestResult }) {
  const cells = [
    ["Net Return", `${r.totalReturnPct.toFixed(2)}%`, r.totalReturnPct >= 0 ? "text-up" : "text-down"],
    ["Buy & Hold", `${r.buyHoldReturnPct.toFixed(2)}%`, ""],
    ["Max Drawdown", `-${r.maxDrawdownPct.toFixed(2)}%`, "text-down"],
    ["Trades", `${r.numTrades}`, ""],
    ["Win Rate", `${r.winRate.toFixed(1)}%`, ""],
    ["Fees", `$${fmt(r.totalFeesPaid)}`, "text-muted"],
    ["End Equity", `$${fmt(r.endEquity)}`, ""],
  ] as const;
  return (
    <div>
      <div className="grid grid-cols-3 gap-px bg-line sm:grid-cols-7">
        {cells.map(([label, val, cls]) => (
          <div key={label} className="bg-panel px-3 py-2">
            <div className="text-[10px] text-muted">{label}</div>
            <div className={`text-sm font-semibold ${cls}`}>{val}</div>
          </div>
        ))}
      </div>
      <Table head={["Entry", "Exit", "Return", "P&L"]}>
        {r.trades.map((t, i) => (
          <tr key={i} className="border-t border-line">
            <Td>{new Date(t.entryTime * 1000).toLocaleString()}</Td>
            <Td>{new Date(t.exitTime * 1000).toLocaleString()}</Td>
            <Td right cls={t.returnPct >= 0 ? "text-up" : "text-down"}>{t.returnPct.toFixed(2)}%</Td>
            <Td right cls={t.pnl >= 0 ? "text-up" : "text-down"}>${fmt(t.pnl)}</Td>
          </tr>
        ))}
      </Table>
    </div>
  );
}

function Table({ head, children }: { head: string[]; children: React.ReactNode }) {
  return (
    <table className="w-full text-left">
      <thead className="sticky top-0 bg-panel text-[10px] text-muted">
        <tr>{head.map((h, i) => <th key={h} className={`px-3 py-1.5 ${i > 0 ? "text-right" : ""}`}>{h}</th>)}</tr>
      </thead>
      <tbody>{children}</tbody>
    </table>
  );
}
function Td({ children, right, cls }: { children: React.ReactNode; right?: boolean; cls?: string }) {
  return <td className={`px-3 py-1 ${right ? "text-right" : ""} ${cls ?? "text-text"}`}>{children}</td>;
}
function Empty({ text }: { text: string }) {
  return <p className="px-3 py-6 text-center text-[11px] text-muted">{text}</p>;
}
