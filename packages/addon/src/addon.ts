import type { Cache, ContentType } from '@stremio-addon/sdk';
import { addonBuilder } from '@stremio-addon/compat';
import { manifest } from './manifest.js';
import {
  buildSearchQuery,
  createStreamPath,
  createStreamUrl,
  getDuration,
  getFileExtension,
  getPostTitle,
  getQuality,
  getSize,
  isBadVideo,
  logError,
  matchesTitle,
  getAlternativeTitles,
  isAuthError,
  MissingBaseUrlError,
} from './utils.js';
import { EasynewsAPI, SearchOptions, EasynewsSearchResponse } from 'easynews-plus-plus-api';
import { publicMetaProvider } from './meta.js';
import { Stream } from './types.js';
import customTitlesJson from '../../../custom-titles.json' with { type: 'json' };
import { getUILanguage, translations } from './i18n/index.js';
import { createLogger, parseIntEnv } from 'easynews-plus-plus-shared';

// Extended configuration interface
interface AddonConfig {
  username: string;
  password: string;
  strictTitleMatching?: string;
  preferredLanguage?: string;
  sortingPreference?: string;
  showQualities?: string; // Comma-separated list of qualities to show
  maxResultsPerQuality?: string; // Max results per quality
  maxFileSize?: string; // Max file size in GB
  baseUrl?: string; // Scheme, host and (optional port)
  [key: string]: any;
}

// Create a logger with Addon prefix and explicitly set the level from environment variable
export const logger = createLogger({
  prefix: 'Addon',
  level: process.env.EASYNEWS_LOG_LEVEL || undefined, // Use the environment variable if set
});

// Helper to create a localized auth error stream
function authErrorStream(langCode: string) {
  const lang = getUILanguage(langCode);
  return {
    streams: [
      {
        name: 'Easynews++ Auth Error',
        description: translations[lang].errors.authFailed,
        url: 'https://example.com/error', // Dummy URL that won't play
        behaviorHints: {
          notWebReady: true,
        },
      },
    ],
  };
}

// Helper to surface a user-visible "reconfigure" message when no proxy base URL
// is available (e.g. an old install whose config predates the baseUrl field).
function configErrorStream() {
  return {
    streams: [
      {
        name: 'Easynews++ Config Error',
        description:
          'This addon needs to be reconfigured. Open its configuration page and re-install, ' +
          'or set the ADDON_BASE_URL environment variable on the server.',
        url: 'https://example.com/error', // Dummy URL that won't play
        behaviorHints: {
          notWebReady: true,
        },
      },
    ],
  };
}

// Default configuration values
const DEFAULT_CONFIG = {
  strictTitleMatching: 'true',
  preferredLanguage: '',
  sortingPreference: 'quality_first',
  showQualities: '4k,1080p,720p,480p',
  maxResultsPerQuality: '0',
  maxFileSize: '0',
};

const builder = new addonBuilder(manifest);

// In-memory request cache to reduce API calls and improve response times
const requestCache = new Map<string, { data: any; expiresAt: number }>();
const CACHE_TTL = 1000 * 60 * 30; // 30 minutes (default / maximum in-process TTL)
// Hard cap on entries so a public/multi-user instance can't grow the cache
// unboundedly between TTL sweeps. Mirrors the api-level cache; same env knob.
const MAX_CACHE_ENTRIES = Number(process.env.MAX_CACHE_ENTRIES) || 1000;

// Negative-cache TTLs (seconds) for the protocol-level cacheMaxAge. Short, so a
// newly-uploaded title or a recovered upstream error becomes visible soon, but
// non-zero so the expensive no-result fan-out and error paths aren't re-run on
// every single open (the most expensive requests were previously uncached).
const EMPTY_RESULT_CACHE_MAX_AGE = 60 * 10; // 10 minutes
const ERROR_CACHE_MAX_AGE = 60; // 1 minute

function getFromCache<T>(key: string): T | null {
  const cached = requestCache.get(key);
  if (!cached) return null;

  if (Date.now() > cached.expiresAt) {
    requestCache.delete(key);
    return null;
  }

  return cached.data as T;
}

// In-process TTL is per-entry: it honors the response's own cacheMaxAge (so a
// short-lived negative-cache entry, e.g. an empty result at 10 min, isn't held
// for the full 30 min), capped at CACHE_TTL so long-lived success responses
// (cacheMaxAge up to a week) still don't linger in memory beyond 30 min.
function setCache<T>(key: string, data: T): void {
  const cacheMaxAge = (data as { cacheMaxAge?: number } | null)?.cacheMaxAge;
  const ttl =
    typeof cacheMaxAge === 'number' && cacheMaxAge > 0
      ? Math.min(CACHE_TTL, cacheMaxAge * 1000)
      : CACHE_TTL;
  requestCache.set(key, { data, expiresAt: Date.now() + ttl });

  // Bound memory: Map preserves insertion order, so deleting the first key
  // evicts the oldest entry. TTL expiry is lazy (only on read), so without this
  // a flood of unique keys could grow the Map until entries expire.
  while (requestCache.size > MAX_CACHE_ENTRIES) {
    const oldest = requestCache.keys().next().value;
    if (oldest === undefined) break;
    requestCache.delete(oldest);
  }
}

