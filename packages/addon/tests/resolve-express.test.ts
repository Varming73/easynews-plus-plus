import { describe, expect, it, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import { createResolveHandler } from '../src/resolve-express';
import { clearResolvedUrlCache } from '../src/resolve';

/**
 * Regression tests for the Express /resolve handler.
 *
 * The handler issues an outbound `Range: bytes=0-0` request via follow-redirects
 * only to capture the final (tokenized) CDN URL, then 307-redirects the player.
 * Historically it left that upstream response unconsumed, so the idle keep-alive
 * socket tripped the request `timeout` 20s LATER — AFTER a successful redirect —
 * and logged `error: Timed out resolving stream` + `resolve timeout`. Those are
 * false-positive error logs for a request that actually succeeded.
 *
 * We inject a fake https client so we can drive the response/timeout/error events
 * deterministically without real network or the easynews.com host allow-list.
 */

// A valid easynews HTTPS payload (base64url of an easynews /dl URL with u/p creds)
// so parseResolvePayload accepts it; the fake client ignores the URL itself.
const CLEAN_URL = 'https://members.easynews.com/dl/0/448/abc.mkv/Movie.mkv';
const PAYLOAD = Buffer.from(`${CLEAN_URL}?u=user&p=pass`).toString('base64url');
const FINAL_URL = 'https://ams-dl-02.easynews.com:448/dl/token/Movie.mkv';

function makeFakeClient() {
  // Captures the response callback and returns a controllable fake request.
  const fakeReq = new EventEmitter() as EventEmitter & {
    end: () => void;
    destroy: (e?: Error) => void;
  };
  fakeReq.end = vi.fn();
  fakeReq.destroy = vi.fn((e?: Error) => {
    if (e) fakeReq.emit('error', e);
  });

  let responseCb: ((u: unknown) => void) | undefined;
  const client = {
    request: vi.fn((_url: string, _opts: unknown, cb: (u: unknown) => void) => {
      responseCb = cb;
      return fakeReq;
    }),
  };
  return { client, fakeReq, fireResponse: (u: unknown) => responseCb!(u) };
}

function makeRes() {
  const res = {
    headersSent: false,
    redirect: vi.fn(() => {
      res.headersSent = true;
    }),
    status: vi.fn(() => res),
    send: vi.fn(() => res),
  };
  return res;
}

describe('createResolveHandler — no false timeout after a successful redirect', () => {
  beforeEach(() => clearResolvedUrlCache());

  it('307-redirects, caches, drains the upstream, and ignores a later timeout', async () => {
    const logger = { error: vi.fn(), debug: vi.fn() };
    const { client, fakeReq, fireResponse } = makeFakeClient();
    const handler = createResolveHandler({
      logger,
      httpsClient: client as never,
      httpClient: client as never,
    });

    const req = { params: { payload: PAYLOAD, filename: 'Movie.mkv' } };
    const res = makeRes();

    await handler(req as never, res as never);

    // Simulate the successful upstream response (a real redirect occurred).
    const upstream = { responseUrl: FINAL_URL, destroy: vi.fn(), resume: vi.fn() };
    fireResponse(upstream);

    // Player is redirected to the tokenized CDN URL.
    expect(res.redirect).toHaveBeenCalledWith(307, FINAL_URL);
    // The upstream socket is torn down so it cannot idle into a timeout.
    expect(upstream.destroy).toHaveBeenCalled();

    // Now the (previously fatal) idle timeout fires AFTER success.
    fakeReq.emit('timeout');

    // It must NOT be logged as an error and must NOT emit a 504.
    expect(logger.error).not.toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('still reports a real timeout that happens BEFORE any response', async () => {
    const logger = { error: vi.fn(), debug: vi.fn() };
    const { client, fakeReq } = makeFakeClient();
    const handler = createResolveHandler({
      logger,
      httpsClient: client as never,
      httpClient: client as never,
    });

    const req = { params: { payload: PAYLOAD, filename: 'Movie.mkv' } };
    const res = makeRes();
    await handler(req as never, res as never);

    // No response ever arrives; the socket times out.
    fakeReq.emit('timeout');

    expect(logger.error).toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(504);
  });
});
