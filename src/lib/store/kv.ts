import { Redis } from "@upstash/redis";

/**
 * Key-value persistence for serverless.
 *
 * This exists because the previous design wrote state to `process.cwd()/.data`,
 * which silently fails on Vercel: the filesystem is read-only outside `/tmp`,
 * and `/tmp` is per-instance and discarded. Bot state and trade history
 * vanished between invocations, so the UI rendered empty values that looked
 * like placeholder data. Everything durable now goes through this module.
 *
 * Upstash is used over its REST API rather than a TCP client, because a
 * serverless function cannot hold a connection pool across invocations.
 *
 * When Upstash is not configured the store falls back to an in-process map so
 * `next dev` and tests work with no external dependency. That fallback is
 * explicitly NOT durable, and `isDurable` reports which mode is active so the
 * UI can warn instead of quietly pretending state is being saved.
 */

export interface KvStore {
  readonly isDurable: boolean;
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T, ttlSeconds?: number): Promise<void>;
  del(key: string): Promise<void>;
  /** Append to a capped list, newest last. Returns the new length. */
  push<T>(key: string, value: T, cap?: number): Promise<number>;
  /** Read a list, newest last. */
  list<T>(key: string, limit?: number): Promise<T[]>;
  /** Atomic compare-and-set used as a tick lock. */
  acquireLock(key: string, ttlSeconds: number): Promise<boolean>;
  releaseLock(key: string): Promise<void>;
}

class UpstashStore implements KvStore {
  readonly isDurable = true;
  constructor(private readonly redis: Redis) {}

  async get<T>(key: string): Promise<T | null> {
    // The Upstash client already JSON-decodes values it stored as JSON.
    return (await this.redis.get<T>(key)) ?? null;
  }

  async set<T>(key: string, value: T, ttlSeconds?: number): Promise<void> {
    if (ttlSeconds && ttlSeconds > 0) {
      await this.redis.set(key, value, { ex: Math.ceil(ttlSeconds) });
    } else {
      await this.redis.set(key, value);
    }
  }

  async del(key: string): Promise<void> {
    await this.redis.del(key);
  }

  async push<T>(key: string, value: T, cap = 500): Promise<number> {
    const length = await this.redis.rpush(key, value as never);
    if (length > cap) {
      // Keep the newest `cap` entries.
      await this.redis.ltrim(key, -cap, -1);
      return cap;
    }
    return length;
  }

  async list<T>(key: string, limit = 500): Promise<T[]> {
    return (await this.redis.lrange<T>(key, -limit, -1)) ?? [];
  }

  async acquireLock(key: string, ttlSeconds: number): Promise<boolean> {
    // NX + EX is atomic, so two concurrent ticks cannot both proceed.
    const result = await this.redis.set(key, Date.now(), {
      nx: true,
      ex: Math.ceil(ttlSeconds),
    });
    return result === "OK";
  }

  async releaseLock(key: string): Promise<void> {
    await this.redis.del(key);
  }
}

interface MemoryEntry {
  value: unknown;
  expiresAt: number | null;
}

class MemoryStore implements KvStore {
  readonly isDurable = false;
  private readonly data = new Map<string, MemoryEntry>();

  private live(key: string): MemoryEntry | null {
    const entry = this.data.get(key);
    if (!entry) return null;
    if (entry.expiresAt !== null && entry.expiresAt < Date.now()) {
      this.data.delete(key);
      return null;
    }
    return entry;
  }

  async get<T>(key: string): Promise<T | null> {
    const entry = this.live(key);
    return entry ? (structuredClone(entry.value) as T) : null;
  }

  async set<T>(key: string, value: T, ttlSeconds?: number): Promise<void> {
    this.data.set(key, {
      value: structuredClone(value),
      expiresAt: ttlSeconds && ttlSeconds > 0 ? Date.now() + ttlSeconds * 1000 : null,
    });
  }

  async del(key: string): Promise<void> {
    this.data.delete(key);
  }

  async push<T>(key: string, value: T, cap = 500): Promise<number> {
    const existing = (await this.get<T[]>(key)) ?? [];
    existing.push(value);
    const trimmed = existing.slice(-cap);
    await this.set(key, trimmed);
    return trimmed.length;
  }

  async list<T>(key: string, limit = 500): Promise<T[]> {
    const existing = (await this.get<T[]>(key)) ?? [];
    return existing.slice(-limit);
  }

  async acquireLock(key: string, ttlSeconds: number): Promise<boolean> {
    if (this.live(key)) return false;
    await this.set(key, Date.now(), ttlSeconds);
    return true;
  }

  async releaseLock(key: string): Promise<void> {
    this.data.delete(key);
  }
}

/**
 * The singleton is parked on `globalThis` rather than in a module variable.
 *
 * A module-level `let` is not actually a singleton: Next's dev server reloads
 * modules on HMR, and a module imported through two different specifiers can
 * be instantiated twice. Either case gives you two MemoryStores, and state
 * written through one is invisible to the other — which looks exactly like the
 * "data keeps resetting" bug this whole layer exists to fix. With Upstash
 * configured the store is external so it would not matter, but the fallback
 * has to behave the same way or local testing lies about production.
 */
const GLOBAL_KEY = Symbol.for("algo.kv.store");

type GlobalWithStore = typeof globalThis & { [GLOBAL_KEY]?: KvStore };

export function kv(): KvStore {
  const g = globalThis as GlobalWithStore;
  const existing = g[GLOBAL_KEY];
  if (existing) return existing;

  const url =
    process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL ?? "";
  const token =
    process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN ?? "";

  const store: KvStore =
    url && token ? new UpstashStore(new Redis({ url, token })) : new MemoryStore();

  g[GLOBAL_KEY] = store;
  return store;
}

/** Test seam: swap the store, or pass null to force a rebuild on next access. */
export function __setStore(next: KvStore | null): void {
  const g = globalThis as GlobalWithStore;
  if (next === null) delete g[GLOBAL_KEY];
  else g[GLOBAL_KEY] = next;
}

export const KEYS = {
  account: "algo:account",
  positions: "algo:positions",
  trades: "algo:trades",
  equity: "algo:equity",
  params: "algo:params",
  paramsHistory: "algo:params:history",
  universe: "algo:universe",
  screener: "algo:screener",
  tickLog: "algo:ticks",
  tickLock: "algo:lock:tick",
  improveLock: "algo:lock:improve",
  /** Fixed-window allowance for unauthenticated ticks; see `guard.ts`. */
  publicTick: "algo:lock:public-tick",
  candles: (symbol: string, timeframe: string) => `algo:candles:${symbol}:${timeframe}`,
} as const;
