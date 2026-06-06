import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

/**
 * Characterization tests for the Phase-3 bounded-concurrency search fan-out.
 *
 * The fan-out now runs title-variant searches in parallel batches instead of
 * one-at-a-time, but MUST merge results back in query order so that:
 *   - dedup-by-hash keeps the first-seen occurrence, and
 *   - the TOTAL_MAX_RESULTS cap selects the same files
 * regardless of which network request finishes first. These tests return
 * DIFFERENT results per query (something the other characterization suites don't)
 * to pin that determinism.
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

function fileOf(hash: string, marker: string) {
  return {
    '0': hash,
    '2': '.mkv',
    '4': '2 GB',
    '10': `Test Movie 2020 1080p ${marker}`,
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

const A = fileOf('A', 'AAA');
const B = fileOf('B', 'BBB');
const C = fileOf('C', 'CCC');

// The no-year query is just "Test Movie"; the with-year query contains "2020".
function dataForQuery(query: string) {
  if (query.includes('2020')) return { data: [B, C], ...DL }; // year query: B (dup), C
  return { data: [A, B], ...DL }; // no-year query: A, B
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

const markerOf = (s: any) => {
  const fn: string = s.behaviorHints?.filename || String(s.description).split('\n')[0] || '';
  if (fn.includes('AAA')) return 'A';
  if (fn.includes('BBB')) return 'B';
  if (fn.includes('CCC')) return 'C';
  return fn;
};

async function runHandler(id: string, config: Record<string, string>) {
  const handler = (global as any).streamHandler;
  return handler({ id, type: 'movie', config });
}

describe('fan-out merge/dedup/cap characterization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSearch.mockImplementation(async ({ query }: { query: string }) => dataForQuery(query));
  });

  afterEach(() => {
    delete process.env.TOTAL_MAX_RESULTS;
  });

  it('merges results across the parallel no-year + year searches and dedups by hash', async () => {
    // no-year → [A,B], year → [B,C]; B is a cross-query duplicate.
    const { streams } = await runHandler('tt0000020', baseConfig());
    expect(streams.map(markerOf).sort()).toEqual(['A', 'B', 'C']);
  });

  it('applies TOTAL_MAX_RESULTS in deterministic query order (first-seen wins)', async () => {
    // Cap of 1: processing happens in query order (no-year first → A before B/C),
    // so A must be the survivor every time regardless of which request finished first.
    process.env.TOTAL_MAX_RESULTS = '1';
    const { streams } = await runHandler('tt0000021', baseConfig());
    expect(streams.map(markerOf)).toEqual(['A']);
  });
});
