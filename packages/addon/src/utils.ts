import { EasynewsSearchResponse, FileData } from 'easynews-plus-plus-api';
import { MetaProviderResponse } from './meta.js';
import type { ContentType } from '@stremio-addon/sdk';
import { parse as parseTorrentTitle } from 'parse-torrent-title';
import path from 'path';
import dotenv from 'dotenv';
import { createLogger } from 'easynews-plus-plus-shared';
import { Buffer } from 'buffer';

// Import the custom titles JSON directly
import customTitlesJson from '../../../custom-titles.json' with { type: 'json' };

// Load .env file to ensure we have all environment variables
function loadEnv() {
  // Skip .env loading for Cloudflare Workers environment
  if (process.env.CLOUDFLARE === 'true') {
    // We can't use logger here since it's not initialized yet
    console.log('Cloudflare environment detected, skipping .env file loading');
    return;
  }

  try {
    // Load environment variables from env file in project root
    const configPath = path.resolve('../../.env');
    const result = dotenv.config({ path: configPath });

    // Log the result of loading the environment config
    if (result.error) {
      // We can't use logger here since it's not initialized yet
      console.warn('Error loading .env. Continuing with default values.');
    } else {
      // We can't use logger here since it's not initialized yet
      console.log('Environment configuration loaded successfully');
    }
  } catch (error) {
    // We can't use logger here since it's not initialized yet
    console.error('Error while trying to load .env file:', error);
  }
}

// Only load .env in non-Cloudflare environments
if (typeof process !== 'undefined' && !process.env.CLOUDFLARE) {
  loadEnv();
}

// Create a logger with Addon prefix and explicitly set the level from environment variable
export const logger = createLogger({
  prefix: 'Utils',
  level: process.env.EASYNEWS_LOG_LEVEL || undefined, // Use the environment variable if set
});

export function isBadVideo(file: FileData) {
  const duration = file['14'] ?? '';
  const title = getPostTitle(file);

  logger.debug(`Checking if video is bad: "${title}" (duration: ${duration}, type: ${file.type})`);

  // Check each condition and log the reason if it fails
  if (duration.match(/^\d+s/)) {
    logger.debug(`Bad video: "${title}": Duration too short (${duration})`);
    return true;
  }
  if (duration.match('^[0-5]m')) {
    logger.debug(`Bad video: "${title}": Duration too short (${duration})`);
    return true;
  }
  if (file.passwd) {
    logger.debug(`Bad video: "${title}": Password protected`);
    return true;
  }
  if (file.virus) {
    logger.debug(`Bad video: "${title}": Contains virus`);
    return true;
  }
  if (file.type.toUpperCase() !== 'VIDEO') {
    logger.debug(`Bad video: "${title}": Not a video file (type: ${file.type})`);
    return true;
  }
  if (file.rawSize && file.rawSize < 20 * 1024 * 1024) {
    logger.debug(
      `Bad video: "${title}": File too small (${Math.round(file.rawSize / 1024 / 1024)}MB)`
    );
    return true;
  }

  logger.debug(`Video passed quality checks: "${title}"`);
  return false;
}

/**
 * Adult-content tokens that appear in Easynews source-newsgroup names. Matched
 * against {@link FileData} field '9' (the space-separated list of groups a post
 * was found in). Because porn is almost always cross-posted to an explicitly
 * adult group even when it also lands in a neutral one, matching ANY token in
 * the combined string catches the large majority of it.
 *
 * The token set is deliberately conservative — only segments that are
 * unambiguously adult in newsgroup names, so the filter is effectively
 * false-positive-free against legitimate content (verified: no group holding a
 * real show ever matched). Notably EXCLUDED are "gay" and "teen" — both occur in
 * legitimate content (LGBTQ film/TV; teen dramas) and the porn that uses them is
 * already cross-posted to an erotica/sex group and caught anyway. The residual
 * porn in purely neutral-named groups (e.g. Dutch alt.binaries.ijsklontje) is
 * handled by the title-matching layer, not here.
 */
const ADULT_GROUP_RE =
  /(erotic|xxx|porn|pron|masturbat|bestial|incest|hentai|shemale|transsex|(?:^|\.)sex)/i;

