"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const r = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? "login failed");
      router.replace(params.get("from") || "/");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "login failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <form onSubmit={submit} className="w-full max-w-sm rounded-lg border border-line bg-panel p-6">
      <div className="mb-1 flex items-center gap-2">
        <span className="text-lg font-bold text-accent">◆ UNIFY</span>
      </div>
      <p className="mb-6 text-sm text-muted">Sign in to your trading terminal.</p>
      <label className="block text-xs text-muted">
        Password
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoFocus
          className="mt-1 w-full rounded bg-panel2 px-3 py-2 text-sm text-text outline-none focus:ring-1 focus:ring-accent"
          placeholder="Enter password"
        />
      </label>
      {error && <p className="mt-3 text-xs text-down">{error}</p>}
      <button
        type="submit"
        disabled={loading || !password}
        className="mt-5 w-full rounded bg-accent py-2 text-sm font-semibold text-black hover:opacity-90 disabled:opacity-50"
      >
        {loading ? "Signing in…" : "Sign in"}
      </button>
      <p className="mt-4 text-[11px] leading-snug text-muted">
        Single-user access. Set <code className="text-text">APP_PASSWORD</code> in{" "}
        <code className="text-text">.env.local</code> to configure. Bind the server to{" "}
        <code className="text-text">127.0.0.1</code> or put it behind a VPN/firewall for real-money use.
      </p>
    </form>
  );
}

export default function LoginPage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-bg px-4">
      <Suspense fallback={null}>
        <LoginForm />
      </Suspense>
    </main>
  );
}
