#!/usr/bin/env node
// Streaming diagnostic for Easynews++ — answers two questions with real data:
//   (3) Does the resolved CDN URL carry an expiry token? (URL-expiry theory)
//   (2) What is the actual Easynews throughput vs. the file's bitrate? (buffering theory)
//
// Credentials are read from env vars and are NEVER printed.
//
// Usage:
//   EASYNEWS_USER=you EASYNEWS_PASS=secret node scripts/diagnose-streaming.mjs "Inception 2010"
//
// The query is optional (defaults to a popular, well-seeded title).

const user = process.env.EASYNEWS_USER;
const pass = process.env.EASYNEWS_PASS;
const query = process.argv[2] || 'Inception 2010';

if (!user || !pass) {
  console.error('✗ Set EASYNEWS_USER and EASYNEWS_PASS environment variables.');
  console.error(
    '  e.g. EASYNEWS_USER=you EASYNEWS_PASS=secret node scripts/diagnose-streaming.mjs'
  );
  process.exit(1);
}

const basic = 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
const TIMEOUT = 20_000;
const SAMPLE_SECONDS = 6; // how long to sample throughput
const SAMPLE_CAP = 40 * 1024 * 1024; // ...or stop after 40 MB, whichever first

const isEasynews = url => {
  try {
    return new URL(url).hostname.toLowerCase().endsWith('easynews.com');
  } catch {
    return false;
  }
};

// Replicates packages/api/src/api.ts search params (one page, 50 results).
async function search() {
  const params = new URLSearchParams({
    st: 'adv',
    sb: '1',
    fex: 'm4v,3gp,mov,divx,xvid,wmv,avi,mpg,mpeg,mp4,mkv,avc,flv,webm',
    'fty[]': 'VIDEO',
    spamf: '1',
    u: '1',
    gx: '1',
    pno: '1',
    sS: '3',
    s1: 'dsize',
    s1d: '-',
    s2: 'relevance',
    s2d: '-',
    s3: 'dtime',
    s3d: '-',
    pby: '50',
    safeO: '0',
    gps: query,
  });
  const url = `https://members.easynews.com/2.0/search/solr-search/advanced?${params}`;
  const res = await fetch(url, {
    headers: { Authorization: basic },
    signal: AbortSignal.timeout(TIMEOUT),
  });
  if (res.status === 401)
    throw new Error('Authentication failed (401) — check EASYNEWS_USER / EASYNEWS_PASS.');
  if (!res.ok) throw new Error(`Search request failed: ${res.status} ${res.statusText}`);
  return res.json();
}

// Mirrors createStreamPath() / createStreamUrl() (direct, un-proxied form).
function buildCleanUrl(res, file) {
  const ext = file['11'] ?? '';
  const path = `${file['0']}${ext}/${file['10']}${ext}`;
  return `${res.downURL}/${res.dlFarm}/${res.dlPort}/${encodeURI(path)}`;
}

// Follow the redirect chain by hand so we can see every hop, exactly like the
// /resolve endpoint does (Range: bytes=0-0). Auth is only ever sent to *.easynews.com.
async function probeRedirects(cleanUrl) {
  const hops = [];
  let cur = cleanUrl;
  for (let i = 0; i < 6; i++) {
    const headers = { Range: 'bytes=0-0' };
    if (isEasynews(cur)) headers.Authorization = basic;
    const r = await fetch(cur, {
      method: 'GET',
      headers,
      redirect: 'manual',
      signal: AbortSignal.timeout(TIMEOUT),
    });
    const location = r.headers.get('location');
    hops.push({ url: cur, status: r.status, location });
    if (r.status >= 300 && r.status < 400 && location) {
      cur = new URL(location, cur).toString();
      continue;
    }
    break;
  }
  return hops;
}

function analyzeExpiry(finalUrl) {
  let u;
  try {
    u = new URL(finalUrl);
  } catch {
    return { tokenish: false, params: [] };
  }
  const params = [...u.searchParams.keys()];
  // Anchored to the WHOLE key name so a param merely *containing* a common letter
  // (e.g. "name") can't trip a false "expiring" verdict.
  const tokenKey = /^(sig|signature|token|expires?|exp|st|e|hash|md5|key|auth|ttl|valid)$/i;
  const tokenish =
    params.some(k => tokenKey.test(k)) ||
    // a bare 10-digit unix timestamp anywhere in the path/query is also suspicious
    /\b1[0-9]{9}\b/.test(u.search + u.pathname);
  return { tokenish, params, search: u.search };
}

// Download from the resolved URL WITHOUT credentials — exactly what the player does
// after the 307. This also tests whether the resolved URL is self-authorizing.
async function measureThroughput(finalUrl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SAMPLE_SECONDS * 1000);
  const start = performance.now();
  let bytes = 0;
  let status = 0;
  try {
    const r = await fetch(finalUrl, {
      headers: { Range: 'bytes=0-' },
      redirect: 'manual',
      signal: controller.signal,
    });
    status = r.status;
    if (r.body && (r.status === 200 || r.status === 206)) {
      for await (const chunk of r.body) {
        bytes += chunk.length;
        if (bytes >= SAMPLE_CAP) break;
      }
    }
  } catch (e) {
    if (e?.name !== 'AbortError') throw e;
  } finally {
    clearTimeout(timer);
  }
  const seconds = (performance.now() - start) / 1000;
  return { status, bytes, seconds, MBps: bytes / 1024 / 1024 / seconds };
}

