import { NextRequest, NextResponse } from "next/server";
import { appPassword, createSessionToken, isAuthConfigured, SESSION_COOKIE, safeEqual } from "@/lib/auth";

export async function POST(req: NextRequest) {
  if (!isAuthConfigured()) {
    return NextResponse.json(
      { error: "Auth not configured. Set APP_PASSWORD in .env.local before logging in." },
      { status: 503 },
    );
  }

  let body: { password?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }

  const expected = appPassword() ?? "";
  const given = body.password ?? "";
  if (!given || !safeEqual(given, expected)) {
    return NextResponse.json({ error: "Incorrect password" }, { status: 401 });
  }

  const token = await createSessionToken();
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 7 * 24 * 60 * 60,
  });
  return res;
}
