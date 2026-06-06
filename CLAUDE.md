# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Easynews++ is a [Stremio addon](https://stremio.github.io/stremio-addon-guide/) that searches Easynews (a Usenet provider) and returns playable video streams. A user configures it with their Easynews credentials and preferences; Stremio then calls the addon's stream handler with an IMDb id (`tt...`), and the addon searches Easynews, filters/sorts results, and returns stream URLs.

> Note: upstream (`github.com/panteLx/easynews-plus-plus`) was discontinued June 2025. This is a fork.

## Commands

This is an **npm workspaces monorepo**. Run all commands from the repo root.

```bash
# Build — order matters (packages depend on each other via file: links)
npm run build            # shared → api → addon
npm run build:cf         # ...also cloudflare-worker

# Develop
npm run dev              # addon server with tsx watch (Express, default port 1337)
npm run dev:cf           # cloudflare-worker via wrangler dev (needs wrangler.toml — see below)
npm run start            # run the built addon: node dist/server.js

# Test (vitest)
npm test                                   # all workspaces
npm -w packages/addon test                 # one package
npm -w packages/addon test -- utils        # one file (substring match on path)
npm -w packages/addon test -- -t "matchesTitle"   # one test by name
npm run test:coverage

# Quality
npm run typecheck        # tsc --noEmit across the repo
npm run format           # prettier --write
npm run format:check

# Deploy / release
npm run deploy:cf        # build:cf + wrangler deploy
npm run release          # bumpp (version bump + tag)
```

Node >= 20, npm >= 7. For the Cloudflare worker, copy `packages/cloudflare-worker/wrangler.toml.example` to `wrangler.toml` first.

## Architecture

Four packages under `packages/`, built in dependency order via TypeScript project references (`tsc --build`):

- **shared** — winston-based `createLogger` (and `getVersion`). Used by every other package.
- **api** — `EasynewsAPI` class (`api.ts`). The only code that talks to Easynews (`members.easynews.com/2.0/search/solr-search/advanced`, HTTP Basic auth). Has its own in-memory per-query cache (`CACHE_TTL` hours, default 24). `search()` is one page; `searchAll()` paginates with duplicate detection.
- **addon** — the Stremio addon itself. This is where almost all logic lives.
- **cloudflare-worker** — a thin [Hono](https://hono.dev) wrapper that re-exports the same `addonInterface` from the addon package for serverless deployment. It imports built artifacts (`easynews-plus-plus-addon/dist/...`), so **the addon must be built before the worker**.

### Addon package (`packages/addon/src/`)

- **`addon.ts`** — the heart. Defines the Stremio stream handler via `addonBuilder.defineStreamHandler`. The flow for each request:
  1. Read per-user config (credentials + preferences) passed in the request, applying `DEFAULT_CONFIG`.
  2. Check the addon-level in-memory request cache (30 min TTL, key includes all settings).
  3. Resolve metadata for the IMDb id (`publicMetaProvider`), then build a list of title variants (original + `custom-titles.json` entries + TMDB translations + partial matches).
  4. Search each title variant (with and without year), accumulating unique results (dedup by file hash `file['0']`) up to `TOTAL_MAX_RESULTS`.
  5. Reject results that don't match the title (`matchesTitle`, honoring the `strictTitleMatching` setting).
  6. Map files to Stremio `Stream` objects, **filter** (quality / max file size / max-per-quality), then **sort** by the user's `sortingPreference` (`quality_first` | `language_first` | `size_first` | `date_first`).
  7. Cache and return.
  - Sorting/quality-scoring logic is duplicated between the unfiltered and filtered passes — keep both in sync when changing it. Streams carry a temporary `_temp.file` property used during sorting.
- **`meta.ts`** — `publicMetaProvider`: tries IMDb suggestion API first, falls back to Cinemeta (`v3-cinemeta.strem.io`). When `TMDB_API_KEY` is set and a preferred language is chosen, fetches translated titles from TMDB as extra search variants.
- **`server.ts`** — Express host for self-hosting. Wraps the Stremio SDK router and adds:
  - `GET /configure` — the configuration landing page (localized).
  - `GET /resolve/:payload/:filename` — **stream proxy/resolver**. `:payload` is a base64url-encoded Easynews URL carrying credentials as query params; the endpoint validates the host is `*.easynews.com`, strips credentials into a Basic auth header, does a `Range: bytes=0-0` request, and 307-redirects to the real CDN URL. The Cloudflare worker reimplements this same endpoint in `cloudflare-worker/src/index.ts`.
- **`manifest.ts`** — the Stremio manifest, including the `config` array that defines the configuration form fields (uiLanguage, username, password, strictTitleMatching, preferredLanguage, sortingPreference, showQualities, maxResultsPerQuality, maxFileSize).
- **`i18n/index.ts`** — all UI translations and language-code maps (ISO 639-2 ↔ 639-1, used for TMDB). Large single file.
- **`custom-template.ts`** — renders the configuration/landing HTML from the manifest.
- **`utils.ts`** — search-query building, title matching, quality/size/duration parsing, stream URL construction.

### Cross-cutting notes

- **Config flows through the URL**: Stremio encodes user settings into the request path; the addon reads them per-request (`config` arg). There is no server-side user store.
- **`custom-titles.json`** (repo root) is imported at build time into the addon (and version/description come from the root `package.json`). For Docker, it's mounted as a volume so it can be edited without rebuilding.
- **Two cache layers**: api-level (per search query) and addon-level (per stream request). Both are in-memory `Map`s — they reset on restart and are not shared across worker instances.
- **Tuning via env vars** (see `.env.example`): `PORT`, `EASYNEWS_LOG_LEVEL`, `TOTAL_MAX_RESULTS`, `MAX_PAGES`, `MAX_RESULTS_PER_PAGE`, `CACHE_TTL`, `TMDB_API_KEY`. The worker uses `wrangler.toml` vars instead of `.env`.
</content>
</invoke>
