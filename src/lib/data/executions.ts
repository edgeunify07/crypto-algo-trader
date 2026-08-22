import fs from "node:fs/promises";
import path from "node:path";
import type { ExecEvent } from "../executor";

const DATA_DIR = path.join(process.cwd(), ".data");
const FILE = path.join(DATA_DIR, "executions.json");
const MAX_EVENTS = 2000;

interface ExecutionsFile {
  updatedAt: string;
  events: ExecEvent[];
}

let writeQueue: Promise<void> = Promise.resolve();

async function ensureDir() {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

export async function loadExecutions(): Promise<ExecEvent[]> {
  try {
    const raw = await fs.readFile(FILE, "utf8");
    const parsed = JSON.parse(raw) as ExecutionsFile;
    return Array.isArray(parsed.events) ? parsed.events : [];
  } catch {
    return [];
  }
}

export async function saveExecutions(events: ExecEvent[]): Promise<void> {
  await ensureDir();
  const payload: ExecutionsFile = {
    updatedAt: new Date().toISOString(),
    events: events.slice(0, MAX_EVENTS),
  };
  await fs.writeFile(FILE, JSON.stringify(payload, null, 2), "utf8");
}

/** Serialized append — safe for concurrent log calls. */
export function queuePersist(events: ExecEvent[]): void {
  writeQueue = writeQueue.then(() => saveExecutions(events)).catch(() => {});
}

export function getExecutionsForSymbol(events: ExecEvent[], symbol: string, limit = 100): ExecEvent[] {
  const sym = symbol.toUpperCase();
  return events.filter((e) => e.symbol.toUpperCase() === sym && (e.action === "BUY" || e.action === "SELL")).slice(0, limit);
}
