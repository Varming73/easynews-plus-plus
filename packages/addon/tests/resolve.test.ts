import { describe, expect, it, beforeEach } from 'vitest';
import {
  isAllowedEasynewsHost,
  parseResolvePayload,
  stripAuthOnForeignHost,
  ResolveError,
  getCachedResolvedUrl,
  setCachedResolvedUrl,
  clearResolvedUrlCache,
} from '../src/resolve';

const encode = (s: string) => Buffer.from(s, 'utf-8').toString('base64url');

describe('isAllowedEasynewsHost', () => {
  it('allows easynews.com and its subdomains', () => {
    expect(isAllowedEasynewsHost('easynews.com')).toBe(true);
    expect(isAllowedEasynewsHost('members.easynews.com')).toBe(true);
    expect(isAllowedEasynewsHost('a.b.easynews.com')).toBe(true);
  });

  it('blocks look-alike and embedded-domain bypasses (SSRF guard)', () => {
    expect(isAllowedEasynewsHost('easynews.com.attacker.com')).toBe(false);
    expect(isAllowedEasynewsHost('evileasynews.com')).toBe(false);
    expect(isAllowedEasynewsHost('easynews.evil.com')).toBe(false);
    expect(isAllowedEasynewsHost('attacker.com')).toBe(false);
    expect(isAllowedEasynewsHost('169.254.169.254')).toBe(false);
  });
});

describe('parseResolvePayload', () => {
  it('decodes an easynews URL and strips credentials into a Basic auth header', () => {
    const target = 'https://members.easynews.com/dl/file.mkv?u=alice&p=secret';
    const result = parseResolvePayload(encode(target));
    expect(result.cleanUrl).toBe('https://members.easynews.com/dl/file.mkv');
    expect(result.cleanUrl).not.toContain('alice');
    expect(result.cleanUrl).not.toContain('secret');
    expect(result.authHeader).toBe('Basic ' + Buffer.from('alice:secret').toString('base64'));
  });

  it('rejects a payload whose host is not easynews.com with a 403', () => {
    const target = 'https://attacker.com/x?u=a&p=b';
    expect(() => parseResolvePayload(encode(target))).toThrowError(ResolveError);
    try {
      parseResolvePayload(encode(target));
    } catch (e) {
      expect((e as ResolveError).status).toBe(403);
    }
  });

  it('rejects a userinfo-smuggling bypass (host is the part after @)', () => {
    const target = 'https://members.easynews.com@attacker.com/x?u=a&p=b';
    try {
      parseResolvePayload(encode(target));
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as ResolveError).status).toBe(403);
    }
  });

  it('rejects an empty payload with a 400', () => {
    try {
      parseResolvePayload('');
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as ResolveError).status).toBe(400);
    }
  });

  it('rejects a payload that does not decode to a valid URL with a 400', () => {
    try {
      parseResolvePayload(encode('not a url'));
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as ResolveError).status).toBe(400);
    }
  });

  it('rejects a non-HTTPS scheme so credentials are never sent in plaintext', () => {
    const target = 'http://members.easynews.com/dl/file.mkv?u=a&p=b';
    try {
      parseResolvePayload(encode(target));
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as ResolveError).status).toBe(400);
    }
  });
});

describe('stripAuthOnForeignHost (redirect credential-leak guard)', () => {
  it('keeps the Authorization header when redirected within the same host', () => {
    const before = stripAuthOnForeignHost('members.easynews.com');
    const options = {
      hostname: 'members.easynews.com',
      headers: { Authorization: 'Basic xxx', Range: 'bytes=0-0' },
    };
    before(options);
    expect(options.headers.Authorization).toBe('Basic xxx');
  });

  it('strips the Authorization header on a cross-host redirect', () => {
    const before = stripAuthOnForeignHost('members.easynews.com');
    const options = {
      hostname: 'cdn.some-other-host.net',
      headers: { Authorization: 'Basic xxx', Range: 'bytes=0-0' } as Record<string, string>,
    };
    before(options);
    expect(options.headers.Authorization).toBeUndefined();
    // non-credential headers are preserved
    expect(options.headers.Range).toBe('bytes=0-0');
  });

  it('preserves auth on a same-host redirect even when only host (with port) is set', () => {
    // follow-redirects normally populates `hostname`, but guard against a shape
    // where only `host` (which includes the port) is present — the port must not
    // make a same-host hop look cross-host and strip the credentials.
    const before = stripAuthOnForeignHost('members.easynews.com');
    const options = {
      host: 'members.easynews.com:443',
      headers: { Authorization: 'Basic xxx' } as Record<string, string>,
    };
    before(options);
    expect(options.headers.Authorization).toBe('Basic xxx');
  });
});

describe('resolved-URL cache', () => {
  beforeEach(() => clearResolvedUrlCache());

  it('returns null for an unknown payload', () => {
    expect(getCachedResolvedUrl('nope')).toBeNull();
  });

  it('stores and returns a resolved URL keyed by payload', () => {
    setCachedResolvedUrl('payloadA', 'https://cdn.easynews.com/dl/tokenA/file.mkv');
    expect(getCachedResolvedUrl('payloadA')).toBe('https://cdn.easynews.com/dl/tokenA/file.mkv');
    // Different payload (e.g. different account) does not share the entry.
    expect(getCachedResolvedUrl('payloadB')).toBeNull();
  });

  it('clearResolvedUrlCache empties the cache', () => {
    setCachedResolvedUrl('payloadA', 'https://cdn.easynews.com/dl/tokenA/file.mkv');
    clearResolvedUrlCache();
    expect(getCachedResolvedUrl('payloadA')).toBeNull();
  });
});