// Load custom titles
let titlesFromFile: Record<string, string[]> = {};
let loadedPath = '';

try {
  // Always use the imported JSON by default
  logger.debug('Loading custom titles from imported custom-titles.json');
  titlesFromFile = customTitlesJson;
  loadedPath = 'imported';

  // Log some details about the loaded custom titles
  const numCustomTitles = Object.keys(titlesFromFile).length;
  logger.info(`Successfully loaded ${numCustomTitles} custom titles`);

  if (numCustomTitles > 0) {
    // Log an example to verify they're loaded correctly
    const examples = Object.entries(titlesFromFile).slice(0, 1);
    for (const [original, customTitles] of examples) {
      logger.debug(`Example custom title: "${original}" -> "${customTitles.join('", "')}"`);
    }
  } else {
    logger.warn(
      'No custom titles were loaded from the file. The file might be empty or have invalid format.'
    );
  }
} catch (error) {
  logger.error('Error loading custom titles file:', error);
  logger.info('Using imported custom titles as fallback');
  titlesFromFile = customTitlesJson;
}

// Import custom template for landing page
import customTemplate from './custom-template.js';

// Export landing HTML for Cloudflare Worker
export const landingHTML = customTemplate(manifest);

builder.defineStreamHandler(
  async ({ id, type, config }: { id: string; type: ContentType; config: AddonConfig }) => {
    // Apply default values for any missing configuration options
    const {
      username,
      password,
      strictTitleMatching = DEFAULT_CONFIG.strictTitleMatching,
      preferredLanguage = DEFAULT_CONFIG.preferredLanguage,
      sortingPreference = DEFAULT_CONFIG.sortingPreference,
      showQualities = DEFAULT_CONFIG.showQualities,
      maxResultsPerQuality = DEFAULT_CONFIG.maxResultsPerQuality,
      maxFileSize = DEFAULT_CONFIG.maxFileSize,
      baseUrl,
      ...options
    } = config;

    if (!id.startsWith('tt')) {
      return {
        streams: [],
      };
    }

    // Include settings in cache key to ensure
    // users with different settings get different cache results
    const cacheKey = `${id}:v3:user=${username}:strict=${strictTitleMatching === 'on' || strictTitleMatching === 'true'}:lang=${preferredLanguage || ''}:sort=${sortingPreference}:qualities=${showQualities || ''}:maxPerQuality=${maxResultsPerQuality || ''}:maxSize=${maxFileSize || ''}`;

    // Redact the username when logging the cache key.
    logger.debug(`Cache key: ${cacheKey.replace(`user=${username}`, 'user=***')}`);
    const cached = getFromCache<{ streams: Stream[] }>(cacheKey);

    if (cached) {
      return cached;
    }

    try {
      if (!username || !password) {
        // Instead of throwing error, return a single stream with error message
        return authErrorStream(config.preferredLanguage || '');
      }

      const useStrictMatching = strictTitleMatching === 'on' || strictTitleMatching === 'true';
      if (!config.strictTitleMatching) {
        logger.info(`Using default strictTitleMatching: ${strictTitleMatching}`);
      } else {
        // Parse strictTitleMatching option (checkbox returns string 'on' or undefined)
        logger.info(`Strict title matching: ${useStrictMatching ? 'enabled' : 'disabled'}`);
      }

      const preferredLang = preferredLanguage || '';
      if (!config.preferredLanguage) {
        logger.info(`Using default preferredLanguage: ${preferredLanguage || 'No preference'}`);
      } else {
        // Get preferred language from configuration
        logger.info(
          `Preferred language: ${preferredLanguage ? preferredLanguage : 'No preference'}`
        );
      }

      // Parse quality filters
      const qualityFilters = showQualities
        ? showQualities
            .split(',')
            .map(q => q.trim().toLowerCase())
            .filter(Boolean)
        : ['4k', '1080p', '720p', '480p'];

      if (!config.showQualities) {
        logger.info('Using default showQualities: ' + showQualities);
      } else {
        logger.info(`Quality filters: ${qualityFilters.join(', ')}`);
      }

      // Parse max results per quality (0 = no limit)
      let maxResultsPerQualityValue = parseInt(maxResultsPerQuality ?? '0', 10);
      if (Number.isNaN(maxResultsPerQualityValue) || maxResultsPerQualityValue < 0) {
        maxResultsPerQualityValue = 0;
      }
      if (!config.maxResultsPerQuality) {
        logger.info('Using default maxResultsPerQuality: ' + maxResultsPerQuality);
      } else {
        logger.info(
          `Max results per quality: ${maxResultsPerQualityValue === 0 ? 'No limit' : maxResultsPerQualityValue}`
        );
      }

      // Parse max file size (0 = no limit)
      let maxFileSizeGB = parseFloat(maxFileSize ?? '0');
      if (Number.isNaN(maxFileSizeGB) || maxFileSizeGB < 0) {
        maxFileSizeGB = 0;
      }
      if (!config.maxFileSize) {
        logger.info('Using default maxFileSize: ' + maxFileSize);
      } else {
        logger.info(`Max file size: ${maxFileSizeGB === 0 ? 'No limit' : maxFileSizeGB + ' GB'}`);
      }

      // Use custom titles from custom-titles.json
      const customTitles = { ...titlesFromFile };

      logger.debug(
        `Using ${Object.keys(customTitles).length} custom titles from custom-titles.json`
      );

      if (!config.sortingPreference) {
        logger.info(`Using default sortingPreference: ${sortingPreference}`);
      } else {
        logger.info(`Sorting preference from config: ${sortingPreference}`);
      }

      // Configure API sorting options based on user sorting preference
      const sortOptions: Partial<SearchOptions> = {
        query: '', // Will be set for each search later
      };

      // Set consistent API sorting parameters regardless of user sorting preference
      // This ensures we always get the same raw results
      // We'll handle user sorting preferences after fetching all results

      // Use parameters that give us the most complete results
      sortOptions.sort1 = 'relevance'; // Use relevance as primary sort
      sortOptions.sort1Direction = '-'; // Descending
      sortOptions.sort2 = 'dsize'; // Then size
      sortOptions.sort2Direction = '-'; // Descending
      // Set a consistent third sort option
      sortOptions.sort3 = 'dtime'; // DateTime
      sortOptions.sort3Direction = '-'; // Descending

      // Log the API sorting parameters
      logger.debug(
        `API Sorting: ${sortOptions.sort1} (${sortOptions.sort1Direction}), ${sortOptions.sort2} (${sortOptions.sort2Direction}), ${sortOptions.sort3} (${sortOptions.sort3Direction})`
      );

      const meta = await publicMetaProvider(id, type, preferredLanguage);
      logger.info(`Searching for: ${meta.name}`);

      // Check if we have a custom title for this title directly
      if (customTitles[meta.name]) {
        logger.info(
          `Direct custom title found for "${meta.name}": "${customTitles[meta.name].join('", "')}"`
        );
      } else {
        logger.info(`No direct custom title found for "${meta.name}", checking partial matches`);

        // Look for partial matches in title keys
        for (const [key, values] of Object.entries(customTitles)) {
          if (
            meta.name.toLowerCase().includes(key.toLowerCase()) ||
            key.toLowerCase().includes(meta.name.toLowerCase())
          ) {
            logger.debug(
              `Possible title match: "${meta.name}" ~ "${key}" -> "${values.join('", "')}"`
            );
          }
        }
      }

      // Initialize the API with user credentials
      let api;
      try {
        api = new EasynewsAPI({ username, password });
      } catch (error) {
        logger.error(`API initialization error: ${error}`);
        return authErrorStream(config.preferredLanguage || '');
      }

      logger.debug(`Getting alternative titles for: ${meta.name}`);

      // Initialize with the original title
      let allTitles = [meta.name];

      // Add any direct custom titles found in customTitles
      if (customTitles[meta.name] && customTitles[meta.name].length > 0) {
        logger.debug(
          `Adding direct custom titles for "${meta.name}": "${customTitles[meta.name].join('", "')}"`
        );
        allTitles = [...allTitles, ...customTitles[meta.name]];
      }

      // Add any alternative names from meta (if available)
      if (meta.alternativeNames && meta.alternativeNames.length > 0) {
        logger.debug(
          `Adding ${meta.alternativeNames.length} alternative names from metadata (${meta.alternativeNames.join(', ')})`
        );
        // Filter out duplicates
        const newAlternatives = meta.alternativeNames.filter(alt => !allTitles.includes(alt));
        allTitles = [...allTitles, ...newAlternatives];
      }

      // Use getAlternativeTitles to find additional matches (like partial matches)
      const additionalTitles = getAlternativeTitles(meta.name, customTitles).filter(
        alt => !allTitles.includes(alt) && alt !== meta.name
      );

      if (additionalTitles.length > 0) {
        logger.debug(`Adding ${additionalTitles.length} additional titles from partial matches`);
        allTitles = [...allTitles, ...additionalTitles];
      }

      logger.debug(`Will search for ${allTitles.length} titles: ${allTitles.join(', ')}`);

      // Store all search results here
      const allSearchResults: {
        query: string;
        result: EasynewsSearchResponse;
      }[] = [];

      // Early exit condition - limit API calls
      const TOTAL_MAX_RESULTS = parseIntEnv(process.env.TOTAL_MAX_RESULTS, 500);
      let totalFoundResults = 0;

      // Helper function to count total unique results across all searches
      const countTotalUniqueResults = () => {
        const uniqueHashes = new Set<string>();
        for (const { result } of allSearchResults) {
          for (const file of result.data ?? []) {
            const fileHash = file['0'];
            uniqueHashes.add(fileHash);
          }
        }
        return uniqueHashes.size;
      };

      // Build the query lists: every title variant WITHOUT the year, then (if the
      // year is known) every variant WITH the year. Kept as two phases so the
      // no-year searches can satisfy TOTAL_MAX_RESULTS and skip the year phase
      // entirely (the original early-exit behavior). Within each phase, queries
      // are merged back in order so the downstream dedup-by-hash (first-seen wins)
      // and the cap select the same results regardless of completion order.
      const buildQueries = (withYear: boolean): string[] => {
        const out: string[] = [];
        for (const titleVariant of allTitles) {
          if (!titleVariant.trim()) continue;
          out.push(
            buildSearchQuery(type, {
              ...meta,
              name: titleVariant,
              year: withYear ? meta.year : undefined,
            })
          );
        }
        return out;
      };
      const noYearQueries = buildQueries(false);
      const yearQueries = meta.year !== undefined ? buildQueries(true) : [];

      // BOUNDED concurrency instead of one-at-a-time (the sequential fan-out was
      // the dominant latency cost on a cache miss). Clamp to >= 1 so a misconfig
      // (SEARCH_CONCURRENCY=0 or negative) can never stall the batch loop.
      const SEARCH_CONCURRENCY = Math.max(1, parseIntEnv(process.env.SEARCH_CONCURRENCY, 5));

      // Run one phase's queries in concurrency-bounded batches, merging results in
      // query order and re-checking the early-exit threshold between batches.
      // Throws on an auth error so the outer handler surfaces the auth-error
      // stream (a single auth failure means every search would fail).
      const runSearchPhase = async (queries: string[]): Promise<void> => {
        for (let i = 0; i < queries.length; i += SEARCH_CONCURRENCY) {
          if (totalFoundResults >= TOTAL_MAX_RESULTS) {
            logger.debug(
              `Already found ${totalFoundResults} unique results, skipping remaining searches`
            );
            return;
          }

          const batch = queries.slice(i, i + SEARCH_CONCURRENCY);
          const settled = await Promise.allSettled(
            batch.map(query => api.search({ ...sortOptions, query }))
          );

          for (let j = 0; j < settled.length; j++) {
            const outcome = settled[j];
            const query = batch[j];

            if (outcome.status === 'rejected') {
              if (isAuthError(outcome.reason)) throw outcome.reason;
              logger.error(`Error searching for "${query}":`, outcome.reason);
              continue;
            }

            const res = outcome.value;
            const resultCount = res?.data?.length || 0;
            logger.debug(`Found ${resultCount} results for "${query}"`);
            if (resultCount > 0) {
              allSearchResults.push({ query, result: res });
            }
          }

          totalFoundResults = countTotalUniqueResults();
          logger.debug(`Total unique results so far: ${totalFoundResults}`);
        }
      };

      logger.debug(
        `Running ${noYearQueries.length} no-year + ${yearQueries.length} year searches for ${allTitles.length} title variants`
      );

      // No-year phase first; only run the year phase if still under the cap.
      await runSearchPhase(noYearQueries);
      if (totalFoundResults < TOTAL_MAX_RESULTS) {
        await runSearchPhase(yearQueries);
      }

      if (allSearchResults.length === 0) {
        // Expensive no-result path: the full search fan-out ran and returned
        // nothing. Cache it (in-process + protocol-level) so repeats don't redo
        // the whole fan-out — this was previously uncached entirely.
        const emptyResult = { streams: [], cacheMaxAge: EMPTY_RESULT_CACHE_MAX_AGE };
        setCache(cacheKey, emptyResult);
        return emptyResult;
      }

      const processedHashes = new Set<string>();

      // Store all streams here
      let streams: Stream[] = [];

      // Apply global limit across all search results
      logger.debug(`Global stream limit: ${TOTAL_MAX_RESULTS} results across all searches`);

      // Process each search result
      for (const { query, result: res } of allSearchResults) {
        // Skip adding more results if we've already reached the limit
        if (streams.length >= TOTAL_MAX_RESULTS) {
          logger.debug(`Reached global limit of ${TOTAL_MAX_RESULTS} streams, stopping processing`);
          break;
        }

        for (const file of res.data ?? []) {
          // Check if we've reached the global limit
          if (streams.length >= TOTAL_MAX_RESULTS) {
            logger.debug(
              `Reached global limit of ${TOTAL_MAX_RESULTS} streams, stopping processing`
            );
            break;
          }

          const title = getPostTitle(file);
          const fileHash = file['0']; // Use file hash to detect duplicates

          if (isBadVideo(file) || processedHashes.has(fileHash)) {
            continue;
          }

          processedHashes.add(fileHash);

          // For series there are multiple possible queries that could match the title.
          // We check if at least one of them matches.
          if (type === 'series') {
            // Create queries for all title variants
            const queries: string[] = [];

            for (const titleVariant of allTitles) {
              // Add full query with season and episode
              const fullMeta = {
                ...meta,
                name: titleVariant,
                year: meta.year,
              };
              queries.push(buildSearchQuery(type, fullMeta));

              // Add query with episode only
              const episodeMeta = {
                name: titleVariant,
                episode: meta.episode,
              };
              queries.push(buildSearchQuery(type, episodeMeta));
            }

            // Use strictTitleMatching setting if enabled for series
            if (!queries.some(q => matchesTitle(title, q, useStrictMatching))) {
              logger.debug(`Rejected series by title matching: "${title}"`);
              continue;
            }
          }

          // For movies, check if title matches any of the query variants
          // Other content types are loosely matched
          const matchesAnyVariant = allTitles.some(titleVariant => {
            const variantQuery = buildSearchQuery(type, {
              ...meta,
              name: titleVariant,
            });
            // For movies, only use strictTitleMatching if enabled by user, just like for series
            return matchesTitle(title, variantQuery, useStrictMatching);
          });

          if (!matchesAnyVariant) {
            logger.debug(`Rejected ${type} by title matching: "${title}"`);
            continue;
          }

          streams.push(
            mapStream({
              fullResolution: file.fullres,
              fileExtension: getFileExtension(file),
              duration: getDuration(file),
              size: getSize(file),
              title,
              url: createStreamUrl(
                { downURL: res.downURL, dlFarm: res.dlFarm, dlPort: res.dlPort },
                username,
                password,
                createStreamPath(file),
                baseUrl
              ),
              videoSize: file.rawSize,
              file,
              preferredLang,
            })
          );
        }
      }

      // Sort the streams ONCE, by user preference, using the per-stream metadata
      // precomputed in mapStream (`_sort`) — no per-comparison string parsing.
      // This single sort runs BEFORE filtering, so the per-quality limiter below
      // slices the sorted order (preserving prior behavior); filtering keeps
      // relative order, so no post-filter re-sort is needed.
      const sortMetaOf = (s: Stream): SortMeta =>
        (s as { _sort?: SortMeta })._sort ?? {
          qualityScore: 0,
          sizeUnit: '',
          sizeValue: 0,
          dateMs: 0,
          hasPreferredLang: false,
        };

      if (sortingPreference === 'language_first' && preferredLang) {
        logger.debug(`Applying language-first sorting for language: ${preferredLang}`);

        // Split into preferred-language and other streams, sort each by quality
        // then size, then concatenate (preferred group first).
        const preferredLangStreams: Stream[] = [];
        const otherStreams: Stream[] = [];
        for (const stream of streams) {
          if (sortMetaOf(stream).hasPreferredLang) {
            preferredLangStreams.push(stream);
          } else {
            otherStreams.push(stream);
          }
        }

        logger.debug(
          `Found ${preferredLangStreams.length} streams with preferred language and ${otherStreams.length} other streams`
        );

        const sortByQualityAndSize = (a: Stream, b: Stream) => {
          const am = sortMetaOf(a);
          const bm = sortMetaOf(b);
          if (am.qualityScore !== bm.qualityScore) return bm.qualityScore - am.qualityScore;
          return compareSizeMeta(am, bm);
        };

        preferredLangStreams.sort(sortByQualityAndSize);
        otherStreams.sort(sortByQualityAndSize);

        streams.length = 0;
        streams.push(...preferredLangStreams, ...otherStreams);
      } else {
        streams.sort((a, b) => {
          const am = sortMetaOf(a);
          const bm = sortMetaOf(b);

          switch (sortingPreference) {
            case 'size_first': {
              const sizeCompare = compareSizeMeta(am, bm);
              if (sizeCompare !== 0) return sizeCompare;
              if (am.qualityScore !== bm.qualityScore) return bm.qualityScore - am.qualityScore;
              if (am.hasPreferredLang !== bm.hasPreferredLang) return am.hasPreferredLang ? -1 : 1;
              return 0;
            }

            case 'date_first': {
              if (am.dateMs !== bm.dateMs) return bm.dateMs - am.dateMs;
              if (am.qualityScore !== bm.qualityScore) return bm.qualityScore - am.qualityScore;
              if (am.hasPreferredLang !== bm.hasPreferredLang) return am.hasPreferredLang ? -1 : 1;
              return compareSizeMeta(am, bm);
            }

            case 'lang_first':
            case 'language_first': {
              if (am.hasPreferredLang !== bm.hasPreferredLang) return am.hasPreferredLang ? -1 : 1;
              if (am.qualityScore !== bm.qualityScore) return bm.qualityScore - am.qualityScore;
              return compareSizeMeta(am, bm);
            }

            case 'quality_first':
            default: {
              if (am.qualityScore !== bm.qualityScore) return bm.qualityScore - am.qualityScore;
              if (am.hasPreferredLang !== bm.hasPreferredLang) return am.hasPreferredLang ? -1 : 1;
              return compareSizeMeta(am, bm);
            }
          }
        });
      }

      // After sorting, filter and limit based on user settings
      const originalCount = streams.length;
      if (streams.length > 0) {
        logger.debug(`Starting filters with ${originalCount} streams`);

        // Filter streams by quality
        const defaultQualitySet = ['4k', '1080p', '720p', '480p'];
        const isCustomQualityFilter = !(
          qualityFilters.length === defaultQualitySet.length &&
          qualityFilters.every(q => defaultQualitySet.includes(q))
        );

        if (isCustomQualityFilter) {
          const qualityMap: Record<string, string[]> = {
            '4k': ['4K', 'UHD', '2160p'],
            '1080p': ['1080p'],
            '720p': ['720p'],
            '480p': ['480p', 'SD'],
          };

          // Create a list of allowed quality strings
          const allowedQualityTerms: string[] = [];
          qualityFilters.forEach(q => {
            if (qualityMap[q]) {
              allowedQualityTerms.push(...qualityMap[q]);
            }
          });

          logger.debug(`Filtering for qualities: ${qualityFilters.join(', ')}`);
          logger.debug(`Accepted quality terms: ${allowedQualityTerms.join(', ')}`);

          if (allowedQualityTerms.length > 0) {
            const filteredStreams = streams.filter(stream => {
              const quality = stream.name?.split('\n')[1] || '';
              const matchesQuality = allowedQualityTerms.some(term => quality.includes(term));
              return matchesQuality;
            });

            // Only update if we found at least one match
            if (filteredStreams.length > 0) {
              streams = filteredStreams;
              logger.debug(`After quality filtering: ${streams.length} streams remain`);
            } else {
              logger.warn(`Quality filtering would remove all streams - keeping original results`);
            }
          }
        }

        // Filter streams by file size (only if maxFileSizeGB > 0)
        if (maxFileSizeGB > 0) {
          const filteredStreams = streams.filter(stream => {
            const description = stream.description || '';
            const sizeLine = description.split('\n').find(line => line.includes('📦'));

            if (!sizeLine) return true; // Keep if we can't determine size

            // Extract only the size part (before any date information)
            const sizePart = sizeLine.split('📅')[0].trim();

            if (sizePart.includes('GB')) {
              const sizeGB = parseFloat(sizePart.match(/[\d.]+/)?.[0] || '0');
              return sizeGB <= maxFileSizeGB;
            }

            if (sizePart.includes('MB')) {
              const sizeMB = parseFloat(sizePart.match(/[\d.]+/)?.[0] || '0');
              return sizeMB / 1024 <= maxFileSizeGB;
            }

            return true; // Keep if we can't parse the size
          });

          // Only update if we found at least one match
          if (filteredStreams.length > 0) {
            streams = filteredStreams;
            logger.debug(`After max file size filtering: ${streams.length} streams remain`);
          } else {
            logger.warn(`File size filtering would remove all streams - keeping original results`);
          }
        }

        // Group streams by quality for limiting per quality (only if maxResultsPerQualityValue > 0)
        if (maxResultsPerQualityValue > 0) {
          const streamsByQuality: Record<string, Stream[]> = {};

          // Determine quality category for each stream
          streams.forEach(stream => {
            const quality = stream.name?.split('\n')[1] || '';
            let qualityCategory = 'other';

            if (quality.includes('4K') || quality.includes('UHD') || quality.includes('2160p')) {
              qualityCategory = '4k';
            } else if (quality.includes('1080p')) {
              qualityCategory = '1080p';
            } else if (quality.includes('720p')) {
              qualityCategory = '720p';
            } else if (quality.includes('480p') || quality.includes('SD')) {
              qualityCategory = '480p';
            }

            if (!streamsByQuality[qualityCategory]) {
              streamsByQuality[qualityCategory] = [];
            }
            streamsByQuality[qualityCategory].push(stream);
          });

          // Log the distribution of streams by quality
          Object.entries(streamsByQuality).forEach(([quality, streams]) => {
            logger.debug(`Quality ${quality}: ${streams.length} streams`);
          });

          // Apply limits per quality category and rebuild streams array
          const limitedStreams: Stream[] = [];
          Object.keys(streamsByQuality).forEach(quality => {
            const qualityStreams = streamsByQuality[quality];
            const limitedQualityStreams = qualityStreams.slice(0, maxResultsPerQualityValue);
            limitedStreams.push(...limitedQualityStreams);

            if (limitedQualityStreams.length < qualityStreams.length) {
              logger.debug(
                `Quality ${quality}: Limited from ${qualityStreams.length} to ${limitedQualityStreams.length} streams`
              );
            }
          });

          if (limitedStreams.length > 0) {
            streams = limitedStreams;
            logger.debug(
              `After applying max results per quality: ${streams.length} streams remain`
            );
          } else {
            logger.warn(`Per-quality limiting would remove all streams - keeping original results`);
          }
        }

        logger.info(`Filtering complete: ${originalCount} streams → ${streams.length} streams`);
      }

      if (streams.length > 0) {
        const qualitySummary: Record<string, number> = {};
        streams.forEach(stream => {
          const quality = stream.name?.split('\n')[1] || 'Unknown';
          qualitySummary[quality] = (qualitySummary[quality] || 0) + 1;
        });

        const qualitySummaryStr = Object.entries(qualitySummary)
          .map(([quality, count]) => `${quality}: ${count}`)
          .join(', ');

        logger.info(`Found ${streams.length} streams total for ${id} (${qualitySummaryStr})`);
      } else {
        logger.info(`Found 0 streams total for ${id}`);
      }

      // Remove the internal sort metadata before caching/returning so it is
      // neither serialized to clients nor held in cache.
      for (const stream of streams) {
        delete (stream as { _sort?: unknown })._sort;
      }

      // Cache the result and return it WITH the cache options so even the cold
      // (first) response carries cacheMaxAge — previously cacheMaxAge only took
      // effect on a subsequent in-process hit.
      const result = { streams, ...getCacheOptions(streams.length) };
      setCache(cacheKey, result);

      return result;
    } catch (error) {
      logError({
        message: `failed to handle stream: ${error}`,
        error,
        context: { resource: 'stream', id, type },
      });

      // Check if the error is related to authentication
      if (isAuthError(error)) return authErrorStream(config.preferredLanguage || '');

      // No proxy base URL available — tell the user to reconfigure rather than
      // silently returning no streams.
      if (error instanceof MissingBaseUrlError) return configErrorStream();

      // Briefly cache the error response at the protocol level so a transient
      // upstream failure doesn't get hammered on every open, but recovers fast.
      // Deliberately NOT written to the in-process cache (errors are transient).
      return { streams: [], cacheMaxAge: ERROR_CACHE_MAX_AGE };
    }
  }
);

