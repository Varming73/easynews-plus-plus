# Performance Baseline (Phase 1)

Anchor numbers captured **before** any performance refactor, so Phase 3/4 changes
can be measured against a fixed reference. Re-run with:

```bash
npm run build
set -a; . ./.env.local; set +a
node scripts/baseline-latency.mjs
```

The harness (`scripts/baseline-latency.mjs`) invokes the real built stream handler
via `addonInterface.get('stream', ...)` — the same entry point the Express host and
the SDK router use — so timings include metadata resolution + the sequential
Easynews search fan-out + filter + double sort. Credentials come from `.env.local`
and are never printed.

## Measured (2026-06-06, dev machine, default config `quality_first`)

| Scenario           | Title                    | Latency | Streams |
| ------------------ | ------------------------ | ------- | ------- |
| COLD (cache miss)  | Inception `tt1375666`    | 3133 ms | 13      |
| WARM (cache hit)   | Inception `tt1375666`    | 0 ms    | 13      |
| COLD (cache miss)  | Interstellar `tt0816692` | 2235 ms | 14      |
| WARM (cache hit)   | Interstellar `tt0816692` | 0 ms    | 14      |
| NO-RESULT (1st)    | Carmencita `tt0000001`   | 2309 ms | 0       |
| NO-RESULT (repeat) | Carmencita `tt0000001`   | 0 ms    | 0       |

**Averages:** COLD ≈ **2684 ms**, WARM ≈ **0 ms**, NO-RESULT first ≈ **2309 ms**.

## What the baseline establishes (and corrects)

1. **COLD first-play latency ≈ 2.7 s**, dominated by metadata + the _sequential_
   search fan-out. This is the Phase-3 parallelization target. (Note: these are
   well-seeded titles with few title variants — worst-case variant counts will be
   higher, so 2.7 s is a _typical_, not worst-case, figure.)

2. **WARM repeats are ~0 ms in-process** — empirically confirms Codex's correction
   that the addon-level `requestCache` (addon.ts:96) _does_ serve successful repeat
   requests. The original "next identical request does it all again" headline was
   wrong **for a single long-lived process** (self-hosted Express).

3. **Refinement beyond Codex's note:** even the _empty-after-search_ no-result path
   (Carmencita) cached in-process (repeat = 0 ms) — it reaches the normal success
   return, which writes the cache. So the genuinely-uncached paths are narrower than
   "all no-result/error returns": they are the **metadata-failure early return**
   (addon.ts:490) and **config/error returns** (addon.ts:1249), which this harness
   does not trigger. Worth a targeted follow-up measurement if Phase 2 touches them.

4. **The caching win is concentrated on Cloudflare, not self-hosted warm repeats.**
   In-memory caches reset per Worker isolate, and the protocol-level `cacheMaxAge`
   for empty results is `0` (getCacheOptions(0)), so cross-process / cross-isolate a
   repeat re-runs the full ~2.3–2.7 s fan-out even though the local map shows 0 ms.
   This is the Phase-2/3 shared-cache target and **cannot** be reproduced from one
   local process — it is reasoned about, not measured here.

## Limitations

- In-process measurement (faithful to the Express path); the Worker runs the same
  handler but with per-isolate cache lifetimes (see point 4).
- Upstream latency varies with Easynews load / time of day; treat absolute numbers
  as a ballpark and always compare COLD-vs-COLD on the same run when evaluating a
  change.

## Phase 3 result — parallel search fan-out

Honest caveat first: the real-network harness above is **too noisy to quantify**
the parallelization win on its own. Post-change `baseline-latency.mjs` runs ranged
from ~1300 ms to ~2460 ms COLD on the same code (NO-RESULT even came out _slower_
than COLD in one run) — upstream Easynews latency dominates, and pre/post
distributions overlap. So no clean "X% faster" claim is made from it.

To measure the structural win without network noise, `scripts/bench-fanout.mjs`
stubs `global.fetch` with a fixed per-call delay and counts search calls. With a
600 ms per-search delay and a title that issues 2 searches (no-year + year):

| Mode                                       | Measured | Sequential projection |
| ------------------------------------------ | -------- | --------------------- |
| Parallel (`SEARCH_CONCURRENCY=5`, default) | ~606 ms  | 1200 ms               |
| Forced sequential (`SEARCH_CONCURRENCY=1`) | ~1214 ms | 1200 ms               |

The `concurrency=1` row reproduces the old behavior (= 2 × 600 ms) and the default
row shows the searches running concurrently (≈ 1 × 600 ms) — a clean 2× at this
call count. The win scales with the number of title variants: K searches take
⌈K/concurrency⌉ batches instead of K sequential round-trips (e.g. 6 variants →
~3× at concurrency 5). Real-world wall-clock gains will be somewhere below these
idealized figures because actual per-call latency varies.
