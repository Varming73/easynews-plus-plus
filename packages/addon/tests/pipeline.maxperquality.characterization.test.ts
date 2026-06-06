import { describe, expect, it, vi, beforeEach } from 'vitest';

/**
 * Characterization tests for the SUBTLE interaction between sorting and the
 * `maxResultsPerQuality` limit in addon.ts. This is the behavior Codex flagged
 * as fragile before the planned "single-sort" refactor:
 *
 *   1. streams are sorted ONCE (addon.ts:596-833) BEFORE filtering,
 *   2. the per-quality limiter (addon.ts:917-968) then `slice(0, n)`s each
 *      quality bucket IN THAT PRE-SORTED ORDER — so the first sort decides
 *      WHICH files survive the limit (membership), not just their order,
 *   3. the survivors are sorted AGAIN (addon.ts:974-1207) for final order.
 *
 * Consequence pinned here: with maxResultsPerQuality=1 and two files of the
 * SAME quality, `quality_first`/`size_first` keep the BIGGER file while
 * `date_first` keeps the NEWER one — purely because the pre-sort order feeding
 * the limiter differs. Any refactor that collapses to a single sort MUST
 * preserve this membership, or it changes which stream the user can play.
 *
 * Like pipeline.characterization.test.ts, this uses the REAL utils and pins
 * what the code does TODAY (warts included) as a refactor safety net.
 */

vi.mock('../src/manifest', () => ({
  manifest: {
    id: 'org.easynews',
    name: 'Easynews++',
    description: 'Easynews++ Addon',
    version: '1.0.0',
    catalogs: [],
    resources: ['stream'],
    types: ['movie', 'series'],
  },
}));

// Two 1080p files (BIG+OLD vs SMALL+NEW) plus one 4K file. Size order and date
// order are deliberately OPPOSITE so size-driven and date-driven pre-sorts pick
// different survivors under a per-quality limit of 1.
function fileOf(o: {
  hash: string;
  title: string;
  size: string;
  raw: number;
  res: string;
  date: string;
}) {
  return {
    '0': o.hash,
    '2': '.mkv',
    '4': o.size,
    '5': o.date, // upload date used by date_first sort (addon.ts:789)
    '10': o.title,
    '11': '.mkv',
    '14': '120m',
    type: 'VIDEO',
    rawSize: o.raw,
    fullres: o.res,
    alangs: ['eng'],
    ts: 0,
    passwd: false,
    virus: false,
    downURL: 'https://members.easynews.com/dl',
    dlFarm: 'farm',
    dlPort: 'port',
  };
}

const BIG_OLD = fileOf({
  hash: 'big',
  title: 'Test Movie 2020 1080p WEB-DL BIGOLD',
  size: '50 GB',
  raw: 50e9,
  res: '1920x1080',
  date: '2020-01-01',
});
const SMALL_NEW = fileOf({
  hash: 'small',
  title: 'Test Movie 2020 1080p WEB-DL SMALLNEW',
  size: '10 GB',
  raw: 10e9,
  res: '1920x1080',
  date: '2024-01-01',
});
const UHD = fileOf({
  hash: 'uhd',
  title: 'Test Movie 2020 2160p BluRay UHD',
  size: '2 GB',
  raw: 2e9,
  res: '3840x2160',
  date: '2022-01-01',
});

const FILES = [BIG_OLD, SMALL_NEW, UHD];

vi.mock('easynews-plus-plus-api', () => ({
  EasynewsAPI: vi.fn().mockImplementation(() => ({
    search: vi.fn().mockResolvedValue({
      data: FILES,
      downURL: 'https://members.easynews.com/dl',
      dlFarm: 'farm',
      dlPort: 'port',
    }),
  })),
}));

vi.mock('../src/meta', () => ({
  publicMetaProvider: vi.fn().mockResolvedValue({
    id: 'tt1234567',
    name: 'Test Movie',
    year: 2020,
    type: 'movie',
  }),
}));

vi.mock('../src/i18n', () => ({
  getUILanguage: vi.fn().mockReturnValue('eng'),
  translations: { eng: { errors: { authFailed: 'auth failed' } } },
  ISO_TO_LANGUAGE: { eng: 'en' },
}));

vi.mock('@stremio-addon/compat', () => ({
  addonBuilder: vi.fn().mockImplementation(() => ({
    defineStreamHandler: vi.fn().mockImplementation(handler => {
      (global as any).streamHandler = handler;
      return handler;
    }),
    getInterface: vi.fn().mockReturnValue({ manifest: {}, stream: {} }),
  })),
}));

