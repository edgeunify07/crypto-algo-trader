import fs from "node:fs/promises";
import path from "node:path";
import type { BotConfig } from "../engine/runner";

const FILE = path.join(process.cwd(), ".data", "bot-state.json");

export interface BotSnapshot {
  running: boolean;
  startedAt: string;
  config: BotConfig | null;
  lastSignal: string | null;
  pendingSignal: string | null;
  pendingReason?: string;
  lastError: string | null;
  ticks: number;
}

export async function loadBotSnapshot(): Promise<BotSnapshot | null> {
  try {
    const raw = await fs.readFile(FILE, "utf8");
    return JSON.parse(raw) as BotSnapshot;
  } catch {
    return null;
  }
}

export async function saveBotSnapshot(snapshot: BotSnapshot): Promise<void> {
  await fs.mkdir(path.dirname(FILE), { recursive: true });
  await fs.writeFile(FILE, JSON.stringify(snapshot, null, 2), "utf8");
}
