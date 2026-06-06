import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { publicMetaProvider } from '../src/meta';

// Route fetch by URL so we can exercise the IMDb -> Cinemeta fallback without
// real network access. A TMDB catch-all keeps the test robust regardless of
// whether TMDB_API_KEY happens to be set in the environment.
function mockFetch(imdbJson: unknown) {
  return vi.fn(async (url: unknown) => {
    const u = String(url);
    if (u.includes('media-imdb.com/suggestion')) {
      return { ok: true, json: async () => imdbJson } as unknown as Response;
    }
    if (u.includes('cinemeta')) {
      return {
        ok: true,
        json: async () => ({ meta: { name: 'Fallback Movie', year: '2020' } }),
      } as unknown as Response;
    }
    // TMDB find / anything else: no results.
    return {
      ok: true,
      json: async () => ({ movie_results: [], tv_results: [] }),
    } as unknown as Response;
  });
}

describe('publicMetaProvider — IMDb -> Cinemeta fallback', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
    vi.restoreAllMocks();
  });
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('falls back to Cinemeta when the IMDb suggestion has no matching id', async () => {
    // d is present but contains no item whose id === tt -> .find() returns undefined.
    global.fetch = mockFetch({ d: [{ id: 'tt9999999', l: 'Some Other Title' }] }) as typeof fetch;

    const meta = await publicMetaProvider('tt0000001', 'movie', '');

    expect(meta.name).toBe('Fallback Movie');
  });

  it('uses the IMDb title when the suggestion matches (no needless fallback)', async () => {
    global.fetch = mockFetch({
      d: [{ id: 'tt0000001', l: 'Imdb Movie', y: 1999 }],
    }) as typeof fetch;

    const meta = await publicMetaProvider('tt0000001', 'movie', '');

    expect(meta.name).toBe('Imdb Movie');
  });
});