/**
 * Whether an Easynews post's source newsgroup(s) indicate adult content.
 * @param group The raw value of {@link FileData} field '9' (may list several
 *              groups separated by spaces). Falsy input is treated as not-adult.
 */
export function isAdultGroup(group: string | null | undefined): boolean {
  if (!group) return false;
  return ADULT_GROUP_RE.test(group);
}

/**
 * Whether a search query is "anchored" to a specific episode or year — i.e. it
 * carries an SxxExx code or a 19xx/20xx year.
 *
 * Unanchored queries (a bare title) are inherently low-precision: when a foreign
 * title's IMDb canonical is a generic English phrase (e.g. "Take Care"), a bare
 * search floods with unrelated content, including porn whose post title happens
 * to contain the query words. Callers force strict matching on unanchored
 * queries regardless of the user's loose preference — strict keeps the real
 * title (parsed title equals the query) while rejecting the flood (parsed title
 * differs). Anchored queries are self-limiting and respect the user's setting.
 */
export function isAnchoredQuery(query: string): boolean {
  return /s\d{1,3}e\d{1,3}/i.test(query) || /\b(?:19|20)\d{2}\b/.test(query);
}

/**
 * Sanitize a title for case-insensitive comparison.
 * Handles special characters, accented letters, and common separators.
 */
export function sanitizeTitle(title: string) {
  // logger.debug(`Sanitizing title: "${title}"`);
  const result = title
    // replace common accented characters with their base characters
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .replace(/Ä/g, 'Ae')
    .replace(/Ö/g, 'Oe')
    .replace(/Ü/g, 'Ue')
    // Scandinavian letters: normalize to the digraph convention so an "æ" title
    // and its "ae" release spelling compare equal (e.g. Slangedræber ↔
    // Slangedraeber). Release names also use the bare-vowel convention (ø→o,
    // å→a); those alternate spellings are covered by getNordicTransliterations,
    // which feeds them in as extra SEARCH variants.
    .replace(/æ/g, 'ae')
    .replace(/ø/g, 'oe')
    .replace(/å/g, 'aa')
    .replace(/Æ/g, 'Ae')
    .replace(/Ø/g, 'Oe')
    .replace(/Å/g, 'Aa')
    // replace common symbols with words
    .replaceAll('&', 'and')
    // replace common separators (., _, -, whitespace) with a single space
    .replace(/[\.\-_:\s]+/g, ' ')
    // handle brackets and parentheses - replace with space
    .replace(/[\[\]\(\){}]/g, ' ')
    // remove non-alphanumeric characters except for accented characters
    .replace(/[^\w\sÀ-ÿ]/g, '')
    // to lowercase + remove spaces at the beginning and end
    .toLowerCase()
    .trim();
  // logger.debug(`Sanitized result: "${result}"`);
  return result;
}

/**
 * Generate plausible ASCII spellings of a title containing Scandinavian letters
 * (æ/ø/å), for use as additional Easynews SEARCH variants.
 *
 * The matcher in {@link sanitizeTitle} normalizes to a single (digraph)
 * convention, but that alone is not enough: Easynews full-text search will not
 * return a post named "Slangedraeber" when we query the literal "Slangedræber",
 * so the differently-spelled posts are never retrieved. Releases also disagree
 * on the convention — "ø" appears as both "oe" and "o", "å" as both "aa" and
 * "a" — so we emit both forms and let any of them match.
 *
 * @returns Transliterated variants that differ from the input (empty if the
 *          title contains no Scandinavian letters).
 */
export function getNordicTransliterations(title: string): string[] {
  // Each map is applied as a complete set to produce one variant spelling.
  const conventions: Array<Record<string, string>> = [
    // Digraph convention: æ→ae, ø→oe, å→aa
    { æ: 'ae', Æ: 'Ae', ø: 'oe', Ø: 'Oe', å: 'aa', Å: 'Aa' },
    // Bare-vowel convention: æ→ae, ø→o, å→a
    { æ: 'ae', Æ: 'Ae', ø: 'o', Ø: 'O', å: 'a', Å: 'A' },
  ];

  const variants: string[] = [];
  for (const map of conventions) {
    const transliterated = title.replace(/[æÆøØåÅ]/g, ch => map[ch] ?? ch);
    if (transliterated !== title && !variants.includes(transliterated)) {
      variants.push(transliterated);
    }
  }
  return variants;
}

