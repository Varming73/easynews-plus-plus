import { Hono } from 'hono';
import { createRouter } from '@stremio-addon/sdk';
import {
  addonInterface,
  customTemplate,
  parseResolvePayload,
  ResolveError,
  getUILanguage,
  sanitizeUiLanguage,
} from 'easynews-plus-plus-addon';
import { createLogger } from 'easynews-plus-plus-shared';

// Create a logger with CF prefix for better context and set Cloudflare environment
const logger = createLogger({ prefix: 'CF', isCloudflare: true });

// Bridge the framework-agnostic community-SDK router into Hono.
// The SDK serves the protocol endpoints (/manifest.json, /stream/...); the
// landing/configure UI is served by our own routes below.
logger.debug('Initializing Cloudflare Worker with addon interface');
const stremioRouter = createRouter(addonInterface);
const addonRouter = new Hono();
addonRouter.all('*', async c => {
  const res = await stremioRouter(c.req.raw);
  return res ?? c.notFound();
});
logger.debug('Created Stremio router with addon interface');

const app = new Hono();
logger.debug('Initialized Hono app');

// Helper function to create a deep clone of the manifest with a specified language
function createManifestWithLanguage(lang: string) {
  // SECURITY: `lang` is attacker-controllable (?lang= query param). Constrain it
  // to the known UI-language allow-list before it is stored in the manifest and
  // later rendered into the configuration page's inline script (reflected XSS).
  const safeLang = sanitizeUiLanguage(lang);
  logger.debug(`Creating manifest clone for language: ${safeLang}`);
  const manifest = structuredClone(addonInterface.manifest);

  // Find and update the uiLanguage field
  if (manifest.config) {
    const uiLangFieldIndex = manifest.config.findIndex((field: any) => field.key === 'uiLanguage');
    if (uiLangFieldIndex >= 0 && lang) {
      logger.debug(`Setting language in manifest to: ${safeLang}`);
      manifest.config[uiLangFieldIndex].default = safeLang;
      logger.debug(`Updated manifest language setting to: ${safeLang}`);
    } else {
      logger.debug(`No uiLanguage field found in manifest config or empty language`);
    }
  } else {
    logger.debug('No config found in manifest');
  }

  return manifest;
}

// Add resolve endpoint for stream requests
app.get('/resolve/:payload/:filename', async c => {
  // Expect a Base64URL-encoded URL in the payload
  const encodedUrl = c.req.param('payload');
  if (!encodedUrl) {
    return c.text('Missing url parameter', 400);
  }

  // Decode + validate the payload and strip credentials into a Basic auth header
  // (shared with the Express server, see packages/addon/src/resolve.ts).
  let cleanUrl: string;
  let authHeader: string;
  try {
    ({ cleanUrl, authHeader } = parseResolvePayload(encodedUrl));
  } catch (err) {
    if (err instanceof ResolveError) {
      return c.text(err.message, err.status as 400);
    }
    return c.text('Invalid request', 400);
  }

  try {
    // Single GET with Range header to follow redirects and only download 1 byte.
    // redirect:'manual' means the Authorization header is sent only to the
    // validated easynews host and is never forwarded to the redirect target.
    const response = await fetch(cleanUrl, {
      method: 'GET',
      headers: {
        Authorization: authHeader,
        Range: 'bytes=0-0',
      },
      redirect: 'manual',
    });

    // If we got a 3xx (redirect), grab the Location header; otherwise fall back
    const location = response.headers.get('Location') || cleanUrl;

    // Redirect to the final URL
    return c.redirect(location, 307);
  } catch (err) {
    logger.error(`Error resolving stream ${cleanUrl}:`, err);
    return c.text('Error resolving stream', 502);
  }
});

// Add the configure route for direct access with language selection
app.get('/configure', c => {
  logger.debug(`Received configure request from: ${c.req.header('user-agent')}`);

  // Set no-cache headers
  c.header('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  c.header('Pragma', 'no-cache');
  c.header('Expires', '0');
  // This page hosts the credential-entry form; prevent framing (clickjacking)
  // and MIME sniffing.
  c.header('X-Frame-Options', 'DENY');
  c.header('Content-Security-Policy', "frame-ancestors 'none'");
  c.header('X-Content-Type-Options', 'nosniff');

  const lang = c.req.query('lang') || '';
  const uiLanguage = getUILanguage(lang);

  logger.debug(
    `Cloudflare worker: Received request with lang=${lang}, using UI language ${uiLanguage}`
  );

  // Generate new HTML with the selected language
  let tempManifest;

  // If a language is specified, create a specialized manifest for that language
  if (lang) {
    logger.debug(`Creating customized manifest for language: ${lang}`);
    tempManifest = createManifestWithLanguage(lang);
  } else {
    // Otherwise, use the default manifest
    logger.debug('Using default manifest (no language specified)');
    tempManifest = addonInterface.manifest;
  }

  // Generate new HTML with the updated language
  logger.debug('Generating HTML with localized template');
  const localizedHTML = customTemplate(tempManifest);
  logger.debug(`Generated localized HTML (${localizedHTML.length} bytes)`);
  return c.html(localizedHTML);
});

// If we have a config, add a redirect from the root to configure
if ((addonInterface.manifest.config || []).length > 0) {
  logger.debug('Addon has configuration, setting up root redirect');
  app.get('/', c => {
    logger.debug(`Received root request from: ${c.req.header('user-agent')}`);

    // Pass any language parameter to the configure route (URL-encoded so it
    // cannot inject extra query parameters into the redirect target).
    const lang = c.req.query('lang') || '';
    const redirectUrl = lang ? `/configure?lang=${encodeURIComponent(lang)}` : '/configure';
    logger.debug(`Cloudflare worker: Redirecting to ${redirectUrl}`);
    return c.redirect(redirectUrl);
  });
} else {
  logger.debug('Addon has no configuration, keeping default root route');
}

app.route('/', addonRouter);
logger.info('Router setup complete, Cloudflare Worker initialized');

export default app;
