export * from './addon.js';
export { default as customTemplate } from './custom-template.js';
export {
  parseResolvePayload,
  ResolveError,
  stripAuthOnForeignHost,
  getCachedResolvedUrl,
  setCachedResolvedUrl,
  clearResolvedUrlCache,
} from './resolve.js';
export { getUILanguage, sanitizeUiLanguage } from './i18n/index.js';
