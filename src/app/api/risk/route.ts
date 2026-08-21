import { NextRequest, NextResponse } from "next/server";
import { RiskGuard, type RiskLimits } from "@/lib/risk";

export async function GET() {
  return NextResponse.json(RiskGuard.status());
}

export async function POST(req: NextRequest) {
  let body: { killSwitch?: boolean; limits?: Partial<RiskLimits> };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  if (typeof body.killSwitch === "boolean") RiskGuard.tripKillSwitch(body.killSwitch);
  if (body.limits) RiskGuard.setLimits(body.limits);
  return NextResponse.json(RiskGuard.status());
}
