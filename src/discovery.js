/**
 * API discovery module for api-docs-cli
 * Provides lookup functionality using APITracker.io
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import {
  searchProvider as searchAPITracker,
  ProviderNotFoundError as APITrackerNotFoundError,
  DocsUrlNotFoundError,
  APITrackerSearchError,
} from './extractors/apitracker.js';

// ============================================================================
// Custom Error Classes
// ============================================================================

/**
 * Base error class for discovery-related errors
 */
export class DiscoveryError extends Error {
  constructor(message, cause = null) {
    super(message);
    this.name = 'DiscoveryError';
    this.cause = cause;
  }
}

/**
 * Thrown when no provider matches the query
 */
export class ProviderNotFoundError extends DiscoveryError {
  constructor(query, cause = null) {
    super(`No API provider found matching: ${query}`, cause);
    this.name = 'ProviderNotFoundError';
    this.query = query;
  }
}

/**
 * Thrown when multiple providers match and disambiguation is needed
 * @deprecated No longer used with APITracker, kept for backwards compatibility
 */
export class AmbiguousMatchError extends DiscoveryError {
  constructor(query, matches, cause = null) {
    super(`Multiple providers match "${query}". Please be more specific.`, cause);
    this.name = 'AmbiguousMatchError';
    this.query = query;
    this.matches = matches;
  }
}

/**
 * Thrown when discovery fails
 */
export class DiscoveryFetchError extends DiscoveryError {
  constructor(query, message, cause = null) {
    super(`Discovery failed for "${query}": ${message}`, cause);
    this.name = 'DiscoveryFetchError';
    this.query = query;
  }
}

// ============================================================================
// Configuration
// ============================================================================

const CACHE_DIR_NAME = '.cache/api-docs-cli';
const URL_CACHE_FILENAME = 'apitracker-urls.json';
const URL_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// ============================================================================
// URL Cache Helpers
// ============================================================================

/**
 * Gets the absolute path to the cache directory.
 *
 * @returns {string} Absolute path to cache directory (~/.cache/api-docs-cli)
 */
function getCacheDirectory() {
  return join(homedir(), CACHE_DIR_NAME);
}

/**
 * Ensures the cache directory exists, creating it if necessary.
 *
 * @returns {Promise<void>}
 */
async function ensureCacheDirectory() {
  const dir = getCacheDirectory();
  await mkdir(dir, { recursive: true });
}

/**
 * Reads the URL cache.
 *
 * @returns {Promise<Object>} URL cache object
 */
async function readUrlCache() {
  const cachePath = join(getCacheDirectory(), URL_CACHE_FILENAME);
  try {
    const data = await readFile(cachePath, 'utf-8');
    return JSON.parse(data);
  } catch {
    return { entries: {} };
  }
}

/**
 * Writes the URL cache.
 *
 * @param {Object} cache - Cache object to write
 * @returns {Promise<void>}
 */
async function writeUrlCache(cache) {
  await ensureCacheDirectory();
  const cachePath = join(getCacheDirectory(), URL_CACHE_FILENAME);
  await writeFile(cachePath, JSON.stringify(cache, null, 2), 'utf-8');
}

/**
 * Gets a cached URL for a provider.
 *
 * @param {string} provider - Provider name
 * @returns {Promise<Object|null>} Cached entry or null
 */
async function getCachedUrl(provider) {
  const cache = await readUrlCache();
  const key = provider.toLowerCase().trim();
  const entry = cache.entries[key];

  if (!entry) {
    return null;
  }

  // Check expiration
  if (entry.expiresAt && new Date(entry.expiresAt) < new Date()) {
    return null;
  }

  return entry;
}

/**
 * Caches a URL for a provider.
 *
 * @param {string} provider - Provider name
 * @param {Object} data - Data to cache
 * @returns {Promise<void>}
 */
