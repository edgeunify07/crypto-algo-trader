import { config } from "../config.js";

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
export type LogLevel = keyof typeof LEVELS;

const threshold = LEVELS[(config.runtime.logLevel as LogLevel) ?? "info"] ?? 20;

function emit(level: LogLevel, scope: string, message: string, extra?: unknown) {
  if (LEVELS[level] < threshold) return;
  const stamp = new Date().toISOString().slice(11, 23);
  const line = `${stamp} ${level.toUpperCase().padEnd(5)} [${scope}] ${message}`;
  const stream = level === "error" || level === "warn" ? console.error : console.log;
  if (extra === undefined) stream(line);
  else stream(line, extra);
}

export interface Logger {
  debug(message: string, extra?: unknown): void;
  info(message: string, extra?: unknown): void;
  warn(message: string, extra?: unknown): void;
  error(message: string, extra?: unknown): void;
}

export function createLogger(scope: string): Logger {
  return {
    debug: (m, e) => emit("debug", scope, m, e),
    info: (m, e) => emit("info", scope, m, e),
    warn: (m, e) => emit("warn", scope, m, e),
    error: (m, e) => emit("error", scope, m, e),
  };
}
