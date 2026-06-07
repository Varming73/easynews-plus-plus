import type { Request, Response } from 'express';
import type { IncomingMessage } from 'http';
import { URL } from 'url';
// follow-redirects is CommonJS; under ESM it must be default-imported, then destructured
import followRedirects from 'follow-redirects';
import {
  parseResolvePayload,
  ResolveError,
  stripAuthOnForeignHost,
  getCachedResolvedUrl,
  setCachedResolvedUrl,
} from './resolve.js';

const { http: defaultHttp, https: defaultHttps } = followRedirects;

interface ResolveLogger {
  error: (message: string, ...meta: unknown[]) => void;
}

export interface ResolveHandlerDeps {
  logger: ResolveLogger;
  /** Socket timeout in ms for the upstream Easynews request (default 20s). */
  timeoutMs?: number;
  /** Injectable for tests; defaults to follow-redirects' http/https. */
  httpClient?: typeof defaultHttp;
  httpsClient?: typeof defaultHttps;
}

/**
 * Build the Express GET /resolve/:payload/:filename handler.
 *
 * Extracted from server.ts so it can be unit-tested without importing the
 * self-starting server module. The Cloudflare worker implements the equivalent
 * logic with `fetch` + `redirect: 'manual'` (see cloudflare-worker/src/index.ts).
 */
export function createResolveHandler(deps: ResolveHandlerDeps) {
  const { logger } = deps;
  const timeoutMs = deps.timeoutMs ?? 20_000;
  const http = deps.httpClient ?? defaultHttp;
  const https = deps.httpsClient ?? defaultHttps;

  return async (req: Request, res: Response): Promise<void> => {
    const payload = req.params.payload as string;

    // Serve a recently-resolved CDN URL without re-hitting Easynews (see the
    // cache rationale in ./resolve.ts). Still 307 so the player behaves the same.
    const cachedUrl = getCachedResolvedUrl(payload);
    if (cachedUrl) {
      res.redirect(307, cachedUrl);
      return;
    }

    // Decode + validate the payload and strip credentials into a Basic auth
    // header (shared with the Cloudflare worker, see ./resolve.ts).
    let cleanUrl: string;
    let authHeader: string;
    try {
      ({ cleanUrl, authHeader } = parseResolvePayload(payload));
    } catch (err) {
      if (err instanceof ResolveError) {
        res.status(err.status).send(err.message);
        return;
      }
      res.status(400).send('Invalid request');
      return;
    }

    // Choose the correct client
    const client = cleanUrl.startsWith('https:') ? https : http;
    const originalHost = new URL(cleanUrl).hostname;

    // Once we have successfully redirected the player we are done with the
    // upstream request. follow-redirects keeps the (keep-alive) socket open, so
    // without an explicit teardown the idle socket trips the `timeout` event
    // ~timeoutMs LATER — after a successful redirect — producing spurious
    // `error`-level logs. `settled` makes the timeout/error handlers no-ops once
    // the response has been sent.
    let settled = false;

    // follow-redirects supports maxRedirects/beforeRedirect at runtime but its
    // bundled types omit them; widen the options type locally.
    const requestOptions: import('http').RequestOptions & {
      maxRedirects?: number;
      beforeRedirect?: (options: {
        hostname?: string;
        host?: string;
        headers?: Record<string, string | undefined>;
      }) => void;
    } = {
      method: 'GET',
      headers: {
        Authorization: authHeader,
        Range: 'bytes=0-0', // only fetch first byte
      },
      maxRedirects: 5,
      // Abort a hung Easynews connection instead of holding the socket open
      // indefinitely (mirrors the 20s timeout on the search request in api.ts).
      timeout: timeoutMs,
      // Strip the Authorization header on any cross-host hop so the user's
      // Easynews credentials are never forwarded off easynews.com.
      beforeRedirect: stripAuthOnForeignHost(originalHost),
    };

    // GET-only request with Range header to follow redirects and get final URL.
    const request = client.request(
      cleanUrl,
      requestOptions,
      // Redirect client to the real CDN URL
      (upstream: IncomingMessage & { responseUrl?: string }) => {
        const finalUrl = upstream.responseUrl || cleanUrl;
        // Only cache when an actual redirect to a different URL occurred (i.e. the
        // tokenized, self-authorizing CDN URL). follow-redirects sets responseUrl
        // even when NO redirect happened, in which case it equals cleanUrl — the
        // credential-stripped members URL that would 401 on its own. Caching that
        // would amplify failures, and it matches the Worker (caches Location only).
        if (finalUrl !== cleanUrl) setCachedResolvedUrl(payload, finalUrl);
        settled = true;
        res.redirect(307, finalUrl);
        // We only needed the headers (the final URL). Drain and destroy the
        // upstream response so its idle keep-alive socket cannot later fire the
        // request `timeout` and log a false failure for a request that succeeded.
        upstream.resume?.();
        upstream.destroy?.();
      }
    );

    // The 'timeout' event fires but does not abort on its own — destroy the
    // request so it doesn't hang, and respond 504. After a successful redirect
    // (`settled`) it is a benign idle-socket timeout, so ignore it.
    request.on('timeout', () => {
      if (settled) return;
      logger.error(`Timed out resolving stream ${cleanUrl}`);
      request.destroy(new Error('resolve timeout'));
      if (!res.headersSent) res.status(504).send('Timed out resolving stream');
    });

    request.on('error', (err: Error) => {
      if (settled) return;
      logger.error(`Error resolving stream ${cleanUrl}:`, err);
      if (!res.headersSent) res.status(502).send('Error resolving stream');
    });

    request.end();
  };
}
