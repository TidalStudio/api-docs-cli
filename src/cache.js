/**
 * Cache management module for api-docs-cli
 * Handles persistent caching of API specs with TTL support
 */

import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, unlink, access } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

// ============================================================================
// Custom Error Classes
// ============================================================================

/**
 * Base error class for cache-related errors
 */
export class CacheError extends Error {
  constructor(message, cause = null) {
    super(message);
    this.name = 'CacheError';
    this.cause = cause;
  }
}

/**
 * Thrown when a cached spec is not found
 */
export class CacheNotFoundError extends CacheError {
  constructor(url, cause = null) {
    super(`Cached spec not found for URL: ${url}`, cause);
    this.name = 'CacheNotFoundError';
    this.url = url;
  }
}

/**
 * Thrown when a cached spec has expired (TTL exceeded)
 */
export class CacheExpiredError extends CacheError {
  constructor(url, expiredAt, cause = null) {
    super(`Cached spec expired for URL: ${url}`, cause);
    this.name = 'CacheExpiredError';
    this.url = url;
    this.expiredAt = expiredAt;
  }
}

/**
 * Thrown when cache I/O operations fail
 */
export class CacheIOError extends CacheError {
  constructor(operation, path, cause = null) {
    super(`Cache ${operation} failed for path: ${path}`, cause);
    this.name = 'CacheIOError';
    this.operation = operation;
    this.path = path;
  }
}

// ============================================================================
// Default Configurations
// ============================================================================

const CACHE_DIR_NAME = '.cache/api-docs-cli/specs';
const MANIFEST_FILENAME = 'index.json';
const DEFAULT_TTL_MS = null; // null means no expiration by default

/**
 * Default manifest structure when none exists
 */
const EMPTY_MANIFEST = {
  version: 1,
  entries: {},
};

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Generates a deterministic cache key from a URL using SHA256.
 * Uses first 16 characters of the hash for reasonable uniqueness
 * while keeping filenames manageable.
 *
 * @param {string} url - The API spec URL
 * @returns {string} 16-character hex hash
 */
export function generateCacheKey(url) {
  return createHash('sha256')
    .update(url.trim().toLowerCase())
    .digest('hex')
    .slice(0, 16);
}

/**
 * Gets the absolute path to the cache directory.
 * Uses user's home directory to keep cache files out of project.
 *
 * @returns {string} Absolute path to cache directory (~/.cache/api-docs-cli/specs)
 */
export function getCacheDirectory() {
  return join(homedir(), CACHE_DIR_NAME);
}

/**
 * Ensures the cache directory exists, creating it if necessary.
 *
 * @returns {Promise<void>}
 * @throws {CacheIOError} If directory creation fails
 */
async function ensureCacheDirectory() {
  const dir = getCacheDirectory();
  try {
    await mkdir(dir, { recursive: true });
  } catch (error) {
    throw new CacheIOError('create directory', dir, error);
  }
}

/**
 * Reads the cache manifest file.
 * Returns empty manifest if file doesn't exist.
 *
 * @returns {Promise<Object>} Manifest object
 * @throws {CacheIOError} If read fails (except ENOENT)
 */
async function readManifest() {
  const manifestPath = join(getCacheDirectory(), MANIFEST_FILENAME);
  try {
    const data = await readFile(manifestPath, 'utf-8');
    return JSON.parse(data);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return { ...EMPTY_MANIFEST };
    }
    throw new CacheIOError('read manifest', manifestPath, error);
  }
}

/**
 * Writes the cache manifest file.
 * Uses pretty-printed JSON for human readability.
 *
 * @param {Object} manifest - Manifest object to write
 * @returns {Promise<void>}
 * @throws {CacheIOError} If write fails
 */
async function writeManifest(manifest) {
  await ensureCacheDirectory();
  const manifestPath = join(getCacheDirectory(), MANIFEST_FILENAME);
  try {
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');
  } catch (error) {
    throw new CacheIOError('write manifest', manifestPath, error);
  }
}

