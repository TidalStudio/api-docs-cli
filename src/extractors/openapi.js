/**
 * OpenAPI/Swagger specification extractor module
 * Fetches raw OpenAPI specs directly from common URL paths without Puppeteer
 */

import yaml from 'js-yaml';

// ============================================================================
// Custom Error Classes
// ============================================================================

/**
 * Base error class for OpenAPI extractor errors
 */
export class OpenAPIExtractorError extends Error {
  constructor(message, cause = null) {
    super(message);
    this.name = 'OpenAPIExtractorError';
    this.cause = cause;
  }
}

/**
 * Thrown when fetch request fails
 */
export class FetchError extends OpenAPIExtractorError {
  constructor(url, statusCode, cause = null) {
    super(`Failed to fetch: ${url} (${statusCode || 'network error'})`, cause);
    this.name = 'FetchError';
    this.url = url;
    this.statusCode = statusCode;
  }
}

/**
 * Thrown when response cannot be parsed as JSON or YAML
 */
export class ParseError extends OpenAPIExtractorError {
  constructor(url, format, cause = null) {
    super(`Failed to parse ${format} from: ${url}`, cause);
    this.name = 'ParseError';
    this.url = url;
    this.format = format;
  }
}

/**
 * Thrown when parsed content is not a valid OpenAPI/Swagger spec
 */
export class InvalidSpecError extends OpenAPIExtractorError {
  constructor(url, reason, cause = null) {
    super(`Invalid OpenAPI/Swagger spec from ${url}: ${reason}`, cause);
    this.name = 'InvalidSpecError';
    this.url = url;
    this.reason = reason;
  }
}

// ============================================================================
// Configuration
// ============================================================================

/**
 * Common OpenAPI/Swagger endpoint paths to probe
 * Ordered by likelihood of success
 */
export const COMMON_SPEC_PATHS = [
  // OpenAPI 3.x common paths
  '/openapi.json',
  '/openapi.yaml',
  '/openapi.yml',

  // Swagger 2.0 common paths
  '/swagger.json',
  '/swagger.yaml',
  '/swagger.yml',

  // Generic API docs paths
  '/api-docs',
  '/api-docs.json',
  '/api-docs.yaml',
  '/api-docs.yml',

  // Versioned paths (Spring Boot, etc.)
  '/v2/api-docs',
  '/v3/api-docs',

  // Nested docs paths
  '/docs/openapi.json',
  '/docs/swagger.json',
  '/docs/openapi.yaml',
  '/docs/swagger.yaml',

  // Alternative common paths
  '/api/openapi.json',
  '/api/swagger.json',
  '/spec/openapi.json',
  '/swagger/v2/api-docs',
  '/swagger/v3/api-docs',
];

const DEFAULT_FETCH_TIMEOUT_MS = 10000;
const DEFAULT_USER_AGENT = 'api-docs-cli/0.1.0';

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Determines if a URL points directly to a spec file (vs base URL)
 *
 * @param {string} url - URL to check
 * @returns {boolean} True if URL appears to point to a spec file
 */
function isDirectSpecUrl(url) {
  const lower = url.toLowerCase();
  return (
    lower.endsWith('.json') ||
    lower.endsWith('.yaml') ||
    lower.endsWith('.yml') ||
    lower.includes('/api-docs') ||
    lower.includes('/openapi') ||
    lower.includes('/swagger')
  );
}

/**
 * Parses content as JSON or YAML
 *
 * @param {string} content - Raw response content
 * @param {string} url - Source URL (for format detection)
 * @returns {{spec: Object, format: string}} Parsed spec and detected format
 * @throws {ParseError} If parsing fails
 */
function parseSpecContent(content, url) {
  const trimmed = content.trim();
  const lower = url.toLowerCase();

  // Try JSON first if URL suggests JSON or content looks like JSON
  if (lower.endsWith('.json') || trimmed.startsWith('{')) {
    try {
      return { spec: JSON.parse(trimmed), format: 'json' };
    } catch (jsonError) {
      // If explicitly JSON URL, throw immediately
      if (lower.endsWith('.json')) {
        throw new ParseError(url, 'json', jsonError);
      }
      // Otherwise fall through to YAML
    }
  }

  // Try YAML parsing
  try {
    const parsed = yaml.load(trimmed);
    if (typeof parsed === 'object' && parsed !== null) {
      return { spec: parsed, format: 'yaml' };
    }
    throw new Error('YAML parsed to non-object');
  } catch (yamlError) {
    throw new ParseError(url, 'yaml', yamlError);
  }
}

/**
 * Validates that parsed content is a valid OpenAPI/Swagger specification
 *
 * @param {Object} spec - Parsed specification object
 * @param {string} url - Source URL for error reporting
 * @returns {Object} Validated spec info
 * @throws {InvalidSpecError} If spec is invalid
 */
