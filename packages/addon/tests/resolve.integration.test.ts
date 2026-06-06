import { describe, expect, it } from 'vitest';
import http from 'http';
import followRedirects from 'follow-redirects';
import { stripAuthOnForeignHost } from '../src/resolve';

const { http: frHttp } = followRedirects;

/**
 * Integration test exercising stripAuthOnForeignHost through the REAL
 * follow-redirects request path (the same one packages/addon/src/server.ts uses).
 * This guards against a silent no-op where follow-redirects passes the redirect
 * target host under a property our hook does not read — in which case the unit
 * tests would still pass while live credentials leaked.
 */

function startServer(handler: http.RequestListener): Promise<{ port: number; close: () => void }> {
  return new Promise(resolve => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      resolve({ port, close: () => server.close() });
    });
  });
}

function request(
  url: string,
  beforeRedirect: (o: {
    hostname?: string;
    host?: string;
    headers?: Record<string, string | undefined>;
  }) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = (
      frHttp as unknown as { request: (u: string, o: object, cb: () => void) => http.ClientRequest }
    ).request(
      url,
      {
        method: 'GET',
        headers: { Authorization: 'Basic SECRET', Range: 'bytes=0-0' },
        maxRedirects: 5,
        beforeRedirect,
      },
      () => resolve()
    );
    req.on('error', reject);
    req.end();
  });
}

describe('stripAuthOnForeignHost — real follow-redirects integration', () => {
  it('strips Authorization before it reaches a cross-host redirect target', async () => {
    let downstreamAuth: string | undefined = 'NOT_CALLED';
    let hookSawHostname: string | undefined;

    // Downstream server on `localhost` (different hostname from 127.0.0.1).
    const downstream = await startServer((req, res) => {
      downstreamAuth = req.headers.authorization;
      res.statusCode = 200;
      res.end('ok');
    });

    // Redirect server on 127.0.0.1 → localhost:<downstream> (a cross-host hop).
    const redirector = await startServer((req, res) => {
      res.statusCode = 302;
      res.setHeader('Location', `http://localhost:${downstream.port}/final`);
      res.end();
    });

    try {
      await request(`http://127.0.0.1:${redirector.port}/`, options => {
        hookSawHostname = options.hostname;
        stripAuthOnForeignHost('127.0.0.1')(options);
      });
    } finally {
      downstream.close();
      redirector.close();
    }

    // The hook must actually receive a hostname (proves the property shape).
    expect(hookSawHostname).toBe('localhost');
    // The downstream (foreign-host) server must NOT have seen the credentials.
    expect(downstreamAuth).toBeUndefined();
  });

  it('preserves Authorization on a same-host redirect (does not break playback)', async () => {
    let finalAuth: string | undefined = 'NOT_CALLED';
    let port = 0;

    const server = await startServer((req, res) => {
      if (req.url === '/final') {
        finalAuth = req.headers.authorization;
        res.statusCode = 200;
        res.end('ok');
        return;
      }
      // same-host redirect (same 127.0.0.1 host, different path)
      res.statusCode = 302;
      res.setHeader('Location', `http://127.0.0.1:${port}/final`);
      res.end();
    });
    port = server.port;

    try {
      await request(`http://127.0.0.1:${port}/`, options => {
        stripAuthOnForeignHost('127.0.0.1')(options);
      });
    } finally {
      server.close();
    }

    expect(finalAuth).toBe('Basic SECRET');
  });
});
