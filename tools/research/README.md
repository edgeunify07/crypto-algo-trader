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

## `optimise2.mts`

Two-stage search validated across four disjoint out-of-sample windows.

The earlier approach searched 60 days and validated on one 21-day window,
which is thin: run 400 trials against any single window and something will
look good on it by luck. This trains on the oldest 35% of 150 days, then
re-runs the survivors across four later windows on the full universe, and
accepts a candidate only if it stayed profitable in at least three of them
with no liquidations. Ranking is by median window return rather than mean, so
one outlier cannot carry a candidate that is otherwise mediocre.

Half the trials refine around the best point found so far instead of sampling
freely, which is what makes a random search converge rather than just sprawl.

```bash
set -a && . ./.env.local && set +a
OUT=/tmp/research TRIALS=600 KEEP=40 DAYS=150 npx tsx tools/research/optimise2.mts
```

Writes `$OUT/winner2.json` when something clears the bar, and says so plainly
when nothing does — in which case the shipped defaults stay, because a
candidate that only works on the window it was chosen for is worse than no
change at all.

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
