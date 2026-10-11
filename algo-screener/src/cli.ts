#!/usr/bin/env -S npx tsx
import { config } from "./config.js";
import { createLogger } from "./util/logger.js";
import { isTimeframe, type Timeframe } from "./types.js";
import { MarketData } from "./data/marketData.js";
import { loadSymbolData } from "./backtest/loader.js";
import { runBacktest } from "./backtest/engine.js";
import { walkForward } from "./backtest/walkforward.js";
import { buildPerformanceReport } from "./improve/report.js";
import { runImprovement } from "./improve/improver.js";
import {
  ensureDefaultsExist,
  loadActiveParams,
  loadHistory,
  rollback,
} from "./improve/paramStore.js";
import { screenAll } from "./screener/screener.js";
import { TradingLoop } from "./runtime/tradingLoop.js";
import { startServer } from "./server/httpServer.js";
import { isoDate } from "./util/time.js";

const log = createLogger("cli");

interface Args {
  command: string;
  flags: Map<string, string | boolean>;
}

function parseArgs(argv: string[]): Args {
  const command = argv[0] ?? "help";
  const flags = new Map<string, string | boolean>();
  for (let i = 1; i < argv.length; i++) {
    const token = argv[i] as string;
    if (!token.startsWith("--")) continue;
    const eq = token.indexOf("=");
    if (eq !== -1) {
      flags.set(token.slice(2, eq), token.slice(eq + 1));
    } else {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags.set(token.slice(2), next);
        i++;
      } else {
        flags.set(token.slice(2), true);
      }
    }
  }
  return { command, flags };
}

const str = (args: Args, key: string, fallback: string): string => {
  const v = args.flags.get(key);
  return typeof v === "string" ? v : fallback;
};
const int = (args: Args, key: string, fallback: number): number => {
  const v = args.flags.get(key);
  const n = typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : fallback;
};
const flag = (args: Args, key: string): boolean => args.flags.get(key) === true;

function parseTimeframes(raw: string, fallback: Timeframe[]): Timeframe[] {
  const parsed = raw
    .split(",")
    .map((s) => s.trim())
    .filter(isTimeframe);
  return parsed.length > 0 ? parsed : fallback;
}

async function resolveSymbols(args: Args): Promise<string[]> {
  const explicit = str(args, "symbols", "");
  if (explicit) {
    return explicit.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
  }
  log.info("discovering the universe by 24h volume…");
  const symbols = await MarketData.resolveUniverse();
  log.info(`universe (${symbols.length}): ${symbols.join(", ")}`);
  return symbols;
}

// --------------------------------------------------------------------------

async function cmdScreen(args: Args): Promise<void> {
  const symbols = await resolveSymbols(args);
  const timeframes = parseTimeframes(str(args, "timeframes", ""), [...config.timeframes]);
  const top = int(args, "top", 15);
  const versioned = loadActiveParams();

  const market = new MarketData(symbols, timeframes, int(args, "bars", config.historyBars));
  await market.warmUp();

  const rows = screenAll(market, versioned.params, config.account.startingCash);
  const shown = rows.slice(0, top);

  console.log(`\nScreener — params ${versioned.version} — ${isoDate(Date.now())}`);
  console.log(
    "symbol".padEnd(12) +
      "price".padStart(14) +
      "score".padStart(8) +
      "conf".padStart(7) +
      "align".padStart(7) +
      "  dir".padEnd(8) +
      "anchor".padEnd(8) +
      "plan",
  );
  console.log("-".repeat(96));

  for (const row of shown) {
    const plan = row.plan
      ? `${row.plan.side} @ ${row.plan.entry.toFixed(6)} stop ${row.plan.stopLoss.toFixed(6)} (${row.plan.rMultiple.toFixed(1)}R)`
      : "—";
    console.log(
      row.symbol.padEnd(12) +
        row.price.toFixed(6).padStart(14) +
        row.score.toFixed(2).padStart(8) +
        `${(row.confidence * 100).toFixed(0)}%`.padStart(7) +
        `${(row.alignment * 100).toFixed(0)}%`.padStart(7) +
        `  ${row.direction}`.padEnd(8) +
        row.anchorTimeframe.padEnd(8) +
        plan,
    );
  }

  if (flag(args, "detail")) {
    for (const row of shown) {
      console.log(`\n--- ${row.symbol} ---`);
      for (const [tf, a] of Object.entries(row.perTimeframe)) {
        console.log(
          `  ${tf.padEnd(4)} score ${a.score.toFixed(2).padStart(6)} | ${a.regime.kind.padEnd(14)} | ` +
            `elliott ${a.elliott.pattern}/${a.elliott.currentWave} (${a.elliott.bias}, ${(a.elliott.confidence * 100).toFixed(0)}%) | ` +
            `gann ${a.gann.bias} bar ${a.gann.timeCycle.barsSinceAnchor}/${a.gann.timeCycle.nearestCycle}`,
        );
      }
      for (const reason of row.plan?.reasons ?? []) console.log(`    · ${reason}`);
    }
  }
  console.log();
}

