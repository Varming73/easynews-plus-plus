import { describe, expect, it, vi, beforeEach } from 'vitest';

/**
 * Characterization tests for the Phase-2 "negative caching" change: the
 * previously-uncached expensive paths now carry a positive `cacheMaxAge`, and a
 * successful-but-empty result no longer emits `cacheMaxAge: 0`.
 *
 * Pins:
 *   - empty fan-out (allSearchResults === 0)      → streams [], cacheMaxAge > 0
 *   - empty after title filtering (success path)  → streams [], cacheMaxAge > 0
 *   - non-empty success                           → streams, cacheMaxAge large
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

// Reconfigurable search result so one file can drive all three scenarios.
const mockSearch = vi.fn();

vi.mock('easynews-plus-plus-api', () => ({
  EasynewsAPI: vi.fn().mockImplementation(() => ({ search: mockSearch })),
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

const DL = { downURL: 'https://members.easynews.com/dl', dlFarm: 'farm', dlPort: 'port' };

function fileOf(title: string) {
  return {
    '0': title, // unique hash per title is fine for these tests
    '2': '.mkv',
    '4': '2 GB',
    '10': title,
    '11': '.mkv',
    '14': '120m',
    type: 'VIDEO',
    rawSize: 2e9,
    fullres: '1920x1080',
    alangs: ['eng'],
    ts: 0,
    passwd: false,
    virus: false,
    ...DL,
  };
}

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
  // Unique id per call so the addon-level requestCache doesn't serve a prior run.
  return handler({ id: config.__id ?? 'tt1234567', type: 'movie', config });
}

describe('negative caching characterization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('empty fan-out (no search results at all) returns a positive cacheMaxAge', async () => {
    mockSearch.mockResolvedValue({ data: [], ...DL });
    const res = await runHandler(baseConfig({ __id: 'tt0000010' }));
    expect(res.streams).toEqual([]);
    expect(res.cacheMaxAge).toBeGreaterThan(0);
  });

  it('empty AFTER title filtering (success path) no longer emits cacheMaxAge 0', async () => {
    // Files are returned by search but none match "Test Movie", so they are all
    // rejected and the success path runs with 0 streams.
    mockSearch.mockResolvedValue({
      data: [fileOf('Completely Unrelated Film 2020 1080p'), fileOf('Another Mismatch 2019 720p')],
      ...DL,
    });
    const res = await runHandler(baseConfig({ __id: 'tt0000011' }));
    expect(res.streams).toEqual([]);
    expect(res.cacheMaxAge).toBeGreaterThan(0);
  });

  it('non-empty success returns a large (≥ 1h) cacheMaxAge on the cold response', async () => {
    mockSearch.mockResolvedValue({ data: [fileOf('Test Movie 2020 1080p WEB-DL')], ...DL });
    const res = await runHandler(baseConfig({ __id: 'tt0000012' }));
    expect(res.streams.length).toBe(1);
    // One match ⇒ (1/10) of a week ≈ 16.8h; assert it's well above the negative-cache floor.
    expect(res.cacheMaxAge).toBeGreaterThan(3600);
  });

  // The in-process request cache must honor each entry's own cacheMaxAge, not the
  // fixed 30-min default — otherwise a short-lived empty result hides newly
  // available content for far longer than intended.
  it('expires an empty result from the in-process cache per its 10-min cacheMaxAge', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(0);
      mockSearch.mockResolvedValue({ data: [], ...DL });

      await runHandler(baseConfig({ __id: 'tt0000013' }));
      const afterCold = mockSearch.mock.calls.length;
      expect(afterCold).toBeGreaterThan(0);

      // 11 minutes later (> the 10-min empty TTL): the entry must be expired, so
      // the handler re-runs the search rather than serving a stale empty result.
      vi.setSystemTime(11 * 60 * 1000);
      await runHandler(baseConfig({ __id: 'tt0000013' }));
      expect(mockSearch.mock.calls.length).toBeGreaterThan(afterCold);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps a non-empty success in the in-process cache for the full 30-min TTL', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(0);
      mockSearch.mockResolvedValue({ data: [fileOf('Test Movie 2020 1080p WEB-DL')], ...DL });

      await runHandler(baseConfig({ __id: 'tt0000014' }));
      const afterCold = mockSearch.mock.calls.length;

      // 11 minutes later: success entries live for 30 min, so this is still a hit
      // and triggers no new searches.
      vi.setSystemTime(11 * 60 * 1000);
      await runHandler(baseConfig({ __id: 'tt0000014' }));
      expect(mockSearch.mock.calls.length).toBe(afterCold);
    } finally {
      vi.useRealTimers();
    }
  });
});
