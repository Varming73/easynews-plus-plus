import * as fsModule from 'fs';
import express, { Request, Response, NextFunction } from 'express';
import type { AddonInterface } from '@stremio-addon/sdk';
// follow-redirects is CommonJS; under ESM it must be default-imported, then destructured
import followRedirects from 'follow-redirects';
const { http, https } = followRedirects;
import { IncomingMessage } from 'http';
import path from 'path';
import { getRouter } from '@stremio-addon/node-express';
import customTemplate from './custom-template.js';
import { addonInterface } from './addon.js';
import { URL } from 'url';
import { createLogger, getVersion } from 'easynews-plus-plus-shared';
import { sanitizeUiLanguage } from './i18n/index.js';
import {
  parseResolvePayload,
  ResolveError,
  stripAuthOnForeignHost,
  getCachedResolvedUrl,
  setCachedResolvedUrl,
} from './resolve.js';

// Create a logger with server prefix and explicitly set the level from environment variable
export const logger = createLogger({
  prefix: 'Server',
  level: process.env.EASYNEWS_LOG_LEVEL || undefined, // Use the environment variable if set
});

type ServerOptions = {
  port?: number;
  cache?: number;
  cacheMaxAge?: number;
  static?: string;
};

// Helper function to create a deep clone of the manifest with a specified language
function createManifestWithLanguage(addonInterface: AddonInterface, lang: string) {
  const manifest = JSON.parse(JSON.stringify(addonInterface.manifest)); // Deep clone
  // SECURITY: `lang` is attacker-controllable (?lang= query param). Constrain it
  // to the known UI-language allow-list before it is stored in the manifest and
  // later rendered into the configuration page's inline script (reflected XSS).
  const safeLang = sanitizeUiLanguage(lang);
  logger.debug(`Creating manifest clone for language: ${safeLang}`);

  // Find and update the uiLanguage field
  if (manifest.config) {
    const uiLangFieldIndex = manifest.config.findIndex((field: any) => field.key === 'uiLanguage');
    if (uiLangFieldIndex >= 0 && lang) {
      logger.debug(`Setting language in manifest to: ${safeLang}`);
      manifest.config[uiLangFieldIndex].default = safeLang;
    } else {
      logger.debug(`No language field found in manifest or empty language: ${lang}`);
    }
  }

  return manifest;
}

