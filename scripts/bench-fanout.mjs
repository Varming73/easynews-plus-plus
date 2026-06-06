#!/usr/bin/env node
// Controlled micro-benchmark for the search fan-out — removes real-network noise
// by stubbing global.fetch with a FIXED per-call latency, so the only thing
// measured is whether the handler issues its Easynews searches concurrently.
//
// With K search calls, a per-call delay D and concurrency C:
//   sequential  ≈ K * D
//   parallel    ≈ ceil(K / C) * D
// So if the measured handler time ≈ ceil(K/C)*D (not K*D), the fan-out is parallel.
//
// No credentials and no network are used. Run after `npm run build`.
//   node scripts/bench-fanout.mjs            # default delay 600ms
//   SEARCH_DELAY_MS=400 node scripts/bench-fanout.mjs

import { performance } from 'node:perf_hooks';

const DELAY = Number(process.env.SEARCH_DELAY_MS) || 600;
const delay = ms => new Promise(r => setTimeout(r, ms));

let searchCalls = 0;

// Canned Easynews search payload — three files that match "Inception".
function cannedSearch() {
  const file = (hash, q) => ({
    0: hash,
    2: '.mkv',
    4: '2 GB',
    10: `Inception 2010 ${q}`,
    11: '.mkv',
    14: '120m',
    type: 'VIDEO',
    rawSize: 2e9,
    fullres: '1920x1080',
    alangs: ['eng'],
    ts: 0,
    passwd: false,
    virus: false,
    downURL: 'https://members.easynews.com/dl',
    dlFarm: 'f',
    dlPort: 'p',
  });
  return {
    data: [file('a', '2160p'), file('b', '1080p'), file('c', '720p')],
    downURL: 'https://members.easynews.com/dl',
    dlFarm: 'f',
    dlPort: 'p',
    results: 3,
  };
}

const json = body => ({ status: 200, ok: true, json: async () => body, text: async () => '' });

// Stub the global fetch: Easynews search calls incur the fixed delay and are
// counted; the IMDb suggestion returns instantly; nothing else is expected.
globalThis.fetch = async url => {
  const u = String(url); // api.ts passes a URL object, not a string
  if (u.includes('solr-search')) {
    searchCalls++;
    await delay(DELAY);
    return json(cannedSearch());
  }
  if (u.includes('media-imdb.com/suggestion')) {
    // Echo back the requested tt id so imdbMetaProvider's find() matches and we
    // don't fall through to the Cinemeta path.
    const tt = u.match(/\/t\/(tt\d+)\.json/)?.[1] ?? 'tt0000000';
    return json({ d: [{ id: tt, l: 'Inception', y: 2010 }] });
  }
  if (u.includes('v3-cinemeta.strem.io')) {
    return json({ meta: { name: 'Inception', year: '2010' } });
  }
  // TMDB is disabled without an API key, so it should never be hit.
  return json({});
};

let addonInterface;
let EasynewsAPI;
try {
  ({ addonInterface } = await import('../packages/addon/dist/addon.js'));
  // Same module instance the addon uses (resolved to the same realpath), so this
  // clears the shared search cache between runs to force fresh fan-out each time.
  ({ EasynewsAPI } = await import('../packages/api/dist/api.js'));
} catch (err) {
  console.error('✗ Could not load built dist — run `npm run build` first.');
  console.error(`  (${err?.message ?? err})`);
  process.exit(1);
}

const config = { username: 'u', password: 'p', baseUrl: 'https://addon.test' };

async function run(label, id) {
  EasynewsAPI.clearCache(); // force a fresh fan-out (don't measure a cache hit)
  searchCalls = 0;
  const start = performance.now();
  const res = await addonInterface.get('stream', 'movie', id, {}, config);
  const ms = performance.now() - start;
  const streams = Array.isArray(res?.streams) ? res.streams.length : 0;
  return { label, ms, streams, calls: searchCalls };
}

async function main() {
  console.log(`\nFan-out micro-benchmark  (per-search delay = ${DELAY} ms, no network)\n`);

  // Use a distinct id each run so the addon request cache doesn't short-circuit.
  const r1 = await run('run #1', 'tt1375666');
  const r2 = await run('run #2', 'tt9999991');
  const r3 = await run('run #3', 'tt9999992');

  for (const r of [r1, r2, r3]) {
    const seqProjection = r.calls * DELAY;
    console.log(
      `  ${r.label}: ${r.ms.toFixed(0).padStart(5)} ms   ` +
        `(${r.calls} search calls, ${r.streams} streams)  ` +
        `sequential would be ≈ ${seqProjection} ms`
    );
  }

  const r = r2; // steady-state (not first-call warmup)
  const ratio = (r.calls * DELAY) / r.ms;
  console.log(
    `\n  → ${r.calls} searches finished in ~${r.ms.toFixed(0)} ms instead of ~${r.calls * DELAY} ms ` +
      `(${ratio.toFixed(1)}× speedup vs sequential at this call count).`
  );
  console.log(
    `  → More title variants ⇒ more search calls ⇒ larger speedup, capped by concurrency.\n`
  );
}

main()
  .then(() => process.exit(0))
  .catch(err => {
    console.error(`\n✗ ${err?.stack ?? err}\n`);
    process.exit(1);
  });
