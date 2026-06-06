#!/usr/bin/env node
// Phase-1 latency BASELINE for the Easynews++ stream handler.
//
// Invokes the REAL built stream handler via `addonInterface.get('stream', ...)`
// — the exact entry point the Express host and the SDK router call — so the
// numbers reflect the production request pipeline: metadata resolution +
// (sequential) Easynews search fan-out + filter + the double sort.
//
// It records three scenarios the corrected plan calls out:
//   COLD       — first request for a title (full fan-out, cache miss)
//   WARM       — immediate repeat of the SAME request (addon requestCache hit)
//   NO-RESULT  — a valid IMDb id that resolves to metadata but yields no
//                Easynews matches (the expensive, currently-uncached path)
//
// Run AFTER `npm run build`. Credentials come from env and are NEVER printed.
//
// Usage:
//   set -a; . ./.env.local; set +a
//   node scripts/baseline-latency.mjs                 # default ids
//   node scripts/baseline-latency.mjs tt1375666 tt0816692   # custom cold ids
//
// LIMITATION (documented honestly): this measures in-process per-request
// compute + upstream latency, faithful to the Express path. The Cloudflare
// Worker runs the SAME handler, but its in-memory caches reset per isolate, so
// real-world Worker WARM hit-rate is lower than what this harness shows. That
// cross-isolate cache miss is precisely what Phase 2/3 caching work targets;
// it cannot be reproduced from a single local process, so it is noted, not faked.

import { performance } from 'node:perf_hooks';

const user = process.env.EASYNEWS_USER;
const pass = process.env.EASYNEWS_PASS;
if (!user || !pass) {
  console.error('✗ Set EASYNEWS_USER and EASYNEWS_PASS (e.g. `set -a; . ./.env.local; set +a`).');
  process.exit(1);
}

// Import the BUILT handler. Fail loudly with a hint if the dist is missing.
let addonInterface;
try {
  ({ addonInterface } = await import('../packages/addon/dist/addon.js'));
} catch (err) {
  console.error('✗ Could not load packages/addon/dist/addon.js — run `npm run build` first.');
  console.error(`  (${err?.message ?? err})`);
  process.exit(1);
}

const baseConfig = {
  username: user,
  password: pass,
  baseUrl: 'https://addon.test', // route via /resolve mode, avoids legacy-URL warnings
};

// Default ids: two well-seeded movies for COLD/WARM, and an 1894 short
// (Carmencita) that has Cinemeta metadata but ~never has an Easynews video
// match — exercising the full fan-out that returns zero streams.
const COLD_IDS = process.argv.slice(2).length ? process.argv.slice(2) : ['tt1375666', 'tt0816692'];
const NO_RESULT_ID = 'tt0000001';

const fmt = ms => `${ms.toFixed(0)} ms`.padStart(8);

async function timeCall(label, id) {
  const start = performance.now();
  let streams = -1;
  let err = null;
  try {
    const res = await addonInterface.get('stream', 'movie', id, {}, baseConfig);
    streams = Array.isArray(res?.streams) ? res.streams.length : 0;
  } catch (e) {
    err = e?.message ?? String(e);
  }
  const ms = performance.now() - start;
  const detail = err ? `ERROR: ${err}` : `${streams} streams`;
  console.log(`  ${label.padEnd(26)} ${fmt(ms)}   ${detail}`);
  return { label, id, ms, streams, err };
}

async function main() {
  console.log(`\nEasynews++ stream-handler latency baseline`);
  console.log(`(in-process; upstream network included; creds hidden)\n`);

  const rows = [];

  // COLD + WARM for each well-seeded id. Fresh process ⇒ first call is a real
  // cache miss; the immediate repeat should hit the addon requestCache.
  for (const id of COLD_IDS) {
    console.log(`▶ ${id}`);
    rows.push(await timeCall('COLD (cache miss)', id));
    rows.push(await timeCall('WARM (cache hit)', id));
    console.log('');
  }

  // Expensive no-result path (full fan-out, empty result, not cached today).
  console.log(`▶ ${NO_RESULT_ID} (expected no Easynews match)`);
  rows.push(await timeCall('NO-RESULT (cache miss)', NO_RESULT_ID));
  rows.push(await timeCall('NO-RESULT (repeat)', NO_RESULT_ID));
  console.log('');

  // Summary: averages per scenario for an at-a-glance baseline.
  const avg = pred => {
    const xs = rows.filter(pred).map(r => r.ms);
    return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN;
  };
  const cold = avg(r => r.label.startsWith('COLD'));
  const warm = avg(r => r.label.startsWith('WARM'));
  const noResCold = avg(r => r.label === 'NO-RESULT (cache miss)');
  const noResRepeat = avg(r => r.label === 'NO-RESULT (repeat)');

  console.log('── Baseline summary (avg) ─────────────────────────────');
  console.log(`  COLD (full fan-out)         ${fmt(cold)}`);
  console.log(`  WARM (requestCache hit)     ${fmt(warm)}`);
  console.log(`  NO-RESULT first             ${fmt(noResCold)}`);
  console.log(`  NO-RESULT repeat            ${fmt(noResRepeat)}`);
  console.log('───────────────────────────────────────────────────────');
  console.log(
    `  COLD vs WARM delta ≈ ${fmt(cold - warm)}  ← upper bound on what caching+parallel fan-out can remove.`
  );
  if (Number.isFinite(noResRepeat) && noResRepeat > 50) {
    console.log(
      `  NO-RESULT repeat is still ${noResRepeat.toFixed(0)} ms ⇒ confirms the no-result path is NOT cached (Phase-2 target).`
    );
  }
  console.log('');
}

main()
  .then(() => process.exit(0)) // undici keep-alive sockets otherwise hold the loop open
  .catch(err => {
    console.error(`\n✗ ${err?.stack ?? err}\n`);
    process.exit(1);
  });