/**
 * Whole-word membership test for non-strict matching: returns true only if
 * `word` appears as a complete word in `text` (so "killer" does NOT match
 * "killers"). Both arguments are expected to be {@link sanitizeTitle} output
 * (lowercased, space-separated, punctuation already collapsed).
 */
function wordInText(word: string, text: string): boolean {
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${escaped}\\b`).test(text);
}

/**
 * Improved title matching with more accurate results
 * @param title The content title to check
 * @param query The search query to match against
 * @param strict Whether to perform exact matching (for movies)
 * @returns Whether the title matches the query
 */
export function matchesTitle(title: string, query: string, strict: boolean) {
  logger.debug(`Matching title: "${title}" against query: "${query}" (strict: ${strict})`);

  const sanitizedQuery = sanitizeTitle(query);
  const sanitizedTitle = sanitizeTitle(title);

  // Extract the main title part for comparison (excluding episode info)
  const mainQueryPart = sanitizedQuery.split(/s\d+e\d+/i)[0].trim();
  const isSeriesQuery = /s\d+e\d+/i.test(sanitizedQuery);
  logger.debug(`Main query part: "${mainQueryPart}", is series query: ${isSeriesQuery}`);

  // For strict mode, we require an exact title match or proper prefix match
  if (strict) {
    // For series with season/episode pattern like S01E01
    const seasonEpisodePattern = /s\d+e\d+/i;
    const hasSeasonEpisodePattern = seasonEpisodePattern.test(sanitizedQuery);
    logger.debug(`Strict mode - has season/episode pattern: ${hasSeasonEpisodePattern}`);

    if (hasSeasonEpisodePattern) {
      // Split the title into words to make exact word comparisons
      const titleWords = sanitizedTitle.split(/\s+/);
      const mainQueryWords = mainQueryPart.split(/\s+/);

      // For exact title matching, ensure one of these conditions is true:
      // 1. Title is EXACTLY the query
      // 2. Title is exactly the query plus season/episode info
      // 3. Title starts with the exact query words followed by season/episode info (possibly with year in between)

      // Check if title is exactly the same as the main query part (case 1)
      if (sanitizedTitle === mainQueryPart) {
        logger.debug(`Strict mode - title exactly matches main query part`);
        return true;
      }

      // Check if title contains season/episode pattern
      const seMatch = sanitizedTitle.match(seasonEpisodePattern);
      if (seMatch) {
        const titleBeforeSE = sanitizedTitle.split(seMatch[0])[0].trim();

        // Check if everything before season/episode is exactly the main query (case 2)
        if (titleBeforeSE === mainQueryPart) {
          logger.debug(`Strict mode - title matches main query part + season/episode pattern`);
          return true;
        }

        // Remove year from title before comparing
        const yearPattern = /\b(19\d{2}|20\d{2})\b/;
        const titleWithoutYear = titleBeforeSE.replace(yearPattern, '').trim();

        // If after removing year, the title matches the query exactly
        if (titleWithoutYear === mainQueryPart) {
          logger.debug(`Strict mode - title matches main query part after removing year`);
          return true;
        }

        // If title still has more words than query (after removing year), it's not a match
        // e.g. "grace and frankie s01e01" doesn't match "grace"
        const titleWordsWithoutYear = titleWithoutYear.split(/\s+/);
        if (titleWordsWithoutYear.length > mainQueryWords.length) {
          logger.debug(`Strict mode - title has extra words before season/episode, rejecting`);
          return false;
        }
      } else {
        // No season/episode in title, reject if it doesn't match the main query exactly
        logger.debug(`Strict mode - no season/episode pattern in title, rejecting`);
        return false;
      }

      // Check if main query is fully contained at the start of the title
      // First remove year if present to avoid it interfering with word comparison
      const yearPattern = /\b(19\d{2}|20\d{2})\b/;
      const titleBeforeSE = sanitizedTitle.split(seasonEpisodePattern)[0].trim();
      const titleWithoutYear = titleBeforeSE.replace(yearPattern, '').trim();
      const titleWordsWithoutYear = titleWithoutYear.split(/\s+/);

      const isExactWordMatch = mainQueryWords.every(
        (word, i) => i < titleWordsWithoutYear.length && titleWordsWithoutYear[i] === word
      );

      if (!isExactWordMatch) {
        logger.debug(
          `Strict mode - query words don't match exactly at beginning of title, rejecting`
        );
        return false;
      }

      // If we've reached here, the title matches the query part exactly and has valid season/episode info
      logger.debug(`Strict mode - series title matches criteria`);
      return true;
    }

    // For movies or other non-series content
    const { title: parsedTitle, year } = parseTorrentTitle(title);
    logger.debug(`Strict mode - parsed title: "${parsedTitle}", year: ${year}`);

    if (parsedTitle) {
      const sanitizedParsedTitle = sanitizeTitle(parsedTitle);
      const parsedTitleWords = sanitizedParsedTitle.split(/\s+/);
      const queryWords = sanitizedQuery.split(/\s+/);

      // For movies, only match if:
      // 1. The parsed title is EXACTLY the query
      if (sanitizedParsedTitle === sanitizedQuery) {
        logger.debug(`Strict mode - exact match found`);
        return true;
      }

      // 2. Or if title has a year, check if title without year matches query exactly
      if (year) {
        const titleWithoutYear = sanitizedParsedTitle.replace(year.toString(), '').trim();
        if (titleWithoutYear === sanitizedQuery) {
          logger.debug(`Strict mode - title matches query after removing year`);
          return true;
        }
      }

      // 3. Or if query has a year and title has a year, check if both title and year match
      const queryYearMatch = sanitizedQuery.match(/\b(\d{4})\b/);
      if (queryYearMatch && year) {
        const queryYear = queryYearMatch[1];
        const queryWithoutYear = sanitizedQuery.replace(queryYear, '').trim();
        const titleWithoutYear = sanitizedParsedTitle.replace(year.toString(), '').trim();

        if (queryWithoutYear === titleWithoutYear && year.toString() === queryYear) {
          logger.debug(`Strict mode - title and year match query`);
          return true;
        }
      }

      // 4. Reject if parsed title has more words than query (e.g. "grace and frankie" for "grace")
      // First remove any year from the title
      const yearPattern = /\b(19\d{2}|20\d{2})\b/;
      const parsedTitleWithoutYear = sanitizedParsedTitle.replace(yearPattern, '').trim();
      const parsedTitleWordsWithoutYear = parsedTitleWithoutYear.split(/\s+/);

      if (parsedTitleWordsWithoutYear.length > queryWords.length) {
        logger.debug(`Strict mode - parsed title has extra words (excluding year), rejecting`);
        return false;
      }
    }

    // If we're in strict mode and haven't matched by now, return false
    logger.debug(`Strict mode - no match found`);
    return false;
  }

  // Non-strict mode below (original behavior)
  logger.debug(`Non-strict mode matching`);

  // For series with season/episode pattern like S01E01
  const seasonEpisodePattern = /s\d+e\d+/i;
  const hasSeasonEpisodePattern = seasonEpisodePattern.test(sanitizedQuery);

  if (hasSeasonEpisodePattern) {
    // Extract season/episode pattern
    const seMatch = sanitizedQuery.match(seasonEpisodePattern);
    if (seMatch && seMatch[0]) {
      const pattern = seMatch[0].toLowerCase();

      // The episode code must be present in the candidate title...
      if (!sanitizedTitle.includes(pattern)) {
        logger.debug(`Non-strict mode - episode code "${pattern}" not in title, rejecting`);
        return false;
      }

      // ...but the episode code alone isn't enough: many unrelated shows share
      // codes like "s01e01". Also require the query's show-name words to overlap
      // the title, using the same 70% threshold as the multi-word check below so
      // non-strict matching stays permissive without matching the wrong show.
      const nameWords = sanitizedQuery
        .replace(seasonEpisodePattern, ' ')
        .split(/\s+/)
        .filter(word => word.length > 2);

      if (nameWords.length === 0) {
        // Query was essentially just the episode code — accept the code match.
        logger.debug(`Non-strict mode - episode-only query, matched on "${pattern}"`);
        return true;
      }

      // Compare the query's show-name words against the candidate's PARSED show
      // title (via parse-torrent-title), not the raw filename. The parser strips
      // the episode subtitle, release group and quality tags, so a query word
      // that only appears in those (e.g. "snake" inside the group "-SNAKE", or a
      // common word sitting in an episode subtitle) no longer produces a false
      // match. Whole-word matching additionally stops "killer" matching
      // "killers". Falls back to the sanitized filename when the parser can't
      // extract a title. (Strict mode and the non-episode paths are unchanged.)
      const parsedCandidateTitle = parseTorrentTitle(title)?.title;
      const nameHaystack = parsedCandidateTitle
        ? sanitizeTitle(parsedCandidateTitle)
        : sanitizedTitle;
      const matchingNameWords = nameWords.filter(word => wordInText(word, nameHaystack)).length;
      const nameRatio = matchingNameWords / nameWords.length;
      logger.debug(
        `Non-strict mode - episode "${pattern}" present, name overlap ${nameRatio.toFixed(2)} (${matchingNameWords}/${nameWords.length}) against parsed title "${nameHaystack}"`
      );
      return nameRatio >= 0.7;
    }
  }

  // Check that all words in the query appear in the title
  const queryWords = sanitizedQuery.split(/\s+/);
  const allWordsMatch = queryWords.every(word => {
    // Skip very short words (1-2 chars) to avoid false positives
    if (word.length <= 2) return true;
    return sanitizedTitle.includes(word);
  });
  logger.debug(`Non-strict mode - all words match: ${allWordsMatch}`);

  // For multiple word queries, ensure the title contains the full phrase
  // or at least a high percentage of matching words
  if (queryWords.length > 1 && !strict) {
    // Count matching words
    const matchingWords = queryWords.filter(
      word => word.length > 2 && sanitizedTitle.includes(word)
    ).length;

    // If more than 70% of significant words match, consider it a match
    const significantWords = queryWords.filter(word => word.length > 2).length;
    if (significantWords > 0) {
      const matchRatio = matchingWords / significantWords;
      logger.debug(
        `Non-strict mode - match ratio: ${matchRatio.toFixed(2)} (${matchingWords}/${significantWords})`
      );
      return matchRatio >= 0.7;
    }
  }

  logger.debug(`Non-strict mode final result: ${allWordsMatch}`);
  return allWordsMatch;
}