async function cmdBacktest(args: Args): Promise<void> {
  const symbols = await resolveSymbols(args);
  const timeframes = parseTimeframes(
    str(args, "timeframes", "15m,1h,4h,1d"),
    ["15m", "1h", "4h", "1d"],
  );
  const stepRaw = str(args, "step", "1h");
  const stepTimeframe: Timeframe = isTimeframe(stepRaw) ? stepRaw : "1h";
  const bars = int(args, "bars", 3000);
  const versioned = loadActiveParams();

  log.info(`loading ${bars} bars for ${symbols.length} symbols…`);
  const data = await loadSymbolData({ symbols, timeframes, bars });

  const result = runBacktest(data, {
    params: versioned.params,
    stepTimeframe,
    startingCash: int(args, "cash", config.account.startingCash),
  });

  const wf = flag(args, "walkforward")
    ? walkForward(data, versioned.params, {
        folds: int(args, "folds", 4),
        stepTimeframe,
      })
    : undefined;

  console.log(`\n${buildPerformanceReport(result, versioned.params, wf)}\n`);
}

async function cmdImprove(args: Args): Promise<void> {
  const symbols = await resolveSymbols(args);
  const timeframes = parseTimeframes(
    str(args, "timeframes", "15m,1h,4h,1d"),
    ["15m", "1h", "4h", "1d"],
  );
  const stepRaw = str(args, "step", "1h");
  const stepTimeframe: Timeframe = isTimeframe(stepRaw) ? stepRaw : "1h";
  const bars = int(args, "bars", 5000);

  ensureDefaultsExist();
  log.info(`loading ${bars} bars for ${symbols.length} symbols…`);
  const data = await loadSymbolData({ symbols, timeframes, bars });

  const report = await runImprovement({
    data,
    rounds: int(args, "rounds", 1),
    candidatesPerRound: int(args, "candidates", config.llm.candidatesPerRound),
    stepTimeframe,
    folds: int(args, "folds", 4),
    useLlm: !flag(args, "no-llm"),
    dryRun: flag(args, "dry-run"),
  });

  console.log(
    `\nImprovement finished: ${report.startingVersion} -> ${report.finalVersion} ` +
      `(${report.improved ? "PROMOTED" : "unchanged"})\n`,
  );
  for (const round of report.rounds) {
    console.log(`Round ${round.round} (${round.source}), incumbent score ${round.incumbentScore.toFixed(3)}:`);
    for (const e of round.evaluations) {
      console.log(
        `  ${e.name.padEnd(28)} score ${e.score.toFixed(3).padStart(7)} | ` +
          `${e.validation.aggregate.trades} OOS trades | ` +
          `${(e.validation.aggregate.totalReturn * 100).toFixed(1)}% | ` +
          (e.rejectedBecause ?? "PROMOTED CANDIDATE"),
      );
      for (const change of e.changes) console.log(`      · ${change}`);
    }
  }
  console.log();
}

