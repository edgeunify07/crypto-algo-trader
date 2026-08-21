// Minimal single-user auth for a personal production instance.
// Uses Web Crypto (HMAC-SHA256) so the same code runs in Edge middleware and
// Node route handlers. A signed, httpOnly cookie holds the session — no user
// DB needed for a one-person app.

export const SESSION_COOKIE = "unify_session";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

const enc = new TextEncoder();

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlToStr(s: string): string {
  const pad = s.length % 4 ? "=".repeat(4 - (s.length % 4)) : "";
  return atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
}

async function hmac(data: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(data));
  return b64url(new Uint8Array(sig));
}

/** Timing-safe string comparison. */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function authSecret(): string {
  // Stable secret required so sessions survive restarts. Falls back to the
  // password if unset (still private), or a constant dev value as last resort.
  return process.env.AUTH_SECRET || process.env.APP_PASSWORD || "unify-dev-secret-change-me";
}

export function appPassword(): string | null {
  const p = process.env.APP_PASSWORD;
  return p && p.length > 0 ? p : null;
}

/** True once the operator has set a password. Until then, the app fails closed. */
export function isAuthConfigured(): boolean {
  return appPassword() !== null;
}

export async function createSessionToken(): Promise<string> {
  const payload = b64url(enc.encode(JSON.stringify({ exp: Date.now() + SESSION_TTL_MS })));
  const sig = await hmac(payload, authSecret());
  return `${payload}.${sig}`;
}

export async function verifySessionToken(token: string | undefined): Promise<boolean> {
  if (!token || !token.includes(".")) return false;
  const [payload, sig] = token.split(".");
  const expected = await hmac(payload, authSecret());
  if (!safeEqual(sig, expected)) return false;
  try {
    const { exp } = JSON.parse(b64urlToStr(payload)) as { exp: number };
    return typeof exp === "number" && exp > Date.now();
  } catch {
    return false;
  }
}
