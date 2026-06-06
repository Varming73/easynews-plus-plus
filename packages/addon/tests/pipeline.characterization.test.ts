import { describe, expect, it, vi, beforeEach } from 'vitest';

/**
 * Characterization tests for the stream-mapping / filtering / sorting pipeline in
 * addon.ts. Unlike addon.test.ts (which mocks all of `utils`), this suite uses
 * the REAL utils so the quality/size parsing, filtering and sort comparators are
 * actually exercised. It pins current behavior as a safety net for any future
 * refactor of that logic — it intentionally asserts what the code does today.
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

// Heterogeneous files: distinct qualities and sizes, with size order DIFFERENT
// from quality order so quality_first vs size_first are distinguishable.
const FILES = [
  fileOf({
    hash: 'a',
    title: 'Test Movie 2020 2160p BluRay',
    size: '2 GB',
    raw: 2e9,
    res: '3840x2160',
  }),
  fileOf({
    hash: 'b',
    title: 'Test Movie 2020 1080p WEB-DL',
    size: '50 GB',
    raw: 50e9,
    res: '1920x1080',
  }),
  fileOf({
    hash: 'c',
    title: 'Test Movie 2020 720p HDTV',
    size: '10 GB',
    raw: 10e9,
    res: '1280x720',
  }),
];

function fileOf(o: { hash: string; title: string; size: string; raw: number; res: string }) {
  return {
    '0': o.hash,
    '2': '.mkv',
    '4': o.size,
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

describe('stream pipeline characterization', () => {
  beforeEach(() => vi.clearAllMocks());

  it('produces one stream per unique file (deduped) with quality labels', async () => {
    const { streams } = await runHandler(baseConfig());
    expect(streams.length).toBe(3);
    const qualities = streams.map((s: any) => s.name).sort();
    expect(qualities).toContain('Easynews++\n4K');
    expect(qualities).toContain('Easynews++\n1080p');
    expect(qualities).toContain('Easynews++\n720p');
  });

  const qualityOf = (s: any) => String(s.name).split('\n')[1];

  it('quality_first sorts by quality (4K > 1080p > 720p)', async () => {
    const { streams } = await runHandler(baseConfig({ sortingPreference: 'quality_first' }));
    expect(streams.map(qualityOf)).toEqual(['4K', '1080p', '720p']);
  });

  it('size_first sorts by size (50GB[1080p] > 10GB[720p] > 2GB[4K])', async () => {
    const { streams } = await runHandler(baseConfig({ sortingPreference: 'size_first' }));
    expect(streams.map(qualityOf)).toEqual(['1080p', '720p', '4K']);
  });

  it('showQualities filters to only the requested qualities', async () => {
    const { streams } = await runHandler(baseConfig({ showQualities: '1080p' }));
    expect(streams.map(qualityOf)).toEqual(['1080p']);
  });

  it('strictTitleMatching still accepts titles that contain the movie name', async () => {
    const { streams } = await runHandler(baseConfig({ strictTitleMatching: 'true' }));
    expect(streams.length).toBe(3);
  });

  it('maxFileSize (GB) filters out files larger than the cap', async () => {
    // Files: 4K=2GB, 1080p=50GB, 720p=10GB. A 5 GB cap keeps only the 2GB file.
    const { streams } = await runHandler(baseConfig({ maxFileSize: '5' }));
    expect(streams.map(qualityOf)).toEqual(['4K']);
  });

  it('emits behaviorHints: bingeGroup (per quality) and videoSize (bytes)', async () => {
    const { streams } = await runHandler(baseConfig({ sortingPreference: 'quality_first' }));
    const fourK = streams.find((s: any) => qualityOf(s) === '4K');
    expect(fourK.behaviorHints.videoSize).toBe(2e9); // rawSize of the 4K file
    // bingeGroup is stable and tier-specific so episodes auto-continue per quality.
    expect(fourK.behaviorHints.bingeGroup).toContain('easynews-plus-plus');
    expect(fourK.behaviorHints.bingeGroup).toContain('4K');
    const teneighty = streams.find((s: any) => qualityOf(s) === '1080p');
    expect(teneighty.behaviorHints.bingeGroup).not.toBe(fourK.behaviorHints.bingeGroup);
  });

  it('does not leak the internal _sort field to clients', async () => {
    const { streams } = await runHandler(baseConfig());
    for (const s of streams) expect((s as any)._sort).toBeUndefined();
  });
});
