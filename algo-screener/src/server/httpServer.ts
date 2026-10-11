import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { config, PROJECT_ROOT } from "../config.js";
import { createLogger } from "../util/logger.js";
import type { TradingLoop } from "../runtime/tradingLoop.js";
import { computeMetrics } from "../backtest/metrics.js";
import { loadHistory } from "../improve/paramStore.js";

const log = createLogger("http");

/**
 * Read-only dashboard over the running loop.
 *
 * Deliberately a plain Node server with one static page and a few JSON
 * endpoints: no framework, no build step, and no way to place or cancel an
 * order from the browser. Anything that moves money goes through the CLI.
 */
export function startServer(loop: TradingLoop, port = config.runtime.httpPort): http.Server {
  const publicDir = path.join(PROJECT_ROOT, "src", "server", "public");

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    const json = (body: unknown, status = 200) => {
      const payload = JSON.stringify(body);
      res.writeHead(status, {
        "content-type": "application/json",
        "cache-control": "no-store",
      });
      res.end(payload);
    };

    try {
      switch (url.pathname) {
        case "/api/state": {
          const prices = loop.executor.prices();
          const broker = loop.executor.broker;
          const metrics = computeMetrics(
            broker.closedTrades,
            broker.curve,
            config.account.startingCash,
          );
          return json({
            mode: loop.executor.mode,
            paramsVersion: loop.activeParams.version,
            paramsSource: loop.activeParams.source,
            equity: broker.equity(prices),
            cash: broker.availableCash,
            unrealisedPnl: broker.unrealised(prices),
            drawdown: broker.drawdown(prices),
            openPositions: broker.openPositions.map((p) => ({
              ...p,
              markPrice: prices.get(p.symbol) ?? p.entryPrice,
              unrealised:
                p.side === "long"
                  ? ((prices.get(p.symbol) ?? p.entryPrice) - p.entryPrice) * p.quantity
                  : (p.entryPrice - (prices.get(p.symbol) ?? p.entryPrice)) * p.quantity,
            })),
            metrics,
            updatedAt: Date.now(),
          });
        }

        case "/api/screener": {
          return json(
            loop.rows.map((row) => ({
              symbol: row.symbol,
              price: row.price,
              score: row.score,
              confidence: row.confidence,
              alignment: row.alignment,
              direction: row.direction,
              anchorTimeframe: row.anchorTimeframe,
              quoteVolume24h: row.quoteVolume24h,
              hasPlan: row.plan !== null,
              plan: row.plan,
              timeframes: Object.fromEntries(
                Object.entries(row.perTimeframe).map(([tf, a]) => [
                  tf,
                  {
                    score: a.score,
                    confidence: a.confidence,
                    direction: a.direction,
                    regime: a.regime.kind,
                    elliott: {
                      pattern: a.elliott.pattern,
                      wave: a.elliott.currentWave,
                      bias: a.elliott.bias,
                      confidence: a.elliott.confidence,
                    },
                    gann: {
                      bias: a.gann.bias,
                      confidence: a.gann.confidence,
                      barsSinceAnchor: a.gann.timeCycle.barsSinceAnchor,
                      nearestCycle: a.gann.timeCycle.nearestCycle,
                    },
                  },
                ]),
              ),
            })),
          );
        }

        case "/api/symbol": {
          const symbol = url.searchParams.get("symbol")?.toUpperCase() ?? "";
          const row = loop.rows.find((r) => r.symbol === symbol);
          if (!row) return json({ error: `no analysis for ${symbol}` }, 404);
          return json(row);
        }

        case "/api/trades": {
          return json(loop.executor.broker.closedTrades.slice(-200));
        }

        case "/api/equity": {
          return json(loop.executor.broker.curve.slice(-1000));
        }

        case "/api/params": {
          return json({
            active: loop.activeParams,
            history: loadHistory().map((h) => ({
              version: h.version,
              createdAt: h.createdAt,
              source: h.source,
              rationale: h.rationale,
              parentVersion: h.parentVersion,
              evidence: h.evidence,
            })),
          });
        }

        case "/":
        case "/index.html": {
          const file = path.join(publicDir, "index.html");
          if (!fs.existsSync(file)) {
            res.writeHead(404, { "content-type": "text/plain" });
            return res.end("dashboard page not found");
          }
          res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
          return res.end(fs.readFileSync(file));
        }

        default: {
          res.writeHead(404, { "content-type": "text/plain" });
          return res.end("not found");
        }
      }
    } catch (err) {
      log.error(`request for ${url.pathname} failed`, err);
      return json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  server.listen(port, () => {
    log.info(`dashboard listening on http://localhost:${port}`);
  });
  return server;
}
