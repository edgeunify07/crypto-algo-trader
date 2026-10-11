import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE, verifySessionToken } from "@/lib/auth";

// Public paths that never require a session.
function isPublic(pathname: string): boolean {
  return (
    pathname === "/login" ||
    pathname.startsWith("/api/auth/") ||
    pathname.startsWith("/_next/") ||
    pathname === "/manifest.webmanifest" ||
    pathname === "/api/v2/health" ||
    pathname === "/favicon.ico"
  );
}

/**
 * An external scheduler has no session cookie, so it authenticates with the
 * shared secret instead. Without this the cron that keeps the loop running
 * while nobody has the app open would simply get a 401.
 */
function hasSchedulerSecret(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET ?? "";
  if (!secret) return false;
  return (
    req.headers.get("authorization") === `Bearer ${secret}` ||
    req.nextUrl.searchParams.get("secret") === secret
  );
}

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (isPublic(pathname)) return NextResponse.next();

  // Auth is opt-in. With no password configured the deployment is open, which
  // is the zero-friction path for a private PWA on your own phone; set
  // AUTH_PASSWORD to turn the login gate back on.
  if (!process.env.AUTH_PASSWORD) return NextResponse.next();

  if (pathname.startsWith("/api/v2/") && hasSchedulerSecret(req)) {
    return NextResponse.next();
  }

  const token = req.cookies.get(SESSION_COOKIE)?.value;
  const valid = await verifySessionToken(token);
  if (valid) return NextResponse.next();

  // Not authenticated: 401 for API, redirect to /login for pages.
  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.searchParams.set("from", pathname);
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)"],
};
