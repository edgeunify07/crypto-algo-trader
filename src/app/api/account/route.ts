import { NextResponse } from "next/server";
import { getAccount } from "@/lib/binance/trading";
import { getAllPrices, valueInUsdt } from "@/lib/binance/marketData";
import { configSummary, hasCredentials } from "@/lib/binance/config";

export async function GET() {
  if (!hasCredentials()) {
    return NextResponse.json({ configured: false, ...configSummary() });
  }
  try {
    const [account, prices] = await Promise.all([getAccount(), getAllPrices()]);
    const balances = account.balances
      .map((b) => {
        const usdtValue = valueInUsdt(b.asset, b.free + b.locked, prices);
        return { ...b, usdtValue };
      })
      .sort((a, b) => b.usdtValue - a.usdtValue);
    const totalUsdt = balances.reduce((sum, b) => sum + b.usdtValue, 0);
    return NextResponse.json({ configured: true, account: { canTrade: account.canTrade, balances, totalUsdt }, ...configSummary() });
  } catch (err) {
    return NextResponse.json(
      { configured: true, error: err instanceof Error ? err.message : "account fetch failed", ...configSummary() },
      { status: 502 },
    );
  }
}
