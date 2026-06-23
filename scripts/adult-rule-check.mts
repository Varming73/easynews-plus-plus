/**
 * Offline stress-test of the proposed adult filters. No API calls.
 *
 * (a) GROUP filter — regex over FileData['9']. Tested against the REAL distinct
 *     groups observed in the tt31862810 loose run (group → porn-count), to see
 *     how many porn results it catches vs misses (misses = porn in neutral groups).
 *
 * (b) TITLE filter — a candidate keyword regex, the only thing that could catch
 *     porn sitting in neutral groups. Stressed with made-up porn titles (incl.
 *     euphemistic / JAV-code / no-explicit-word cases) AND legit titles that
 *     contain trap substrings (sex/adult/xxx), to expose misses and false positives.
 */

// ---- (a) GROUP filter -------------------------------------------------------
// [group string, number of porn results seen in it] from the real loose run.
const realGroups: Array<[string, number]> = [
  ['alt.binaries.erotica', 20],
  ['alt.binaries.multimedia.erotica.amateur', 13],
  ['alt.binaries.multimedia.erotica.asian', 13],
  ['alt.binaries.erotica.erotica', 7],
  ['alt.binaries.erotica.sheep', 6],
  ['alt.binaries.erotica.sex alt.binaries.movies.erotica alt.binaries.multimedia.erotica', 5],
  ['alt.binaries.friends', 4], // NEUTRAL name, but held porn here
  ['alt.binaries.inner-sanctum', 3], // NEUTRAL
  ['alt.binaries.storage', 3], // NEUTRAL
  ['alt.binaries.movies', 2], // NEUTRAL
  ['alt.binaries.multimedia.teen.male', 2], // teen, no adult token
  ['alt.binaries.erotica.collections.rar', 2],
  ['alt.binaries.bloaf', 2], // NEUTRAL
  ['alt.binaries.mom', 1], // NEUTRAL-ish
  ['alt.binaries.x', 1], // NEUTRAL
  ['alt.binaries.nzb', 1], // NEUTRAL
  ['alt.binaries.hdtv', 1], // NEUTRAL
  ['alt.binaries.fz', 1], // NEUTRAL
  ['alt.binaries.lou', 1], // NEUTRAL
  ['alt.binaries.tun', 1], // NEUTRAL
  ['alt.binaries.big', 1], // NEUTRAL
  ['alt.binaries.frogs', 1], // NEUTRAL
  ['alt.binaries.ath', 1], // NEUTRAL
  ['alt.binaries.rudystha', 1], // NEUTRAL
  ['alt.binaries.newznzb.oscar', 1], // NEUTRAL
  ['alt.binaries.newznzb.papa', 1], // NEUTRAL
  ['alt.binaries.wtfnzb.echo', 1], // NEUTRAL
  ['alt.binaries.wtfnzb.mike', 1], // NEUTRAL
  ['alt.binaries.sex', 1],
  ['alt.binaries.pictures.erotica', 1],
  ['alt.binaries.vcd.xxx.private', 1],
  ['alt.sex.youngl', 1],
  ['alt.binaries.town.xxx', 1], // appears combined in real data
  ['alt.binaries.movies.erotica', 1],
];

// Legit groups seen holding the REAL show (must NOT be flagged):
const legitGroups = [
  'alt.binaries.wtfnzb.beta',
  'alt.binaries.friends',
  'alt.binaries.tv',
  'alt.binaries.hdtv.x264',
  'alt.binaries.boneless alt.binaries.multimedia',
  'alt.binaries.teevee',
];

const GROUP_RE = /erotic|xxx|\bsex\b|alt\.sex|adult|18\+|incest/i;

let caught = 0;
let missed = 0;
const missedGroups: string[] = [];
for (const [g, n] of realGroups) {
  if (GROUP_RE.test(g)) caught += n;
  else {
    missed += n;
    missedGroups.push(`${g} (${n})`);
  }
}
const totalPorn = realGroups.reduce((s, [, n]) => s + n, 0);

console.log('===== (a) GROUP filter vs real data =====');
console.log(`Regex: ${GROUP_RE}`);
console.log(`Porn caught : ${caught}/${totalPorn} (${Math.round((caught / totalPorn) * 100)}%)`);
console.log(`Porn missed : ${missed}  (in neutral-named groups)`);
console.log('Missed groups:\n  ' + missedGroups.join('\n  '));
const legitFalsePos = legitGroups.filter(g => GROUP_RE.test(g));
console.log(
  `Legit groups wrongly flagged: ${legitFalsePos.length ? legitFalsePos.join(', ') : 'none ✅'}`
);

// ---- (b) TITLE filter -------------------------------------------------------
const madeUpPorn = [
  // explicit
  'Hot MILF Threesome XXX 1080p WEB',
  'Teen Anal Gangbang 4K',
  // euphemistic — NO explicit keyword
  'Stepmom Takes Care of You While Dad Is Away',
  'Let Me Help You Relax Tonight 720p',
  'Naughty Neighbor Pays a Visit',
  'Mommy Knows Best - Special Surprise',
  // studio-prefixed, no keyword
  'BrazzersExxtra.24.03.01.Sia.Lust.Afternoon.Delight.1080p',
  'PervNana.22.08.06.River.Lynn.We.Take.Care.Of.Each.Other',
  'NaughtyAmerica.Lucky.Handyman.1080p.HEVC',
  // JAV / studio codes — pure codes, no English word
  'SSNI-845 1080p',
  'MUDR-304',
  'JUL-530 My Big Brother',
  'Heyzo.16.10.25.Sumire.Minato.XviD',
  // foreign
  'jacquieetmicheltv.16.02.19.siham.fr',
];

const legitTraps = [
  'Sex Education S03E01 1080p WEB',
  'Masters of Sex S04E12',
  'Sex and the City S06E20',
  'xXx Return of Xander Cage 2017 1080p', // the Vin Diesel movie
  'Adult Material S01E01', // real Channel 4 drama
  'Adults in the Room 2019', // Costa-Gavras film
  'Middlesex', // contains "sex"
  'The Essex Serpent S01E01', // contains "essex"
  'Love & Other Drugs 2010',
  'Take Care S01E01 Danish 1080p', // the actual show!
];

// Candidate: word-boundary adult keywords (deliberately conservative).
const TITLE_RE =
  /\b(xxx|porn|milf|anal|gangbang|creampie|cumshot|threesome|hardcore|brazzers|naughtyamerica|pervnana|jacquieetmichel|blowjob|footjob|bukkake)\b/i;

console.log('\n===== (b) TITLE filter stress test =====');
console.log(`Regex: ${TITLE_RE}`);
console.log('\nMade-up porn — caught? (false = MISS, the danger):');
let pornMiss = 0;
for (const t of madeUpPorn) {
  const hit = TITLE_RE.test(t);
  if (!hit) pornMiss++;
  console.log(`  ${hit ? '✅ catch' : '❌ MISS '}  ${t}`);
}
console.log(`\nMisses: ${pornMiss}/${madeUpPorn.length}`);

console.log('\nLegit titles — flagged? (true = FALSE POSITIVE, also bad):');
let legitFp = 0;
for (const t of legitTraps) {
  const hit = TITLE_RE.test(t);
  if (hit) legitFp++;
  console.log(`  ${hit ? '⚠️  FLAGGED' : '✅ ok    '}  ${t}`);
}
console.log(`\nFalse positives: ${legitFp}/${legitTraps.length}`);
