/**
 * Live before/after check for the Scandinavian-transliteration fix.
 *
 * Queries the real Easynews API twice for a title containing æ/ø/å:
 *   BEFORE — only the original title (the pre-fix behavior).
 *   AFTER  — the original title PLUS getNordicTransliterations(title)
 *            (what addon.ts now feeds into the search fan-out).
 *
 * It reuses the exact production code paths (EasynewsAPI.search,
 * buildSearchQuery, matchesTitle, isBadVideo) so the numbers reflect what the
 * addon would actually retrieve and keep — and reports how many extra unique
 * results the fix surfaces.
 *
 * Usage (run from the repo root):
 *   EASYNEWS_USERNAME=you EASYNEWS_PASSWORD=secret \
 *     npx tsx scripts/nordic-search-check.ts "Slangedræber" --type series --season 1 --episode 1
 *
 *   # Movie with a year:
 *   npx tsx scripts/nordic-search-check.ts "Rødby" --type movie --year 2024
 *
 * Flags:
 *   --type series|movie   (default: series)
 *   --season N            (series only)
 *   --episode N           (series only)
 *   --year YYYY           (used for movies; series queries ignore the year)
 *   --loose               (disable strict title matching; addon default is strict)
 *   --debug               (show the underlying Easynews logger output)
 *
 * Credentials are read ONLY from EASYNEWS_USERNAME / EASYNEWS_PASSWORD — never
 * hardcode them. Nothing is written anywhere; this only issues read queries.
 */

// Quiet the winston loggers unless --debug; must be set before the modules that
// read it at import time, hence the dynamic imports below.
const wantDebug = process.argv.includes('--debug');
process.env.EASYNEWS_LOG_LEVEL ||= wantDebug ? 'debug' : 'silent';

const { EasynewsAPI } = await import('easynews-plus-plus-api');
const { getNordicTransliterations, buildSearchQuery, matchesTitle, isBadVideo, getPostTitle } =
  await import('../packages/addon/src/utils.js');
import type { ContentType } from '@stremio-addon/sdk';
import type { FileData, SearchOptions } from 'easynews-plus-plus-api';

function getFlag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const username = process.env.EASYNEWS_USERNAME;
const password = process.env.EASYNEWS_PASSWORD;
if (!username || !password) {
  console.error(
    'Missing credentials. Set EASYNEWS_USERNAME and EASYNEWS_PASSWORD in the environment.'
  );
  process.exit(1);
}

// First non-flag argument is the title; default to the reported example.
const positional = process.argv.slice(2).find(a => !a.startsWith('--'));
const title = positional ?? 'Slangedræber';
const type = (getFlag('type') as ContentType) ?? 'series';
const season = getFlag('season');
const episode = getFlag('episode');
const year = getFlag('year') ? Number(getFlag('year')) : undefined;
const strict = !process.argv.includes('--loose');

const meta = { name: title, year, season, episode };

// Mirror the addon's sort options (relevance, then size, then date — all desc).
const sortOptions: Partial<SearchOptions> = {
  sort1: 'relevance',
  sort1Direction: '-',
  sort2: 'dsize',
  sort2Direction: '-',
  sort3: 'dtime',
  sort3Direction: '-',
};

const api = new EasynewsAPI({ username, password });

/** Build the query strings for a set of title variants, exactly as the addon does. */
function buildQueries(titles: string[]): string[] {
  const queries = new Set<string>();
  for (const name of titles) {
    if (!name.trim()) continue;
    // No-year query (most permissive; what finds foreign-titled content).
    queries.add(buildSearchQuery(type, { ...meta, name, year: undefined }));
    // With-year query too, when a year is known (matches the addon's year phase).
    if (year !== undefined) {
      queries.add(buildSearchQuery(type, { ...meta, name, year }));
    }
  }
  return [...queries];
}

type RunResult = {
  queries: string[];
  /** All unique files returned by the search, keyed by Easynews file hash. */
  found: Map<string, FileData>;
  /** Subset of `found` that passes isBadVideo + matchesTitle (what the addon keeps). */
  kept: Map<string, FileData>;
};

async function run(titles: string[]): Promise<RunResult> {
  const queries = buildQueries(titles);
  const found = new Map<string, FileData>();
  const kept = new Map<string, FileData>();

  for (const query of queries) {
    let res;
    try {
      res = await api.search({ ...sortOptions, query });
    } catch (err) {
      console.error(`  ! search failed for "${query}": ${(err as Error).message}`);
      continue;
    }
    const files = res?.data ?? [];
    console.error(`  · "${query}" → ${files.length} raw results`);
    for (const file of files) {
      const hash = file['0'];
      if (!hash) continue;
      found.set(hash, file);
      // A file is kept if it matches ANY of this set's queries (addon behavior).
      const postTitle = getPostTitle(file);
      const matches = queries.some(q => matchesTitle(postTitle, q, strict));
      if (matches && !isBadVideo(file)) {
        kept.set(hash, file);
      }
    }
  }

  return { queries, found, kept };
}

console.error(
  `\nTitle:    "${title}"  (type=${type}${year ? `, year=${year}` : ''}${
    type === 'series' && season && episode ? `, S${season}E${episode}` : ''
  })`
);
console.error(`Strict matching: ${strict}\n`);

const nordicVariants = getNordicTransliterations(title);
if (nordicVariants.length === 0) {
  console.error(
    `"${title}" contains no Scandinavian letters (æ/ø/å); this title is unaffected by the fix.`
  );
}

console.error('BEFORE (original title only):');
const before = await run([title]);

console.error(`\nAFTER (original + transliterations: ${nordicVariants.join(', ') || '—'}):`);
const after = await run([title, ...nordicVariants]);

// Files retrieved/kept only thanks to the added variants.
const newFound = [...after.found.keys()].filter(h => !before.found.has(h));
const newKept = [...after.kept.keys()].filter(h => !before.kept.has(h));

const fmt = (n: number) => n.toString().padStart(4);
console.log('\n========================= RESULT =========================');
console.log(
  `Queries issued        BEFORE: ${before.queries.length}   AFTER: ${after.queries.length}`
);
console.log(
  `Unique files found    BEFORE:${fmt(before.found.size)}   AFTER:${fmt(after.found.size)}   (+${newFound.length})`
);
console.log(
  `Streams kept (match)  BEFORE:${fmt(before.kept.size)}   AFTER:${fmt(after.kept.size)}   (+${newKept.length})`
);
console.log('==========================================================');

if (newKept.length > 0) {
  console.log(`\nExamples of streams found ONLY after the fix (up to 10):`);
  for (const hash of newKept.slice(0, 10)) {
    console.log(`  • ${getPostTitle(after.kept.get(hash)!)}`);
  }
}

if (nordicVariants.length > 0 && newFound.length === 0) {
  console.log(
    '\nNote: no additional results this time. That can be legitimate — the ' +
      'ASCII-spelled releases may simply not exist on Easynews for this title.'
  );
}
