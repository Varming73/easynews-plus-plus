import { Buffer } from 'buffer';
import { URL } from 'url';

/**
 * Shared logic for the /resolve stream proxy, used by both the Express server
 * (packages/addon/src/server.ts) and the Cloudflare Worker
 * (packages/cloudflare-worker/src/index.ts). Keeping it in one tested place
 * prevents the two implementations from drifting on security-critical details.
 */

// Only hosts under easynews.com are permitted as proxy targets. Anchored at both
// ends so look-alikes (evileasynews.com) and embedded domains
// (easynews.com.attacker.com) are rejected.
export const EASYNEWS_HOST_RE = /^([a-z0-9-]+\.)*easynews\.com$/i;

export function isAllowedEasynewsHost(host: string): boolean {
  return EASYNEWS_HOST_RE.test(host);
}

/** Error carrying the HTTP status the resolve endpoint should return. */
export class ResolveError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message);
    this.name = 'ResolveError';
  }
}

export interface ResolvedTarget {
  /** The Easynews URL with the u/p credential query params removed. */
  cleanUrl: string;
  /** Basic auth header carrying the stripped credentials. */
  authHeader: string;
}

/**
 * Decode the Base64URL `/resolve/:payload` parameter into an Easynews URL,
 * validate the host against the allow-list, and move the embedded `u`/`p`
 * credentials out of the URL and into a Basic auth header.
 *
 * Throws {@link ResolveError} (with the appropriate HTTP status) on any
 * malformed or disallowed input.
 */
export function parseResolvePayload(payloadBase64url: string): ResolvedTarget {
  if (!payloadBase64url) {
    throw new ResolveError(400, 'Missing url parameter');
  }

  let targetUrl: string;
  try {
    targetUrl = Buffer.from(payloadBase64url, 'base64url').toString('utf-8');
  } catch {
    throw new ResolveError(400, 'Invalid url encoding');
  }

  let parsed: URL;
  try {
    parsed = new URL(targetUrl);
  } catch {
    throw new ResolveError(400, 'Invalid url');
  }

  // Only HTTPS — never send the Basic auth credentials over plaintext HTTP,
  // even if a crafted payload points at an easynews.com host.
  if (parsed.protocol !== 'https:') {
    throw new ResolveError(400, 'Only HTTPS URLs are permitted');
  }

  if (!isAllowedEasynewsHost(parsed.hostname.toLowerCase())) {
    throw new ResolveError(403, 'Domain not allowed');
  }

  const username = parsed.searchParams.get('u') || '';
  const password = parsed.searchParams.get('p') || '';
  parsed.searchParams.delete('u');
  parsed.searchParams.delete('p');

  return {
    cleanUrl: parsed.toString(),
    authHeader: 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64'),
  };
}

/**
 * Short-lived cache of resolved CDN URLs, keyed by the opaque `/resolve` payload.
 *
 * The payload encodes both the file URL AND the user's credentials, so a key is
 * unique per (file, account) and a resolved URL is never served across users.
 *
 * Safety of caching a tokenized CDN URL: after the 307, the player streams that
 * URL directly for the entire file without re-authenticating, so the CDN token
 * must remain valid for at least a full playback session. A few minutes of
 * caching is therefore comfortably within the token's lifetime, while removing
 * the extra authenticated Easynews round-trip on play-start retries and on seeks
 * that re-hit /resolve. TTL is configurable and intentionally conservative.
 */
const resolvedUrlCache = new Map<string, { url: string; expires: number }>();
const RESOLVED_URL_TTL_MS = (Number(process.env.RESOLVE_CACHE_TTL_SECONDS) || 300) * 1000;
const RESOLVED_URL_MAX_ENTRIES = 5000;

export function getCachedResolvedUrl(payload: string): string | null {
  const hit = resolvedUrlCache.get(payload);
  if (!hit) return null;
  if (hit.expires <= Date.now()) {
    resolvedUrlCache.delete(payload);
    return null;
  }
  return hit.url;
}

export function setCachedResolvedUrl(payload: string, url: string): void {
  resolvedUrlCache.set(payload, { url, expires: Date.now() + RESOLVED_URL_TTL_MS });
  // Bound the map (insertion-order eviction of the oldest entries).
  while (resolvedUrlCache.size > RESOLVED_URL_MAX_ENTRIES) {
    const oldest = resolvedUrlCache.keys().next().value;
    if (oldest === undefined) break;
    resolvedUrlCache.delete(oldest);
  }
}

/** Clears the resolved-URL cache (primarily for tests). */
export function clearResolvedUrlCache(): void {
  resolvedUrlCache.clear();
}

interface RedirectOptions {
  hostname?: string;
  host?: string;
  headers?: Record<string, string | undefined>;
}

/**
 * Build a `follow-redirects` `beforeRedirect` hook that removes the
 * Authorization header whenever a redirect leaves the original host. The
 * Easynews CDN issues its own tokenized URL on redirect, so the Basic auth
 * credentials must never be forwarded to a different (potentially third-party)
 * host. Without this, an open redirect on any *.easynews.com endpoint would
 * leak the user's Easynews password to the redirect target.
 */
export function stripAuthOnForeignHost(originalHost: string) {
  const original = originalHost.toLowerCase();
  return (options: RedirectOptions): void => {
    // Prefer `hostname` (no port). Fall back to `host`, stripping any port so a
    // same-host hop like members.easynews.com:443 is not treated as cross-host.
    const raw = options.hostname || options.host || '';
    const targetHost = raw.toLowerCase().split(':')[0];
    if (targetHost && targetHost !== original && options.headers) {
      delete options.headers.Authorization;
      delete options.headers.authorization;
    }
  };
}
