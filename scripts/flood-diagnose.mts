/**
 * Read-only diagnostic for the "porn flood" / irrelevant-results problem on
 * foreign titles (e.g. Løgnen / tt31862810).
 *
 * Faithful mode (--id ttXXXXXXX): resolves metadata through the REAL
 * publicMetaProvider and builds the full `allTitles` variant set exactly as
 * addon.ts does (meta.name + alternativeNames + getAlternativeTitles partial
 * matches + Nordic transliterations), then searches every variant via the real
 * EasynewsAPI and keeps results with matchesTitle + isBadVideo. This reproduces
 * what the addon actually retrieves for a given IMDb id.
 *
 * Each kept result is dumped with parsed year (parse-torrent-title) and source
 * newsgroup (FileData['9']) so we can measure the proposed year-window gate and
 * newsgroup filter against real data.
 *
 * Usage (from repo root):
 *   EASYNEWS_USERNAME=you EASYNEWS_PASSWORD=secret \
 *     npx tsx scripts/flood-diagnose.mts --id tt31862810 --type series --lang dan
 *   # ad-hoc literal title:
 *   npx tsx scripts/flood-diagnose.mts "Løgnen" --type movie --year 2024
 *
 * Flags: --id tt..  --type movie|series  --lang <iso639-2>  --season N  --episode N
 *        --year YYYY  --loose  --debug
 * Credentials: EASYNEWS_USERNAME / EASYNEWS_PASSWORD. Read-only; writes nothing.
 */

const wantDebug = process.argv.includes('--debug');
process.env.EASYNEWS_LOG_LEVEL ||= wantDebug ? 'debug' : 'silent';

const { EasynewsAPI } = await import('easynews-plus-plus-api');
const {
  getNordicTransliterations,
  buildSearchQuery,
  matchesTitle,
  isBadVideo,
  isAdultGroup,
  isAnchoredQuery,
  getPostTitle,
  getAlternativeTitles,
} = await import('../packages/addon/src/utils.js');
const { publicMetaProvider } = await import('../packages/addon/src/meta.js');
const { parse: parseTorrentTitle } = await import('parse-torrent-title');
import type { ContentType } from '@stremio-addon/sdk';
import type { FileData, SearchOptions } from 'easynews-plus-plus-api';

function getFlag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const username = process.env.EASYNEWS_USERNAME;
const password = process.env.EASYNEWS_PASSWORD;
if (!username || !password) {
  console.error('Missing creds. Set EASYNEWS_USERNAME and EASYNEWS_PASSWORD.');
  process.exit(1);
}

const id = getFlag('id');
const type = (getFlag('type') as ContentType) ?? 'movie';
const lang = getFlag('lang');
const strict = !process.argv.includes('--loose');

type Meta = {
  name: string;
  year?: number;
  season?: string;
  episode?: string;
  alternativeNames?: string[];
};

let meta: Meta;
if (id) {
  // Faithful: exactly what addon.ts feeds the search fan-out.
  meta = (await publicMetaProvider(id, type, lang)) as Meta;
} else {
  const title = process.argv.slice(2).find(a => !a.startsWith('--')) ?? 'Løgnen';
  meta = {
    name: title,
    year: getFlag('year') ? Number(getFlag('year')) : undefined,
    season: getFlag('season'),
    episode: getFlag('episode'),
  };
}
const year = meta.year;

// Build allTitles exactly as addon.ts:349-393.
let allTitles = [meta.name];
if (meta.alternativeNames?.length) {
  allTitles.push(...meta.alternativeNames.filter(a => !allTitles.includes(a)));
}
const additional = getAlternativeTitles(meta.name).filter(
  a => !allTitles.includes(a) && a !== meta.name
);
allTitles.push(...additional);
const nordic = allTitles
  .flatMap(t => getNordicTransliterations(t))
  .filter((v, i, self) => !allTitles.includes(v) && self.indexOf(v) === i);
allTitles.push(...nordic);

const sortOptions: Partial<SearchOptions> = {
  sort1: 'relevance',
  sort1Direction: '-',
  sort2: 'dsize',
  sort2Direction: '-',
  sort3: 'dtime',
  sort3Direction: '-',
};
const api = new EasynewsAPI({ username, password });

const queries = new Set<string>();
for (const name of allTitles) {
  if (!name.trim()) continue;
  queries.add(buildSearchQuery(type, { ...meta, name, year: undefined }));
  if (year !== undefined) queries.add(buildSearchQuery(type, { ...meta, name, year }));
}

console.error(
  `\nResolved meta.name: "${meta.name}"  year=${year ?? '—'}  type=${type}  strict=${strict}`
);
console.error(`allTitles (${allTitles.length}): ${allTitles.join(', ')}`);
console.error(`Queries (${queries.size}): ${[...queries].join(' | ')}\n`);

type Kept = { hash: string; postTitle: string; parsedYear?: number; group: string; query: string };
const kept = new Map<string, Kept>();
const perQueryRaw = new Map<string, number>();
let rawTotal = 0;

for (const query of queries) {
  let res;
  try {
    res = await api.search({ ...sortOptions, query });
  } catch (err) {
    console.error(`  ! "${query}" failed: ${(err as Error).message}`);
    continue;
  }
  const files = (res?.data ?? []) as FileData[];
  perQueryRaw.set(query, files.length);
  rawTotal += files.length;
  console.error(`  · "${query}" → ${files.length} raw`);
  for (const file of files) {
    const hash = file['0'];
    if (!hash || kept.has(hash)) continue;
    const postTitle = getPostTitle(file);
    const group = String((file as Record<string, unknown>)['9'] ?? '');
    if (isBadVideo(file)) continue;
    if (isAdultGroup(group)) continue; // production gate
    // Mirror addon.ts: force strict on unanchored queries even in --loose.
    if (!matchesTitle(postTitle, query, strict || !isAnchoredQuery(query))) continue;
    kept.set(hash, {
      hash,
      postTitle,
      parsedYear: parseTorrentTitle(postTitle).year,
      group,
      query,
    });
  }
}

const rows = [...kept.values()];
console.log('\n===================== KEPT STREAMS =====================');
for (const r of rows) {
  console.log(
    `[y:${r.parsedYear ?? '----'}] [${r.group || 'no-group'}]  ${r.postTitle}   <= "${r.query}"`
  );
}

const ADULT = /(erotic|xxx|porn|sex|adult|18\+)/i;
const noYear = rows.filter(r => r.parsedYear === undefined).length;
const wouldDropYear =
  year === undefined
    ? 0
    : rows.filter(r => r.parsedYear !== undefined && Math.abs(r.parsedYear - year) > 1).length;
const adultGroup = rows.filter(r => ADULT.test(r.group)).length;

console.log('\n========================= SUMMARY =========================');
console.log(`Raw results across queries : ${rawTotal}`);
console.log(`Kept (matched, not bad)    : ${rows.length}`);
console.log(`  …with NO parsed year     : ${noYear}`);
if (year !== undefined) console.log(`Year gate (±1 of ${year}) drops  : ${wouldDropYear}`);
console.log(`In adult-looking groups    : ${adultGroup}`);
console.log('Kept-per-query:');
for (const [q, n] of perQueryRaw) {
  const k = rows.filter(r => r.query === q).length;
  console.log(`  "${q}": ${n} raw → ${k} kept`);
}
console.log('Distinct source groups:');
for (const g of [...new Set(rows.map(r => r.group))].sort()) {
  console.log(`  ${g || 'no-group'} (${rows.filter(r => r.group === g).length})`);
}
console.log('==========================================================');