async function cmdRun(args: Args, mode: "paper" | "live"): Promise<void> {
  if (mode === "live" && !config.runtime.liveTrading) {
    log.error(
      "Refusing to start: live mode requires LIVE_TRADING=true plus BINANCE_API_KEY/SECRET in the environment.",
    );
    process.exitCode = 1;
    return;
  }

  const symbols = await resolveSymbols(args);
  const timeframes = parseTimeframes(str(args, "timeframes", ""), [...config.timeframes]);

  const loop = new TradingLoop(
    {
      mode,
      timeframes,
      startingCash: int(args, "cash", config.account.startingCash),
      persist: !flag(args, "no-persist"),
    },
    symbols,
  );

  const server = flag(args, "no-server")
    ? null
    : startServer(loop, int(args, "port", config.runtime.httpPort));

  await loop.start();

  // Optional periodic self-improvement while the loop runs.
  const hours = int(args, "improve-hours", config.runtime.improveIntervalHours);
  let improveTimer: NodeJS.Timeout | null = null;
  if (hours > 0) {
    log.info(`automatic improvement scheduled every ${hours}h`);
    improveTimer = setInterval(
      () => {
        void (async () => {
          try {
            log.info("running scheduled improvement round…");
            const data = await loadSymbolData({
              symbols,
              timeframes: ["15m", "1h", "4h", "1d"],
              bars: 5000,
            });
            await runImprovement({ data, rounds: 1, stepTimeframe: "1h" });
            // The loop picks up any promotion on its next scan.
            loop.reloadParams();
          } catch (err) {
            log.error("scheduled improvement failed", err);
          }
        })();
      },
      hours * 3_600_000,
    );
  }

  const shutdown = () => {
    log.info("shutting down…");
    if (improveTimer) clearInterval(improveTimer);
    loop.stop();
    server?.close();
    setTimeout(() => process.exit(0), 500);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

async function cmdServe(args: Args): Promise<void> {
  await cmdRun(args, "paper");
}

function cmdParams(args: Args): void {
  const sub = str(args, "action", "show");
  if (sub === "rollback") {
    const version = str(args, "version", "default");
    const restored = rollback(version);
    if (!restored) {
      log.error(`no stored params with version "${version}"`);
      process.exitCode = 1;
      return;
    }
    console.log(`rolled back to ${restored.version}`);
    return;
  }
  if (sub === "history") {
    for (const record of loadHistory()) {
      console.log(
        `${record.version} (${record.source}) ${isoDate(record.createdAt)}\n` +
          `  parent: ${record.parentVersion ?? "none"}\n` +
          `  OOS return ${(record.evidence.totalReturn * 100).toFixed(1)}%, ` +
          `DD ${(record.evidence.maxDrawdown * 100).toFixed(1)}%, ` +
          `${record.evidence.trades} trades, consistency ${(record.evidence.foldConsistency * 100).toFixed(0)}%\n` +
          `  ${record.rationale}\n`,
      );
    }
    return;
  }
  const active = loadActiveParams();
  console.log(JSON.stringify(active, null, 2));
}

function usage(): void {
  console.log(`
algo-screener — multi-timeframe crypto screener with Elliott Wave + Gann,
paper trading on live Binance data, and LLM-driven strategy improvement.

Usage: npx tsx src/cli.ts <command> [flags]

Commands:
  screen        Rank the universe across every timeframe right now.
                  --symbols BTCUSDT,ETHUSDT   --timeframes 1h,4h,1d
                  --top 15   --bars 750   --detail

  backtest      Replay the strategy over historical klines.
                  --symbols ...   --timeframes 15m,1h,4h,1d   --step 1h
                  --bars 3000   --cash 10000   --walkforward   --folds 4

  improve       Run the LLM improvement loop (backtest -> propose -> validate
                -> promote). Falls back to local mutation search without a key.
                  --rounds 1   --candidates 4   --bars 5000   --folds 4
                  --no-llm   --dry-run

  paper         Live paper trading against real-time Binance data.
                  --symbols ...   --cash 10000   --port 4317
                  --improve-hours 12   --no-server   --no-persist

  live          Same loop, routing real orders. Requires LIVE_TRADING=true
                and BINANCE_API_KEY / BINANCE_API_SECRET.

  serve         Alias for 'paper' (dashboard + paper trading).

  params        Inspect or roll back strategy parameters.
                  --action show | history | rollback   --version <id>

Environment: copy .env.example to .env. ANTHROPIC_API_KEY enables the LLM loop;
BINANCE_API_KEY/SECRET are only needed for live trading.
`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  switch (args.command) {
    case "screen":
      return cmdScreen(args);
    case "backtest":
      return cmdBacktest(args);
    case "improve":
      return cmdImprove(args);
    case "paper":
      return cmdRun(args, "paper");
    case "live":
      return cmdRun(args, "live");
    case "serve":
      return cmdServe(args);
    case "params":
      return cmdParams(args);
    default:
      usage();
  }
}

main().catch((err) => {
  log.error("command failed", err);
  process.exitCode = 1;
});