function validateSpec(spec, url) {
  if (!spec || typeof spec !== 'object') {
    throw new InvalidSpecError(url, 'Spec must be an object');
  }

  // Check for OpenAPI 3.x
  if (spec.openapi && typeof spec.openapi === 'string' && spec.openapi.startsWith('3.')) {
    if (!spec.info) {
      throw new InvalidSpecError(url, 'Missing required "info" field');
    }
    if (!spec.paths && !spec.webhooks && !spec.components) {
      throw new InvalidSpecError(url, 'Missing paths, webhooks, or components');
    }
    return {
      type: 'openapi',
      version: spec.openapi,
      title: spec.info?.title || 'Unknown API',
      apiVersion: spec.info?.version || 'unknown',
    };
  }

  // Check for Swagger 2.0
  if (spec.swagger && spec.swagger === '2.0') {
    if (!spec.info) {
      throw new InvalidSpecError(url, 'Missing required "info" field');
    }
    if (!spec.paths) {
      throw new InvalidSpecError(url, 'Missing required "paths" field');
    }
    return {
      type: 'swagger',
      version: spec.swagger,
      title: spec.info?.title || 'Unknown API',
      apiVersion: spec.info?.version || 'unknown',
    };
  }

  throw new InvalidSpecError(url, 'Not a valid OpenAPI 3.x or Swagger 2.0 specification');
}

/**
 * Extracts base URL from a full URL
 *
 * @param {string} url - Full URL
 * @returns {string} Base URL (protocol + host + port)
 */
function getBaseUrl(url) {
  const parsed = new URL(url);
  return `${parsed.protocol}//${parsed.host}`;
}

/**
 * Attempts to fetch a spec from a specific URL
 *
 * @param {string} url - URL to fetch
 * @param {Object} options - Fetch options
 * @param {number} [options.timeout] - Request timeout in ms
 * @returns {Promise<{spec: Object, format: string, specInfo: Object, url: string}|null>}
 */
async function tryFetchSpec(url, options = {}) {
  const { timeout = DEFAULT_FETCH_TIMEOUT_MS } = options;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: 'application/json, application/yaml, text/yaml, */*',
        'User-Agent': DEFAULT_USER_AGENT,
      },
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      return null; // Not found or error - try next path
    }

    const contentType = response.headers.get('content-type') || '';
    const content = await response.text();

    // Skip HTML responses (common for 404 pages that return 200)
    if (contentType.includes('text/html') && !content.trim().startsWith('{')) {
      return null;
    }

    const { spec, format } = parseSpecContent(content, url);
    const specInfo = validateSpec(spec, url);

    return { spec, format, specInfo, url };
  } catch (error) {
    clearTimeout(timeoutId);

    // AbortError means timeout - return null to try next
    if (error.name === 'AbortError') {
      return null;
    }

    // Parse/validation errors should not prevent trying other paths
    if (error instanceof ParseError || error instanceof InvalidSpecError) {
      return null;
    }

    // Network errors - return null to continue
    return null;
  }
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Attempts to fetch an OpenAPI/Swagger specification from a URL.
 *
 * If the URL appears to point directly to a spec file, it will be fetched directly.
 * Otherwise, common spec paths will be probed from the base URL.
 *
 * @param {string} url - URL to fetch from (base URL or direct spec URL)
 * @param {Object} options - Extraction options
 * @param {number} [options.timeout=10000] - Per-request timeout in ms
 * @param {boolean} [options.probeCommonPaths=true] - Try common paths if direct fetch fails
 * @returns {Promise<Object|null>} Extracted spec result or null if not found
 * @returns {Object} result.spec - The parsed OpenAPI/Swagger specification
 * @returns {string} result.format - Original format ('json' or 'yaml')
 * @returns {Object} result.specInfo - Spec metadata (type, version, title)
 * @returns {string} result.sourceUrl - URL the spec was fetched from
 *
 * @example
 * // Direct spec URL
 * const result = await fetchOpenAPISpec('https://api.example.com/openapi.json');
 *
 * // Base URL - will probe common paths
 * const result = await fetchOpenAPISpec('https://api.example.com');
 */
export async function fetchOpenAPISpec(url, options = {}) {
  const { timeout = DEFAULT_FETCH_TIMEOUT_MS, probeCommonPaths = true } = options;

  // Normalize URL
  let normalizedUrl = url.trim();
  if (!normalizedUrl.startsWith('http://') && !normalizedUrl.startsWith('https://')) {
    normalizedUrl = `https://${normalizedUrl}`;
  }

  // Remove trailing slash for consistent path joining
  normalizedUrl = normalizedUrl.replace(/\/+$/, '');

  // If URL looks like a direct spec URL, try it first
  if (isDirectSpecUrl(normalizedUrl)) {
    const result = await tryFetchSpec(normalizedUrl, { timeout });
    if (result) {
      return {
        spec: result.spec,
        format: result.format,
        specInfo: result.specInfo,
        sourceUrl: result.url,
      };
    }
  }

  // Probe common paths from base URL
  if (probeCommonPaths) {
    const baseUrl = isDirectSpecUrl(normalizedUrl) ? getBaseUrl(normalizedUrl) : normalizedUrl;

    for (const path of COMMON_SPEC_PATHS) {
      const probeUrl = `${baseUrl}${path}`;
      const result = await tryFetchSpec(probeUrl, { timeout });

      if (result) {
        return {
          spec: result.spec,
          format: result.format,
          specInfo: result.specInfo,
          sourceUrl: result.url,
        };
      }
    }
  }

  // No spec found
  return null;
}

/**
 * Convenience function to check if a URL has an accessible OpenAPI spec
 * without fully parsing it.
 *
 * @param {string} url - URL to check
 * @param {Object} options - Options passed to fetchOpenAPISpec
 * @returns {Promise<boolean>} True if spec is accessible
 */
export async function hasOpenAPISpec(url, options = {}) {
  const result = await fetchOpenAPISpec(url, options);
  return result !== null;
}
