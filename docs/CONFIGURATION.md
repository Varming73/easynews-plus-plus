# Configuration & Self-Hosting

This covers everything beyond the quick Docker start in the [README](../README.md): the
full environment-variable reference, alternative install methods, development setup and the
release process.

Most day-to-day settings (credentials, preferred language, sorting, quality filters) are
configured on the addon's own **configuration page** after you install it — the variables
below are for tuning a self-hosted server.

## Table of contents

- [Environment variables](#environment-variables)
- [Install from source](#install-from-source)
- [Cloudflare Worker](#cloudflare-worker)
- [Development](#development)
- [Release process](#release-process)
- [Workflows](#workflows)

---

## Environment variables

The easiest way to set these is to copy `.env.example` to `.env` in the project root. For
Docker deployments, `docker-compose.yml` already loads `.env` automatically.

### General

| Variable                  | Default | Description                                                                                                                  |
| ------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `PORT`                    | `1337`  | Port the addon server listens on.                                                                                            |
| `EASYNEWS_LOG_LEVEL`      | `info`  | Verbosity: `error`, `warn`, `info`, `debug`, `silly`, `silent`. Use `debug`/`silly` when troubleshooting.                    |
| `EASYNEWS_SUMMARIZE_LOGS` | `true`  | Group similar debug logs to reduce volume. Set `false` to see every individual line. Not available in the Cloudflare Worker. |

### Search

| Variable               | Default | Description                                  |
| ---------------------- | ------- | -------------------------------------------- |
| `TOTAL_MAX_RESULTS`    | —       | Maximum total results to return.             |
| `MAX_PAGES`            | —       | Maximum number of pages to search.           |
| `MAX_RESULTS_PER_PAGE` | —       | Maximum results per page.                    |
| `CACHE_TTL`            | `24`    | Search-results cache time-to-live, in hours. |

### Performance tuning

Safe defaults — change only if you know what you're doing.

| Variable                    | Default | Description                                                                                                                            |
| --------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `SEARCH_CONCURRENCY`        | `5`     | Title-variant searches run in parallel batches of this size (minimum `1`).                                                             |
| `META_FETCH_TIMEOUT_MS`     | `5000`  | Timeout (ms) for metadata lookups — IMDb / Cinemeta / TMDB.                                                                            |
| `MAX_CACHE_ENTRIES`         | `1000`  | Maximum entries kept in the in-memory search-results cache.                                                                            |
| `RESOLVE_CACHE_TTL_SECONDS` | `300`   | How long the `/resolve` proxy reuses a resolved CDN URL, in seconds. Applies to both the self-hosted server and the Cloudflare Worker. |

### TMDB

| Variable       | Default | Description                                                               |
| -------------- | ------- | ------------------------------------------------------------------------- |
| `TMDB_API_KEY` | —       | TMDB API key. Enables translated-title search in your preferred language. |

### Streaming / security

| Variable                         | Default | Description                                                                                                                                                                                                                                                                                                                                                                      |
| -------------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ADDON_BASE_URL`                 | —       | Public origin of this addon (e.g. `https://your-addon.example.com`). Stream URLs are routed through the addon's `/resolve` proxy so your Easynews credentials are never embedded in the URL handed to the player. Installs created via the configuration page already include their own base URL; set this only to support older installs whose saved configuration predates it. |
| `ALLOW_INSECURE_CREDENTIAL_URLS` | `false` | When `true`, restores the legacy behavior of embedding your Easynews username/password directly in stream URLs. **Insecure — leave unset/`false`** unless you understand the risk.                                                                                                                                                                                               |

> [!IMPORTANT]
> The addon no longer embeds Easynews credentials directly in stream URLs by default. If an
> existing install shows a "reconfigure" message instead of streams, either re-install it
> from the configuration page or set `ADDON_BASE_URL` on the server.

---

## Install from source

Requires **Node.js 20+** and **npm 7+**.

```bash
# Check your versions
node -v
npm -v
# Clone and install
git clone https://github.com/Varming73/easynews-plus-plus.git && cd easynews-plus-plus
npm i
# Configure
cp .env.example .env
# Run in production mode
npm run start
```

The addon is then available at `http://localhost:1337/`. Adjust the port and other settings
via `.env`.

---

## Cloudflare Worker

Deploy to Cloudflare's edge network:

```bash
git clone https://github.com/Varming73/easynews-plus-plus.git && cd easynews-plus-plus
npm i
cp .env.example .env
cp packages/cloudflare-worker/wrangler.toml.example packages/cloudflare-worker/wrangler.toml
# Deploy
npm run deploy:cf
# Preview (if enabled in your Cloudflare dashboard)
npm run preview:cf
```

The worker imports the addon's built artifacts, so the addon package must be built first —
`npm run build:cf` handles the full build order.

---

## Development

```bash
git clone https://github.com/Varming73/easynews-plus-plus.git && cd easynews-plus-plus
npm i
cp .env.example .env
npm run build
```

Development modes:

```bash
# Addon server with live reload
npm run dev
# Cloudflare worker (needs wrangler.toml — see above)
npm run dev:cf
```

Useful checks:

```bash
npm test            # run the test suite
npm run typecheck   # tsc --noEmit across the repo
npm run format      # prettier --write
```

---

## Release process

Bump the version and tag the release:

```bash
npm run release
```

> [!NOTE]
> Pushing a `v*` tag triggers the `release.yml` workflow (which creates a GitHub Release with
> an auto-generated changelog) and `docker-publish.yml` (which builds and publishes the Docker
> image to GitHub Container Registry). The package is **not** published to npm.

---

## Workflows

| Workflow             | Purpose                                                          |
| -------------------- | ---------------------------------------------------------------- |
| `pr.yml`             | Lint PR titles (conventional commits).                           |
| `test.yml`           | Build, typecheck and test across the Node version matrix.        |
| `release.yml`        | Create a GitHub Release on `v*` tags.                            |
| `docker-publish.yml` | Build and publish the Docker image to GitHub Container Registry. |

The Docker image is built and published automatically on every push to `main` and on every
version tag. Available tags are listed on the
[GitHub Packages page](https://github.com/Varming73/easynews-plus-plus/pkgs/container/easynews-plus-plus).
