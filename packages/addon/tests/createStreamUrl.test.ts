import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { createStreamUrl, MissingBaseUrlError } from '../src/utils';

const RES = {
  downURL: 'https://members.easynews.com',
  dlFarm: 'farm1',
  dlPort: '8080',
} as unknown as Parameters<typeof createStreamUrl>[0];
const FILE = 'dir/My.Movie.2020.mkv';
const USER = 'alice';
const PASS = 'secret';

describe('createStreamUrl — secure-by-default credential handling', () => {
  let savedBase: string | undefined;
  let savedInsecure: string | undefined;

  beforeEach(() => {
    savedBase = process.env.ADDON_BASE_URL;
    savedInsecure = process.env.ALLOW_INSECURE_CREDENTIAL_URLS;
    delete process.env.ADDON_BASE_URL;
    delete process.env.ALLOW_INSECURE_CREDENTIAL_URLS;
  });

  afterEach(() => {
    if (savedBase === undefined) delete process.env.ADDON_BASE_URL;
    else process.env.ADDON_BASE_URL = savedBase;
    if (savedInsecure === undefined) delete process.env.ALLOW_INSECURE_CREDENTIAL_URLS;
    else process.env.ALLOW_INSECURE_CREDENTIAL_URLS = savedInsecure;
  });

  it('routes through the /resolve proxy when an explicit baseUrl is given (no creds in path)', () => {
    const url = createStreamUrl(RES, USER, PASS, FILE, 'https://addon.example.com');
    expect(url).toContain('https://addon.example.com/resolve/');
    expect(url.endsWith('/My.Movie.2020.mkv')).toBe(true);
    expect(url).not.toContain(`${USER}:${PASS}@`);
  });

  it('falls back to ADDON_BASE_URL env when config baseUrl is absent (still proxied)', () => {
    process.env.ADDON_BASE_URL = 'https://env.example.com';
    const url = createStreamUrl(RES, USER, PASS, FILE);
    expect(url).toContain('https://env.example.com/resolve/');
    expect(url).not.toContain(`${USER}:${PASS}@`);
  });

  it('refuses to emit a credential-bearing URL when no base is available and insecure mode is off', () => {
    expect(MissingBaseUrlError).toBeDefined();
    expect(() => createStreamUrl(RES, USER, PASS, FILE)).toThrow(MissingBaseUrlError);
  });

  it('emits the legacy credential URL only when explicitly opted in', () => {
    process.env.ALLOW_INSECURE_CREDENTIAL_URLS = 'true';
    const url = createStreamUrl(RES, USER, PASS, FILE);
    expect(url).toContain(`${USER}:${PASS}@`);
    expect(url).not.toContain('/resolve/');
  });
});