/**
 * Checks if a cache entry has expired based on its expiresAt field.
 *
 * @param {Object} entry - Cache entry with optional expiresAt
 * @returns {boolean} True if expired, false otherwise
 */
function isExpired(entry) {
  if (!entry.expiresAt) {
    return false; // No TTL set, never expires
  }
  return new Date(entry.expiresAt) < new Date();
}

/**
 * Normalizes an API spec to extract metadata.
 * Detects spec type (OpenAPI 3.x, Swagger 2.0) and extracts key info.
 *
 * @param {Object} spec - Parsed spec object
 * @param {string} originalFormat - "json" or "yaml"
 * @returns {Object} Normalized spec metadata
 */
function normalizeSpec(spec, originalFormat = 'json') {
  // Detect spec type and version
  let specType = 'unknown';
  let specVersion = null;

  if (spec.openapi && spec.openapi.startsWith('3.')) {
    specType = 'openapi';
    specVersion = spec.openapi;
  } else if (spec.swagger && spec.swagger === '2.0') {
    specType = 'swagger';
    specVersion = spec.swagger;
  }

  return {
    title: spec.info?.title || 'Unknown API',
    version: spec.info?.version || 'unknown',
    type: specType,
    specVersion,
    originalFormat,
  };
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Retrieves a cached API spec by URL.
 *
 * @param {string} url - The API spec URL to look up
 * @param {Object} options - Retrieval options
 * @param {boolean} [options.ignoreExpired=false] - Return expired entries anyway
 * @returns {Promise<Object>} Cached spec with metadata
 * @throws {CacheNotFoundError} If no cache entry exists for URL
 * @throws {CacheExpiredError} If entry exists but has expired (unless ignoreExpired)
 * @throws {CacheIOError} If reading cache files fails
 *
 * @example
 * const cached = await getCached('https://api.example.com/openapi.json');
 * console.log(cached.spec);      // The API spec
 * console.log(cached.metadata);  // Cache metadata
 */
export async function getCached(url, options = {}) {
  const { ignoreExpired = false } = options;
  const key = generateCacheKey(url);
  const manifest = await readManifest();

  const entry = manifest.entries[key];
  if (!entry) {
    throw new CacheNotFoundError(url);
  }

  // Check expiration
  if (!ignoreExpired && isExpired(entry)) {
    throw new CacheExpiredError(url, entry.expiresAt);
  }

  // Read the cached spec file
  const specPath = join(getCacheDirectory(), entry.filename);
  try {
    const data = await readFile(specPath, 'utf-8');
    return JSON.parse(data);
  } catch (error) {
    if (error.code === 'ENOENT') {
      // Spec file missing but entry exists - corrupted cache
      throw new CacheNotFoundError(url, error);
    }
    throw new CacheIOError('read spec', specPath, error);
  }
}

/**
 * Stores an API spec in the cache.
 *
 * @param {string} url - The API spec URL (used as key)
 * @param {Object|string} spec - The API spec (object or JSON string)
 * @param {Object} options - Cache options
 * @param {number|null} [options.ttl=null] - TTL in milliseconds (null = no expiration)
 * @param {string} [options.originalFormat='json'] - Original format ('json' or 'yaml')
 * @returns {Promise<Object>} Cache entry metadata
 * @throws {CacheIOError} If writing cache files fails
 *
 * @example
 * // Cache with 24-hour TTL
 * await setCache('https://api.example.com/openapi.json', spec, {
 *   ttl: 24 * 60 * 60 * 1000
 * });
 *
 * // Cache indefinitely
 * await setCache('https://api.example.com/openapi.json', spec);
 */
export async function setCache(url, spec, options = {}) {
  const { ttl = DEFAULT_TTL_MS, originalFormat = 'json' } = options;

  // Parse spec if string
  const specObj = typeof spec === 'string' ? JSON.parse(spec) : spec;

  await ensureCacheDirectory();

  const key = generateCacheKey(url);
  const filename = `${key}.json`;
  const now = new Date();
  const expiresAt = ttl ? new Date(now.getTime() + ttl).toISOString() : null;

  // Extract spec info for manifest
  const specInfo = normalizeSpec(specObj, originalFormat);

  // Prepare cached data
  const cachedData = {
    metadata: {
      url,
      cachedAt: now.toISOString(),
      expiresAt,
      originalFormat,
      specType: specInfo.type,
      specVersion: specInfo.specVersion,
    },
    spec: specObj,
  };

  // Write spec file
  const specPath = join(getCacheDirectory(), filename);
  try {
    await writeFile(specPath, JSON.stringify(cachedData, null, 2), 'utf-8');
  } catch (error) {
    throw new CacheIOError('write spec', specPath, error);
  }

  // Update manifest
  const manifest = await readManifest();
  manifest.entries[key] = {
    url,
    filename,
    cachedAt: now.toISOString(),
    expiresAt,
    specInfo: {
      title: specInfo.title,
      version: specInfo.version,
      type: specInfo.type,
    },
  };
  await writeManifest(manifest);

  return manifest.entries[key];
}

/**
 * Lists all cached API specs.
 *
 * @param {Object} options - List options
 * @param {boolean} [options.includeExpired=true] - Include expired entries
 * @param {boolean} [options.checkFiles=false] - Verify spec files exist
 * @returns {Promise<Array<Object>>} Array of cache entries
 * @throws {CacheIOError} If reading manifest fails
 *
 * @example
 * const entries = await listCache();
 * entries.forEach(entry => {
 *   console.log(`${entry.specInfo.title}: ${entry.url}`);
 * });
 */
export async function listCache(options = {}) {
  const { includeExpired = true, checkFiles = false } = options;

  const manifest = await readManifest();
  let entries = Object.values(manifest.entries);

  // Filter expired if requested
  if (!includeExpired) {
    entries = entries.filter((entry) => !isExpired(entry));
  }

  // Optionally verify files exist
  if (checkFiles) {
    const verified = [];
    for (const entry of entries) {
      const specPath = join(getCacheDirectory(), entry.filename);
      try {
        await access(specPath);
        verified.push({
          ...entry,
          isExpired: isExpired(entry),
        });
      } catch {
        // File missing - skip this entry
      }
    }
    return verified;
  }

  return entries.map((entry) => ({
    ...entry,
    isExpired: isExpired(entry),
  }));
}

/**
 * Clears cached specs.
 *
 * @param {string|null} url - Specific URL to clear, or null to clear all
 * @returns {Promise<Object>} Result with cleared count
 * @throws {CacheNotFoundError} If specified URL not in cache
 * @throws {CacheIOError} If deletion fails
 *
 * @example
 * // Clear specific entry
 * await clearCache('https://api.example.com/openapi.json');
 *
 * // Clear entire cache
 * await clearCache();
 */
export async function clearCache(url = null) {
  const manifest = await readManifest();
  const cacheDir = getCacheDirectory();

  if (url) {
    // Clear specific entry
    const key = generateCacheKey(url);
    const entry = manifest.entries[key];

    if (!entry) {
      throw new CacheNotFoundError(url);
    }

    // Delete spec file
    const specPath = join(cacheDir, entry.filename);
    try {
      await unlink(specPath);
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw new CacheIOError('delete spec', specPath, error);
      }
    }

    // Update manifest
    delete manifest.entries[key];
    await writeManifest(manifest);

    return { cleared: 1, urls: [url] };
  }

  // Clear all entries
  const urls = Object.values(manifest.entries).map((e) => e.url);
  const count = urls.length;

  // Delete all spec files
  for (const entry of Object.values(manifest.entries)) {
    const specPath = join(cacheDir, entry.filename);
    try {
      await unlink(specPath);
    } catch (error) {
      if (error.code !== 'ENOENT') {
        // Log but continue - best effort cleanup
        console.warn(`Warning: Could not delete ${specPath}`);
      }
    }
  }

  // Write empty manifest
  await writeManifest({ ...EMPTY_MANIFEST });

  return { cleared: count, urls };
}