/**
 * Thrown by {@link createStreamUrl} when no proxy base URL is available and
 * insecure credential-in-URL mode has not been explicitly enabled. Callers can
 * catch this to surface a "reconfigure the addon" message to the user.
 */
export class MissingBaseUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MissingBaseUrlError';
  }
}

/**
 * Create a stream URL that routes through the addon's /resolve endpoint.
 * Falls back to ADDON_BASE_URL, and only embeds credentials directly in the URL
 * when ALLOW_INSECURE_CREDENTIAL_URLS is explicitly enabled.
 */
export function createStreamUrl(
  { downURL, dlFarm, dlPort }: Pick<EasynewsSearchResponse, 'downURL' | 'dlFarm' | 'dlPort'>,
  username: string,
  password: string,
  filePath: string,
  baseUrl?: string
): string {
  logger.debug(`Creating stream URL with farm: ${dlFarm}, port: ${dlPort}`);

  // Prefer the per-install baseUrl from config; fall back to a server-wide
  // ADDON_BASE_URL so installs predating baseUrl injection are still proxied.
  const effectiveBaseUrl = baseUrl || process.env.ADDON_BASE_URL;

  if (!effectiveBaseUrl) {
    // No proxy base available. Embedding the user's Easynews credentials directly
    // in the stream URL (legacy mode) leaks them to the player and any
    // intermediary, so it is disabled unless explicitly opted into.
    if (process.env.ALLOW_INSECURE_CREDENTIAL_URLS === 'true') {
      const url = `${downURL.replace('https://', `https://${username}:${password}@`)}/${dlFarm}/${dlPort}/${filePath}`;
      // Never log the credential portion of the URL.
      logger.warn(
        `Stream URL created in INSECURE legacy mode (credentials embedded in URL): ` +
          `${dlFarm}/${dlPort}/${filePath}. Set ADDON_BASE_URL to route via the /resolve proxy instead.`
      );
      return url;
    }
    throw new MissingBaseUrlError(
      'createStreamUrl: no baseUrl available (config.baseUrl and ADDON_BASE_URL are both unset). ' +
        'Refusing to embed Easynews credentials in the stream URL. Re-install via the /configure ' +
        'page, set ADDON_BASE_URL, or set ALLOW_INSECURE_CREDENTIAL_URLS=true to restore the ' +
        'insecure legacy behavior.'
    );
  }

  // Resolve mode: route via addon's /resolve endpoint.
  const url = `${downURL}/${dlFarm}/${dlPort}/${filePath}`;
  // Credentials as query‐parameters
  const authUrl = `${url}?u=${encodeURIComponent(username)}&p=${encodeURIComponent(password)}`;
  // Base64URL-encode authUrl
  const encodedUrl = Buffer.from(authUrl).toString('base64url');
  // Extract the filename
  const fileName = path.basename(filePath);
  // Strip any trailing slash on baseUrl before concatenating
  const normalizedBase = effectiveBaseUrl.replace(/\/+$/, '');
  // Build /resolve/<base64-payload>/<filename>
  logger.debug(`Stream URL created: ${normalizedBase}/resolve/<encoded-easynews-url>/${fileName}`);
  return `${normalizedBase}/resolve/${encodedUrl}/${fileName}`;
}