function serveHTTP(addonInterface: AddonInterface, opts: ServerOptions = {}) {
  if (!addonInterface?.manifest) {
    throw new Error('first argument must be an addon interface');
  }

  logger.debug(`Creating Express server with options: ${JSON.stringify(opts)}`);
  const app = express();

  // Handle Cache-Control
  const cacheMaxAge = opts.cacheMaxAge || opts.cache;
  if (cacheMaxAge) {
    logger.debug(`Setting cache max age to: ${cacheMaxAge}`);
    app.use((_: Request, res: Response, next: NextFunction) => {
      if (!res.getHeader('Cache-Control'))
        res.setHeader('Cache-Control', 'max-age=' + cacheMaxAge + ', public');
      next();
    });
  }

  // Use the standard router from the SDK
  app.use(getRouter(addonInterface));
  logger.debug('Stremio Router middleware attached');

  // The important part: Use our custom template with internationalization
  const hasConfig = !!(addonInterface.manifest.config || []).length;
  logger.debug(`Addon has configuration: ${hasConfig}`);

  // Request logging middleware
  app.use((req: Request, _res: Response, next: NextFunction) => {
    logger.debug(`Received ${req.method} request for: ${req.originalUrl || req.url}`);
    next();
  });

  // Landing page
  app.get('/', (req: Request, res: Response) => {
    logger.debug(`Handling root request with query params: ${JSON.stringify(req.query)}`);
    if (hasConfig) {
      // Pass any language parameter to the configure route (URL-encoded so it
      // cannot inject extra query parameters into the redirect target).
      const lang = (req.query.lang as string) || '';
      const redirectUrl = lang ? `/configure?lang=${encodeURIComponent(lang)}` : '/configure';
      logger.debug(`Redirecting to configuration page: ${redirectUrl}`);
      res.redirect(redirectUrl);
    } else {
      res.setHeader('content-type', 'text/html');
      res.setHeader('X-Frame-Options', 'DENY');
      res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
      res.setHeader('X-Content-Type-Options', 'nosniff');
      // Generate the landing HTML with the default language
      logger.debug('Generating landing page HTML with default manifest');
      const landingHTML = customTemplate(addonInterface.manifest);
      res.end(landingHTML);
    }
  });

  // Resolve endpoint for stream requests
  app.get('/resolve/:payload/:filename', async (req: Request, res: Response) => {
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
        res.redirect(307, finalUrl);
      }
    );

    request.on('error', (err: Error) => {
      logger.error(`Error resolving stream ${cleanUrl}:`, err);
      res.status(502).send('Error resolving stream');
    });

    request.end();
  });

  if (hasConfig)
    app.get('/configure', (req: Request, res: Response) => {
      // Set no-cache headers
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
      res.setHeader('content-type', 'text/html');
      // This page hosts the credential-entry form; prevent framing (clickjacking)
      // and MIME sniffing.
      res.setHeader('X-Frame-Options', 'DENY');
      res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
      res.setHeader('X-Content-Type-Options', 'nosniff');

      // Get language from query parameter
      const lang = (req.query.lang as string) || '';
      logger.debug(`Express server: Received configure request with lang=${lang}`);

      // Generate HTML with the selected language
      let tempManifest;

      // If a language is specified, create a specialized manifest for that language
      if (lang) {
        logger.debug(`Creating manifest with specific language: ${lang}`);
        tempManifest = createManifestWithLanguage(addonInterface, lang);
      } else {
        // Otherwise, use the default manifest
        logger.debug('Using default manifest (no language specified)');
        tempManifest = addonInterface.manifest;
      }

      // Generate HTML with the updated language
      logger.debug('Generating configuration page HTML');
      const landingHTML = customTemplate(tempManifest);
      res.end(landingHTML);
    });

  // Static files, if specified
  if (opts.static) {
    const location = path.join(process.cwd(), opts.static);
    logger.debug(`Setting up static file serving from: ${location}`);
    try {
      const fs = fsModule;
      if (!fs.existsSync(location)) {
        logger.debug(`Static directory does not exist: ${location}`);
        throw new Error('directory to serve does not exist');
      }
      app.use(opts.static, express.static(location));
      logger.debug(`Static file middleware attached for path: ${opts.static}`);
    } catch (e) {
      logger.error('Error setting up static directory:', e);
    }
  }

  // Start the server
  logger.debug(`Starting server on port: ${opts.port || process.env.PORT || 7000}`);
  const server = app.listen(opts.port || process.env.PORT || 7000);

  return new Promise(function (resolve, reject) {
    server.on('listening', function () {
      const addressInfo = server.address();
      const port = typeof addressInfo === 'object' ? addressInfo?.port : null;
      const url = `http://127.0.0.1:${port}/manifest.json`;
      logger.debug(`Server started successfully on port: ${port}`);
      logger.info(`Addon accessible at: ${url}`);
      resolve({ url, server });
    });
    server.on('error', err => {
      logger.debug(`Server failed to start: ${err.message}`);
      reject(err);
    });
  });
}

// Start the server with the addon interface
logger.debug(`Starting addon server with interface: ${addonInterface.manifest.id}`);
serveHTTP(addonInterface, { port: +(process.env.PORT ?? 1337) }).catch(err => {
  logger.error('Server failed to start:', err);
  process.exitCode = 1;
});

// Log environment configuration
logger.info('--- Environment configuration ---');
logger.info(`PORT: ${process.env.PORT || 'undefined'}`);
logger.info(`LOG_LEVEL: ${logger.level || 'undefined'}`);
logger.info(`VERSION: ${getVersion() || 'undefined'}`);

// Log API search configuration
logger.info('--- API search configuration ---');
logger.info(`TOTAL_MAX_RESULTS: ${process.env.TOTAL_MAX_RESULTS || 'undefined'}`);
logger.info(`MAX_PAGES: ${process.env.MAX_PAGES || 'undefined'}`);
logger.info(`MAX_RESULTS_PER_PAGE: ${process.env.MAX_RESULTS_PER_PAGE || 'undefined'}`);
logger.info(`CACHE_TTL: ${process.env.CACHE_TTL || 'undefined'}`);

// Log if TMDB is enabled
logger.info('--- TMDB configuration ---');
logger.info(`TMDB Integration: ${process.env.TMDB_API_KEY ? 'Enabled' : 'Disabled'}`);
logger.info('--- End of configuration ---');

// Log if Chatwoot is enabled
logger.info('--- Chatwoot configuration ---');
logger.info(
  `Chatwoot Integration: ${process.env.CHATWOOT_ENABLED === 'true' ? 'Enabled' : 'Disabled'}`
);
logger.info(`Chatwoot URL: ${process.env.CHATWOOT_BASE_URL || 'Not set'}`);
logger.info(`Chatwoot Token: ${process.env.CHATWOOT_WEBSITE_TOKEN || 'Not set'}`);
