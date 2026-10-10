# Research tooling

Scripts used to tune and validate the strategy against real Binance futures
data. They are **not** part of the deployed app — `tsconfig.json` excludes this
directory so the Next build never type-checks it, the same reason
`algo-screener/` is excluded.

Run them from the repo root with the env file loaded:

```bash
set -a && . ./.env.local && set +a
OUT=/tmp/research npx tsx tools/research/validate.mts
```

## `validate.mts`

Third-window validation. The optimiser ranks candidates with a score that
includes its held-out window, so after a few hundred trials that window is no
longer out-of-sample for the winner — some of its edge is selection luck. This
pages 60 days of history (past Binance's 1500-bar cap) and re-tests the winner
on the stretch *before* the optimisation window, which the search never saw.

It also perturbs the winner's continuous parameters by ±12% and re-runs, to
distinguish a stable region from a single lucky point. A parameter set that
only works at exactly its tuned values is a curve fit.

Expects `$OUT/klines.json` and `$OUT/best.json` from an optimisation run.