export function createStreamPath(file: FileData) {
  const postHash = file['0'] ?? '';
  const postTitle = file['10'] ?? '';
  const ext = file['11'] ?? '';

  const path = `${postHash}${ext}/${postTitle}${ext}`;
  logger.debug(`Created stream path: ${path.substring(0, 50)}${path.length > 50 ? '...' : ''}`);
  return path;
}

export function getFileExtension(file: FileData) {
  return file['2'] ?? '';
}

export function getPostTitle(file: FileData) {
  return file['10'] ?? '';
}

export function getDuration(file: FileData) {
  return file['14'] ?? '';
}

export function getSize(file: FileData) {
  return file['4'] ?? '';
}

/**
 * Extract video quality information from the title or fallback resolution
 */
export function getQuality(title: string, fallbackResolution?: string): string | undefined {
  logger.debug(`Getting quality for: "${title}", fallback: ${fallbackResolution}`);
  const { resolution } = parseTorrentTitle(title);

  // Try to find quality indicators in the title if resolution not found
  if (!resolution && title) {
    const qualityPatterns = [
      // Common resolution patterns
      { pattern: /\b720p\b/i, quality: '720p' },
      { pattern: /\b1080p\b/i, quality: '1080p' },
      { pattern: /\b2160p\b/i, quality: '4K/2160p' },
      { pattern: /\b4k\b/i, quality: '4K' },
      { pattern: /\buhd\b/i, quality: '4K/UHD' },
      { pattern: /\bhdr\b/i, quality: 'HDR' },
      // Common quality indicators
      { pattern: /\bhq\b/i, quality: 'HQ' },
      { pattern: /\bbdrip\b/i, quality: 'BDRip' },
      { pattern: /\bbluray\b/i, quality: 'BluRay' },
      { pattern: /\bweb-?dl\b/i, quality: 'WEB-DL' },
    ];

    for (const { pattern, quality } of qualityPatterns) {
      if (pattern.test(title)) {
        logger.debug(`Quality found by pattern: ${quality}`);
        return quality;
      }
    }
  }

  // Return resolution found by parser
  if (resolution) {
    // Map common resolution formats to standard quality names
    if (resolution === '2160p' || resolution.includes('4k') || resolution.includes('4K')) {
      logger.debug(`Quality found by parser: 4K`);
      return '4K';
    }
    logger.debug(`Quality found by parser: ${resolution}`);
    return resolution;
  }

  // Use fallback if provided
  if (fallbackResolution) {
    logger.debug(`Using fallback quality: ${fallbackResolution}`);
    return fallbackResolution;
  }

  logger.debug(`No quality found`);
  return undefined;
}