async function cacheUrl(provider, data) {
  const cache = await readUrlCache();
  const key = provider.toLowerCase().trim();
  const now = new Date();

  cache.entries[key] = {
    ...data,
    cachedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + URL_CACHE_TTL_MS).toISOString(),
  };

  await writeUrlCache(cache);
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Looks up a provider by name and returns their documentation URL.
 * Uses APITracker.io for discovery.
 *
 * @param {string} query - Provider name to search for (e.g., "n8n", "stripe")
 * @param {Object} options - Lookup options
 * @param {boolean} [options.forceRefresh=false] - Bypass cache and search fresh
 * @returns {Promise<Object>} Result object with provider, docsUrl, source
 * @throws {ProviderNotFoundError} If no provider matches
 * @throws {DiscoveryFetchError} If discovery fails
 *
 * @example
 * const result = await lookupProvider('n8n');
 * console.log(result.docsUrl); // 'https://docs.n8n.io/api/api-reference/'
 */
export async function lookupProvider(query, options = {}) {
  const { forceRefresh = false } = options;

  if (!query || typeof query !== 'string' || query.trim() === '') {
    throw new ProviderNotFoundError(query || '');
  }

  const normalizedQuery = query.trim().toLowerCase();

  // Check cache first
  if (!forceRefresh) {
    const cached = await getCachedUrl(normalizedQuery);
    if (cached) {
      return {
        provider: cached.provider,
        docsUrl: cached.docsUrl,
        apiTrackerUrl: cached.apiTrackerUrl,
        source: 'cache',
      };
    }
  }

  // Search APITracker
  try {
    const result = await searchAPITracker(normalizedQuery);

    // Cache the result
    await cacheUrl(normalizedQuery, result);

    return result;
  } catch (error) {
    if (error instanceof APITrackerNotFoundError || error instanceof DocsUrlNotFoundError) {
      throw new ProviderNotFoundError(query, error);
    }
    if (error instanceof APITrackerSearchError) {
      throw new DiscoveryFetchError(query, error.message, error);
    }
    throw new DiscoveryFetchError(query, error.message, error);
  }
}

/**
 * Searches for providers matching the query.
 * Note: APITracker doesn't support multi-result search, so this returns
 * at most one result (the best match).
 *
 * @param {string} query - Search query
 * @param {Object} options - Search options
 * @param {boolean} [options.forceRefresh=false] - Bypass cache
 * @returns {Promise<Array<Object>>} Array with 0 or 1 matching providers
 *
 * @example
 * const matches = await searchProviders('n8n');
 * if (matches.length > 0) {
 *   console.log(matches[0].docsUrl);
 * }
 */
export async function searchProviders(query, options = {}) {
  try {
    const result = await lookupProvider(query, options);
    return [result];
  } catch (error) {
    if (error instanceof ProviderNotFoundError) {
      return [];
    }
    throw error;
  }
}

/**
 * Clears the URL cache.
 *
 * @param {string|null} provider - Specific provider to clear, or null for all
 * @returns {Promise<Object>} Result with cleared count
 *
 * @example
 * // Clear specific entry
 * await clearUrlCache('n8n');
 *
 * // Clear all cached URLs
 * await clearUrlCache();
 */
export async function clearUrlCache(provider = null) {
  const cache = await readUrlCache();

  if (provider) {
    const key = provider.toLowerCase().trim();
    if (cache.entries[key]) {
      delete cache.entries[key];
      await writeUrlCache(cache);
      return { cleared: 1 };
    }
    return { cleared: 0 };
  }

  const count = Object.keys(cache.entries).length;
  await writeUrlCache({ entries: {} });
  return { cleared: count };
}

/**
 * Lists all cached URL mappings.
 *
 * @returns {Promise<Array<Object>>} Array of cached entries
 *
 * @example
 * const cached = await listCachedUrls();
 * cached.forEach(entry => console.log(`${entry.provider}: ${entry.docsUrl}`));
 */
export async function listCachedUrls() {
  const cache = await readUrlCache();
  const now = new Date();

  return Object.values(cache.entries).map((entry) => ({
    ...entry,
    isExpired: entry.expiresAt ? new Date(entry.expiresAt) < now : false,
  }));
}