function fmtBytes(n) {
  if (!n) return 'unknown';
  const gb = n / 1024 ** 3;
  if (gb >= 1) return `${gb.toFixed(2)} GB`;
  return `${(n / 1024 ** 2).toFixed(0)} MB`;
}

async function main() {
  console.log(`\n▶ Searching Easynews for: "${query}" ...`);
  const res = await search();
  const files = (res.data ?? []).filter(
    f =>
      f.type?.toUpperCase() === 'VIDEO' &&
      !f.virus &&
      !f.passwd &&
      (f.rawSize ?? 0) > 20 * 1024 * 1024
  );
  if (files.length === 0) throw new Error('No usable video results — try a different query.');

  const file = files[0];
  const title = file['10'];
  const ext = file['11'] ?? '';
  const rawSize = file.rawSize ?? 0;
  const runtime = file.runtime ?? 0; // seconds
  const requiredMbps = runtime > 0 ? (rawSize * 8) / (runtime * 1e6) : null;

  console.log(`\n  Picked: ${title}${ext}`);
  console.log(
    `  Size:   ${fmtBytes(rawSize)}   Runtime: ${runtime ? Math.round(runtime / 60) + ' min' : 'unknown'}`
  );
  console.log(`  Farm/Port: ${res.dlFarm}/${res.dlPort}`);
  if (requiredMbps)
    console.log(
      `  File bitrate (avg): ${requiredMbps.toFixed(1)} Mb/s  ← connection must sustain at least this`
    );

  const cleanUrl = buildCleanUrl(res, file);

  // ── Test (3): redirect chain + expiry token ────────────────────────────────
  console.log(`\n── Test 3: resolve the URL and inspect the redirect chain ──`);
  const hops = await probeRedirects(cleanUrl);
  hops.forEach((h, i) => {
    const loc = h.location ? `→ ${h.location.replace(/\/\/[^/]*@/, '//***@')}` : '(no Location)';
    console.log(`  hop ${i}: ${h.status}  ${loc}`);
  });
  const final = hops[hops.length - 1];
  const finalUrl = final.url;
  const expiry = analyzeExpiry(finalUrl);
  console.log(
    `\n  Final URL host: ${(() => {
      try {
        return new URL(finalUrl).hostname;
      } catch {
        return '?';
      }
    })()}`
  );
  console.log(`  Final status (with auth, 1-byte): ${final.status}`);
  console.log(
    `  Query params on final URL: ${expiry.params.length ? expiry.params.join(', ') : '(none)'}`
  );
  console.log(
    expiry.tokenish
      ? `  ⚠ VERDICT: final URL looks TOKENIZED/EXPIRING (${expiry.search}). Cause #3 is plausible.`
      : `  ✓ VERDICT: no token/expiry params on the final URL. Cause #3 (URL expiry) is unlikely.`
  );

  // ── Test (2): throughput without credentials (what the player gets) ─────────
  console.log(`\n── Test 2: download from the resolved URL (no auth) for ~${SAMPLE_SECONDS}s ──`);
  const tp = await measureThroughput(finalUrl);
  if (tp.status === 401 || tp.status === 403) {
    console.log(`  Resolved URL returned ${tp.status} without credentials.`);
    console.log(
      `  → The resolved URL is NOT self-authorizing; the player would need creds. Worth noting.`
    );
  } else if (tp.bytes === 0) {
    console.log(`  Got status ${tp.status} but no bytes — try re-running or a different title.`);
  } else {
    const mbps = tp.MBps * 8;
    console.log(`  Downloaded ${fmtBytes(tp.bytes)} in ${tp.seconds.toFixed(1)}s`);
    console.log(`  Throughput: ${tp.MBps.toFixed(1)} MB/s  (${mbps.toFixed(0)} Mb/s)`);
    if (requiredMbps) {
      const headroom = mbps / requiredMbps;
      console.log(
        `  Required for smooth playback: ${requiredMbps.toFixed(1)} Mb/s → headroom ${headroom.toFixed(1)}×`
      );
      console.log(
        headroom >= 1.3
          ? `  ✓ VERDICT: throughput comfortably exceeds the file's bitrate. Buffering is NOT raw throughput.`
          : headroom >= 1.0
            ? `  ⚠ VERDICT: throughput is only ${headroom.toFixed(1)}× the bitrate — marginal; bursts will buffer.`
            : `  ⚠ VERDICT: throughput is BELOW the file's bitrate (${headroom.toFixed(1)}×). This alone explains buffering — pick smaller files.`
      );
    }
  }

  console.log(
    `\nDone. Re-run with a heavier title (e.g. a 4K remux) to compare:\n  EASYNEWS_USER=… EASYNEWS_PASS=… node scripts/diagnose-streaming.mjs "Dune Part Two 2024"\n`
  );
}

main().catch(err => {
  console.error(`\n✗ ${err.message}\n`);
  process.exit(1);
});
