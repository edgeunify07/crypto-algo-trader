"use client";

import { useCallback, useEffect, useState } from "react";

const fmt = (n: number, d = 2) => new Intl.NumberFormat("en-US", { minimumFractionDigits: d, maximumFractionDigits: d }).format(n);

interface Balance { asset: string; free: number; locked: number; usdtValue: number }
interface Account { canTrade: boolean; balances: Balance[]; totalUsdt: number }
interface AccountResp { configured: boolean; account?: Account; error?: string; env?: string; live?: boolean; tradingEnabled?: boolean }
interface OpenOrder { symbol: string; orderId: number; side: string; type: string; price: string; origQty: string; executedQty: string; status: string }

export default function AccountPanel() {
  const [data, setData] = useState<AccountResp | null>(null);
  const [orders, setOrders] = useState<OpenOrder[]>([]);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/account");
      const j: AccountResp = await r.json();
      setData(j);
      if (j.configured) {
        const or = await fetch("/api/order");
        const oj = await or.json();
        if (oj.orders) setOrders(oj.orders as OpenOrder[]);
      }
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    load();
    const id = window.setInterval(load, 5000);
    return () => window.clearInterval(id);
  }, [load]);

  const cancel = async (symbol: string, orderId: number) => {
    await fetch(`/api/order?symbol=${symbol}&orderId=${orderId}`, { method: "DELETE" });
    load();
  };

  if (!data) return <Empty text="Loading account…" />;

  if (!data.configured) {
    return (
      <div className="p-4 text-xs leading-relaxed text-muted">
        <div className="mb-2 text-sm font-medium text-text">Connect your Binance account</div>
        No API keys detected. To show your <span className="text-text">real balances, positions and open orders</span>, add
        credentials to <code className="text-text">.env.local</code> and restart:
        <pre className="mt-2 rounded bg-panel2 p-3 text-[11px] text-text">{`BINANCE_ENV=testnet          # or "live" for real money
BINANCE_API_KEY=your_key
BINANCE_API_SECRET=your_secret`}</pre>
        <p className="mt-2">Testnet keys (fake money): <span className="text-accent">testnet.binance.vision</span>. For live, create keys in Binance → API Management with <span className="text-text">Spot trading only, withdrawals disabled, IP-restricted</span>.</p>
        <p className="mt-1">Current server: env <span className="text-text">{data.env}</span>.</p>
      </div>
    );
  }

  if (data.error) return <Empty text={`Account error: ${data.error}`} />;

  const acct = data.account!;
  return (
    <div className="nums text-xs">
      <div className="flex items-center justify-between border-b border-line px-3 py-2">
        <div>
          <span className="text-[10px] text-muted">Total value (real{data.live ? ", LIVE" : ", testnet"})</span>
          <div className="text-base font-semibold text-text">${fmt(acct.totalUsdt)}</div>
        </div>
        <span className={`rounded px-2 py-0.5 text-[10px] ${data.live ? "bg-down/20 text-down" : "bg-panel2 text-muted"}`}>
          {data.live ? "LIVE" : "TESTNET"} · {acct.canTrade ? "trading enabled" : "read-only"}
        </span>
      </div>

      <div className="px-1 pt-1 text-[10px] font-medium text-muted"><span className="px-2">Balances</span></div>
      <table className="w-full text-left">
        <thead className="text-[10px] text-muted"><tr><th className="px-3 py-1">Asset</th><th className="px-3 py-1 text-right">Free</th><th className="px-3 py-1 text-right">Locked</th><th className="px-3 py-1 text-right">≈ USDT</th></tr></thead>
        <tbody>
          {acct.balances.map((b) => (
            <tr key={b.asset} className="border-t border-line">
              <td className="px-3 py-1 text-text">{b.asset}</td>
              <td className="px-3 py-1 text-right text-text">{fmt(b.free, 6)}</td>
              <td className="px-3 py-1 text-right text-muted">{fmt(b.locked, 6)}</td>
              <td className="px-3 py-1 text-right text-text">{b.usdtValue ? `$${fmt(b.usdtValue)}` : "—"}</td>
            </tr>
          ))}
          {acct.balances.length === 0 && <tr><td colSpan={4} className="px-3 py-3 text-center text-muted">No balances.</td></tr>}
        </tbody>
      </table>

      <div className="px-1 pt-3 text-[10px] font-medium text-muted"><span className="px-2">Open orders ({orders.length})</span></div>
      <table className="w-full text-left">
        <thead className="text-[10px] text-muted"><tr><th className="px-3 py-1">Symbol</th><th className="px-3 py-1">Side</th><th className="px-3 py-1 text-right">Price</th><th className="px-3 py-1 text-right">Amount</th><th className="px-3 py-1 text-right"></th></tr></thead>
        <tbody>
          {orders.map((o) => (
            <tr key={o.orderId} className="border-t border-line">
              <td className="px-3 py-1 text-text">{o.symbol}</td>
              <td className={`px-3 py-1 ${o.side === "BUY" ? "text-up" : "text-down"}`}>{o.side}</td>
              <td className="px-3 py-1 text-right text-text">{fmt(Number(o.price))}</td>
              <td className="px-3 py-1 text-right text-text">{fmt(Number(o.origQty), 5)}</td>
              <td className="px-3 py-1 text-right"><button onClick={() => cancel(o.symbol, o.orderId)} className="text-muted hover:text-down">cancel</button></td>
            </tr>
          ))}
          {orders.length === 0 && <tr><td colSpan={5} className="px-3 py-3 text-center text-muted">No open orders.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return <p className="px-3 py-6 text-center text-[11px] text-muted">{text}</p>;
}