// Per-stream sorting metadata, precomputed ONCE in mapStream so the sort
// comparator never re-parses the human-readable name/description strings. These
// fields reproduce exactly what the previous in-comparator parsing derived.
type SortMeta = {
  qualityScore: number;
  sizeUnit: 'GB' | 'MB' | '';
  sizeValue: number;
  dateMs: number;
  hasPreferredLang: boolean;
};

// Quality label → score. Operates on the same label that goes into the stream
// name (`Easynews++\n<quality>`), so it matches the old getQualityScore exactly.
function qualityScoreFromLabel(quality: string | undefined): number {
  if (!quality) return 0;
  const q = quality.toUpperCase();
  if (
    q.includes('4K') ||
    q.includes('2160P') ||
    q.includes('UHD') ||
    q.includes('2160') ||
    q.includes('ULTRA HD')
  )
    return 4;
  if (q.includes('1080P') || q.includes('1080')) return 3;
  if (q.includes('720P') || q.includes('720')) return 2;
  if (q.includes('480P') || q.includes('480') || q.includes('SD')) return 1;
  return 0;
}

// Parse the displayed size string (file['4'], e.g. "1.5 GB" / "700 MB") into a
// unit + number, mirroring the old comparator's GB/MB detection and first-number
// extraction.
function parseSizeForSort(size: string | undefined): { unit: 'GB' | 'MB' | ''; value: number } {
  const s = size ?? '';
  if (s.includes('GB')) return { unit: 'GB', value: parseFloat(s.match(/[\d.]+/)?.[0] || '0') };
  if (s.includes('MB')) return { unit: 'MB', value: parseFloat(s.match(/[\d.]+/)?.[0] || '0') };
  return { unit: '', value: 0 };
}