vi.mock('easynews-plus-plus-shared', () => ({
  createLogger: vi.fn().mockReturnValue({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
  parseIntEnv: (value: string | undefined, fallback: number) => {
    if (value === undefined || value === '') return fallback;
    const n = parseInt(value, 10);
    return Number.isNaN(n) ? fallback : n;
  },
}));

vi.mock('../../../custom-titles.json', () => ({ default: {} }));
vi.mock('../src/custom-template', () => ({ default: vi.fn().mockReturnValue('<html></html>') }));

import '../src/addon';

function baseConfig(overrides: Record<string, string> = {}) {
  return {
    username: 'u',
    password: 'p',
    baseUrl: 'https://addon.test',
    strictTitleMatching: 'false',
    ...overrides,
  };
}

async function runHandler(config: Record<string, string>) {
  const handler = (global as any).streamHandler;
  return handler({ id: 'tt1234567', type: 'movie', config });
}

const qualityOf = (s: any) => String(s.name).split('\n')[1];
// The per-file marker lives in the filename behaviorHint / description line 0.
const markerOf = (s: any) => {
  const fn: string = s.behaviorHints?.filename || String(s.description).split('\n')[0] || '';
  if (fn.includes('BIGOLD')) return 'BIGOLD';
  if (fn.includes('SMALLNEW')) return 'SMALLNEW';
  if (fn.includes('UHD')) return 'UHD';
  return fn;
};

describe('maxResultsPerQuality × sort interaction (membership characterization)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('baseline: all three files map to streams with the expected quality labels', async () => {
    const { streams } = await runHandler(baseConfig());
    expect(streams.length).toBe(3);
    expect(streams.map(qualityOf).sort()).toEqual(['1080p', '1080p', '4K']);
    expect(streams.map(markerOf).sort()).toEqual(['BIGOLD', 'SMALLNEW', 'UHD']);
  });

  // The crux: with one result allowed per quality, the SURVIVING 1080p file
  // differs by sort preference because the pre-sort order feeds the limiter.
  it('quality_first + maxResultsPerQuality=1 keeps the BIGGER 1080p (BIGOLD)', async () => {
    const { streams } = await runHandler(
      baseConfig({ sortingPreference: 'quality_first', maxResultsPerQuality: '1' })
    );
    expect(streams.map(qualityOf)).toEqual(['4K', '1080p']);
    const surviving1080p = streams.filter((s: any) => qualityOf(s) === '1080p').map(markerOf);
    expect(surviving1080p).toEqual(['BIGOLD']);
  });

  it('size_first + maxResultsPerQuality=1 also keeps the BIGGER 1080p (BIGOLD)', async () => {
    const { streams } = await runHandler(
      baseConfig({ sortingPreference: 'size_first', maxResultsPerQuality: '1' })
    );
    const surviving1080p = streams.filter((s: any) => qualityOf(s) === '1080p').map(markerOf);
    expect(surviving1080p).toEqual(['BIGOLD']);
  });

  it('date_first + maxResultsPerQuality=1 keeps the NEWER 1080p (SMALLNEW)', async () => {
    const { streams } = await runHandler(
      baseConfig({ sortingPreference: 'date_first', maxResultsPerQuality: '1' })
    );
    const surviving1080p = streams.filter((s: any) => qualityOf(s) === '1080p').map(markerOf);
    // Different survivor than quality_first/size_first — THIS is the pre-sort→limiter
    // dependency a single-sort refactor must preserve.
    expect(surviving1080p).toEqual(['SMALLNEW']);
  });

  // Full ordering (no per-quality limit) for each preference, so the refactor
  // also has the final-order behavior pinned.
  it('quality_first orders 4K before both 1080p, bigger 1080p before smaller', async () => {
    const { streams } = await runHandler(baseConfig({ sortingPreference: 'quality_first' }));
    expect(streams.map(markerOf)).toEqual(['UHD', 'BIGOLD', 'SMALLNEW']);
  });

  it('size_first orders by descending size (50GB > 10GB > 2GB)', async () => {
    const { streams } = await runHandler(baseConfig({ sortingPreference: 'size_first' }));
    expect(streams.map(markerOf)).toEqual(['BIGOLD', 'SMALLNEW', 'UHD']);
  });

  it('date_first orders by descending upload date (2024 > 2022 > 2020)', async () => {
    const { streams } = await runHandler(baseConfig({ sortingPreference: 'date_first' }));
    expect(streams.map(markerOf)).toEqual(['SMALLNEW', 'UHD', 'BIGOLD']);
  });
});