export function createThumbnailUrl(res: EasynewsSearchResponse, file: FileData) {
  const id = file['0'];
  const idChars = id.slice(0, 3);
  const thumbnailSlug = file['10'];
  return `${res.thumbURL}${idChars}/pr-${id}.jpg/th-${thumbnailSlug}.jpg`;
}

/**
 * @param value String to extract digits from
 * @returns The first sequence of digits found in the string or undefined
 */
export function extractDigits(value: string) {
  if (!value) {
    return undefined;
  }

  const match = value.match(/\d+/);

  if (match) {
    return parseInt(match[0], 10);
  }

  return undefined;
}

/**
 * Gets potential alternative titles based on the original title
 * @param title The original title
 * @param customTitlesInput Optional custom titles object
 * @returns Array of potential alternative titles including the original one
 */
export function getAlternativeTitles(
  title: string,
  customTitlesInput: Record<string, string[]> = customTitlesJson
): string[] {
  logger.debug(`Getting alternative titles for: "${title}"`);

  // Start with an empty array
  const alternatives: string[] = [title];

  // Check direct match first
  if (customTitlesInput[title]) {
    logger.debug(`Found direct match in custom titles for: "${title}"`);
    alternatives.push(...customTitlesInput[title]);
  }

  // Then check partial matches
  for (const [key, values] of Object.entries(customTitlesInput)) {
    // Skip direct matches that we've already handled
    if (key === title) continue;

    // Check if either string contains the other
    if (
      title.toLowerCase().includes(key.toLowerCase()) ||
      key.toLowerCase().includes(title.toLowerCase())
    ) {
      logger.debug(`Found partial match between "${title}" and "${key}"`);

      // Check if any of these alternatives are already in our list
      const newValues = values.filter(v => !alternatives.includes(v));
      if (newValues.length > 0) {
        logger.debug(
          `Adding ${newValues.length} new alternatives from partial match: ${newValues.join(', ')}`
        );
        alternatives.push(...newValues);
      }
    }
  }

  if (alternatives.length > 1) {
    logger.debug(`Found ${alternatives.length - 1} alternative titles for "${title}"`);
  } else {
    logger.debug(`No alternative titles found for "${title}"`);
  }

  return alternatives;
}