// Reproduces the original size comparison EXACTLY, including its quirk that any
// GB file outranks any MB file regardless of the actual numbers; same-unit
// compares by value descending; anything unparseable compares equal.
function compareSizeMeta(a: SortMeta, b: SortMeta): number {
  if (a.sizeUnit === 'GB' && b.sizeUnit === 'GB') {
    return a.sizeValue > b.sizeValue ? -1 : a.sizeValue < b.sizeValue ? 1 : 0;
  }
  if (a.sizeUnit === 'GB' && b.sizeUnit === 'MB') return -1;
  if (a.sizeUnit === 'MB' && b.sizeUnit === 'GB') return 1;
  if (a.sizeUnit === 'MB' && b.sizeUnit === 'MB') {
    return a.sizeValue > b.sizeValue ? -1 : a.sizeValue < b.sizeValue ? 1 : 0;
  }
  return 0;
}

function mapStream({
  duration,
  size,
  fullResolution,
  title,
  fileExtension,
  videoSize,
  url,
  file,
  preferredLang,
}: {
  title: string;
  url: string;
  fileExtension: string;
  videoSize: number | undefined;
  duration: string | undefined;
  size: string | undefined;
  fullResolution: string | undefined;
  file: any;
  preferredLang: string;
}): Stream {
  logger.debug(`Mapping stream: "${title}" (${fileExtension}, ${size}, ${duration})`);

  const quality = getQuality(title, fullResolution);

  // Log language information for debugging
  if (file.alangs && file.alangs.length > 0) {
    logger.debug(`Stream "${title}" has languages: ${JSON.stringify(file.alangs)}`);
  } else {
    logger.debug(`Stream "${title}" has no language information`);
  }

  // Calculate days since upload
  const publishDate = getPublishDate(file.ts);

  // Show language information in the description if available
  const languageInfo = file.alangs?.length
    ? `🌐 ${file.alangs.join(', ')}${preferredLang && file.alangs.includes(preferredLang) ? ' ⭐' : ''}`
    : '🌐 Unknown';

  // Precompute everything the sort comparator needs, once, so it never re-parses
  // the display strings below. Stripped off again before the response is cached
  // or returned (see the cleanup loop in the handler).
  const parsedSize = parseSizeForSort(size);
  const sortMeta: SortMeta = {
    qualityScore: qualityScoreFromLabel(quality),
    sizeUnit: parsedSize.unit,
    sizeValue: parsedSize.value,
    dateMs: file['5'] ? new Date(file['5']).getTime() : 0,
    hasPreferredLang:
      !!preferredLang && Array.isArray(file.alangs) && file.alangs.includes(preferredLang),
  };

  // bingeGroup lets the player auto-continue the next episode from the SAME
  // source tier without bouncing back to stream selection. Keep it stable across
  // episodes (quality + audio languages + container), so consecutive episodes of
  // the same release auto-advance, while distinct tiers stay distinct. The
  // language key is normalized (lowercased, de-duped, sorted) so the same set of
  // audio tracks in a different order between episodes still yields the same key.
  const bingeLang =
    Array.isArray(file.alangs) && file.alangs.length
      ? [...new Set(file.alangs.map((l: string) => String(l).toLowerCase()))].sort().join(',')
      : 'unknown';
  const bingeGroup = `easynews-plus-plus|${quality || 'default'}|${bingeLang}|${fileExtension || 'unknown'}`;

  const stream: Stream & { _sort?: SortMeta } = {
    name: `Easynews++${quality ? `\n${quality}` : ''}`,
    description: [
      `${title}${fileExtension}`,
      `🕛 ${duration ?? 'unknown duration'}`,
      `📦 ${size ?? 'unknown size'} ${publishDate}`,
      languageInfo,
    ].join('\n'),
    url: url,
    behaviorHints: {
      notWebReady: true,
      filename: `${title}${fileExtension}`,
      bingeGroup,
      // Exact size in bytes was computed and threaded in but never emitted before.
      ...(typeof videoSize === 'number' ? { videoSize } : {}),
    },
    // Precomputed sort keys (internal; removed before returning).
    _sort: sortMeta,
  };

  return stream;
}

/**
 * Calculate a human-readable publish date from timestamp
 * @param timestamp Unix timestamp in seconds
 * @returns Formatted date string or empty string if timestamp is invalid
 */
function getPublishDate(timestamp: number): string {
  if (!timestamp) return '';

  const uploadDate = new Date(timestamp * 1000);
  const now = new Date();

  // Calculate days difference
  const diffTime = Math.abs(now.getTime() - uploadDate.getTime());
  const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

  return `📅 ${diffDays}d`;
}

function getCacheOptions(itemsLength: number): Partial<Cache> {
  // Non-empty results scale up to a week; an empty (but successful) result still
  // gets a short positive TTL so it isn't recomputed on every open. Previously
  // itemsLength === 0 yielded cacheMaxAge: 0 (explicitly non-cacheable).
  const computed = (Math.min(itemsLength, 10) / 10) * 3600 * 24 * 7;
  return {
    cacheMaxAge: Math.max(EMPTY_RESULT_CACHE_MAX_AGE, computed),
  };
}

export const addonInterface = builder.getInterface();
