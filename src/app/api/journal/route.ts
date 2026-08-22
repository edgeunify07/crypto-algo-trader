import { NextRequest, NextResponse } from "next/server";
import { exportEventsCsv, getEvents, getEventsForSymbol } from "@/lib/executor";
import crypto from "node:crypto";

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const format = searchParams.get("format");
  const symbol = searchParams.get("symbol");
  const limit = Math.min(Number(searchParams.get("limit") ?? 200), 500);

  if (format === "json") {
    const events = symbol ? await getEventsForSymbol(symbol, limit) : await getEvents(limit);
    return NextResponse.json({ events, count: events.length });
  }

  const csv = await exportEventsCsv(limit);
  const configHash = crypto.createHash("sha256").update(csv.slice(0, 100)).digest("hex").slice(0, 12);
  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv",
      "Content-Disposition": `attachment; filename="unify-journal-${configHash}.csv"`,
      "X-Config-Hash": configHash,
    },
  });
}