/**
 * Build a search query for different content types
 */
export function buildSearchQuery(type: ContentType, meta: MetaProviderResponse) {
  logger.debug(`Building search query for ${type}: ${meta.name} (year: ${meta.year || 'none'})`);

  let query = '';

  // Build advanced query with specific formats based on content type
  switch (type) {
    case 'movie':
      // For movies, we can search directly by name (and year if available)
      query = meta.year ? `${meta.name} ${meta.year}` : meta.name;
      break;
    case 'series':
      // For series, we need to include the season and episode
      if (meta.episode && meta.season) {
        // Format: Name S01E01
        query = `${meta.name} S${meta.season.toString().padStart(2, '0')}E${meta.episode
          .toString()
          .padStart(2, '0')}`;
      } else {
        // Just the name as fallback
        query = meta.name;
      }
      break;
    default:
      // Default to just the name
      query = meta.name;
  }

  logger.debug(`Final search query: ${query}`);
  return query;
}

// These methods should remain at the bottom of the file
export function logError(message: { message: string; error: unknown; context: unknown }) {
  logger.error(`Error: ${message.message}`, message);
}

export function capitalizeFirstLetter(str: string): string {
  if (!str) return str;
  return str.charAt(0).toUpperCase() + str.slice(1);
}

/**
 * Checks if an error is related to authentication
 * @param err Any error object or string
 * @returns True if the error appears to be authentication-related
 */
export function isAuthError(err: unknown): boolean {
  return /auth|login|username|password|credentials|unauthorized|forbidden/i.test(String(err));
}
