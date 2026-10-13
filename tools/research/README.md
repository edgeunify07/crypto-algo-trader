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

## `thirty.mts`

Optimises one engine against the most recent 30 days, and reports what the
same parameters did on the three months before it.

```bash
set -a && . ./.env.local && set +a
ENGINE=swing TRIALS=500 TARGET=0.15 OUT=/tmp/research npx tsx tools/research/thirty.mts
ENGINE=scalp TRIALS=500 TARGET=0.15 OUT=/tmp/research npx tsx tools/research/thirty.mts
```

The two columns are the point. `SEARCH-30d` is the window the search ran on,
so it is fitted rather than predicted: with several hundred trials over twenty
free parameters, a 15% month is usually findable in any series, including a
random one. `BEFORE-90d` is the stretch the search never sees, and it is what
says whether the shape found was an edge or an accident. A candidate strong in
both is worth deploying; one that is +20% in the first column and negative in
the second is curve-fitting with a good headline.

The engines are searched in isolation — the swing run disables the scalp, and
the scalp run points the swing engine at a timeframe the cache does not hold,
so it never forms a blend and never trades. The 5% per-trade loss limit is a
hard constraint, checked on realised profit and loss: a 15% month bought with
a 9% loss somewhere is not the thing that was asked for.

Writes `$OUT/thirty-<engine>.json` with the ten best hits, checkpointed every
25 trials so a restart costs minutes rather than the run.
