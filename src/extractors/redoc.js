/**
 * Redoc page extractor module
 * Uses Puppeteer to extract OpenAPI specs from JavaScript-rendered Redoc pages
 */

import yaml from 'js-yaml';
import { getPage, closeBrowser, BrowserError } from '../browser.js';

// ============================================================================
// Custom Error Classes
// ============================================================================

/**
 * Base error class for Redoc extractor errors
 */
export class RedocExtractorError extends Error {
  constructor(message, cause = null) {
    super(message);
    this.name = 'RedocExtractorError';
    this.cause = cause;
  }
}

/**
 * Thrown when page fails to load
 */
export class PageLoadError extends RedocExtractorError {
  constructor(url, cause = null) {
    super(`Failed to load page: ${url}`, cause);
    this.name = 'PageLoadError';
    this.url = url;
  }
}

/**
 * Thrown when no spec can be found on the page
 */
export class SpecNotFoundError extends RedocExtractorError {
  constructor(url, reason = null) {
    super(`No OpenAPI spec found on page: ${url}${reason ? ` (${reason})` : ''}`, null);
    this.name = 'SpecNotFoundError';
    this.url = url;
    this.reason = reason;
  }
}

/**
 * Thrown when extraction times out
 */
export class ExtractionTimeoutError extends RedocExtractorError {
  constructor(url, timeoutMs) {
    super(`Extraction timed out after ${timeoutMs}ms: ${url}`);
    this.name = 'ExtractionTimeoutError';
    this.url = url;
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Thrown when authentication is required
 */
export class AuthenticationRequiredError extends RedocExtractorError {
  constructor(url) {
    super(`Authentication required to access: ${url}`);
    this.name = 'AuthenticationRequiredError';
    this.url = url;
  }
}

// ============================================================================
// Configuration
// ============================================================================

const DEFAULT_TIMEOUT_MS = 30000;
const REDOC_READY_TIMEOUT_MS = 15000;

// Patterns that indicate spec-related network requests
const SPEC_URL_PATTERNS = [
  /openapi\.json/i,
  /openapi\.yaml/i,
  /openapi\.yml/i,
  /swagger\.json/i,
  /swagger\.yaml/i,
  /swagger\.yml/i,
  /api-docs/i,
  /\/v2\/api-docs/i,
  /\/v3\/api-docs/i,
  /\.yaml$/i,
  /\.yml$/i,
  /\.json$/i,
];

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Validates that parsed content is a valid OpenAPI/Swagger specification
 *
 * @param {Object} spec - Parsed specification object
 * @returns {Object|null} Spec info if valid, null otherwise
 */
function validateSpec(spec) {
  if (!spec || typeof spec !== 'object') {
    return null;
  }

  // Check for OpenAPI 3.x
  if (spec.openapi && typeof spec.openapi === 'string' && spec.openapi.startsWith('3.')) {
    if (!spec.info) {
      return null;
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
    if (!spec.info || !spec.paths) {
      return null;
    }
    return {
      type: 'swagger',
      version: spec.swagger,
      title: spec.info?.title || 'Unknown API',
      apiVersion: spec.info?.version || 'unknown',
    };
  }

  return null;
}

/**
 * Waits for Redoc to be ready on the page
 *
 * @param {import('puppeteer').Page} page - Puppeteer page
 * @param {number} timeout - Timeout in ms
 * @returns {Promise<boolean>} True if Redoc is detected and ready
 */
async function waitForRedoc(page, timeout = REDOC_READY_TIMEOUT_MS) {
  try {
    await page.waitForFunction(
      () => {
        // Check for Redoc presence via multiple indicators
        const hasRedocGlobal =
          typeof window.__redoc_state !== 'undefined' ||
          typeof window.__REDOC_STORE__ !== 'undefined';
        const hasRedocDOM =
          document.querySelector('.redoc-wrap') !== null ||
          document.querySelector('[data-role="redoc"]') !== null ||
          document.querySelector('redoc') !== null ||
          document.querySelector('.api-content') !== null;
        return hasRedocGlobal || hasRedocDOM;
      },
      { timeout }
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Attempts to extract spec from Redoc global state variables
 *
 * @param {import('puppeteer').Page} page - Puppeteer page
 * @returns {Promise<Object|null>} Extracted spec or null
 */
async function extractSpecFromGlobalState(page) {
  try {
    const spec = await page.evaluate(() => {
      // Strategy 1: Try __redoc_state
      if (typeof window.__redoc_state !== 'undefined') {
        const state = window.__redoc_state;

        // Redoc stores spec in various locations depending on version
        if (state.spec && state.spec.data) {
          return state.spec.data;
        }
        if (state.spec) {
          return state.spec;
        }
        if (state.definition && state.definition.spec) {
          return state.definition.spec;
        }
        // Some versions store raw spec at root
        if (state.openapi || state.swagger) {
          return state;
        }
      }

      // Strategy 2: Try __REDOC_STORE__
      if (typeof window.__REDOC_STORE__ !== 'undefined') {
        const store = window.__REDOC_STORE__;

        if (store.spec && store.spec.data) {
          return store.spec.data;
        }
        if (store.spec) {
          return store.spec;
        }
        if (store.definition && store.definition.spec) {
          return store.definition.spec;
        }
        if (store.openapi || store.swagger) {
          return store;
        }
      }

      return null;
    });

    return spec;
  } catch {
    return null;
  }
}

/**
 * Attempts to extract spec URL or inline spec from script tags and DOM
 *
 * @param {import('puppeteer').Page} page - Puppeteer page
 * @returns {Promise<{spec?: Object, specUrl?: string}|null>} Extracted spec/URL or null
 */
async function extractSpecFromScripts(page) {
  try {
    const result = await page.evaluate(() => {
      // Check for <redoc> element with spec-url attribute
      const redocElement = document.querySelector('redoc');
      if (redocElement) {
        const specUrl = redocElement.getAttribute('spec-url');
        if (specUrl) {
          return { specUrl };
        }
      }

      // Search through script tags
      const scripts = document.querySelectorAll('script');
      for (const script of scripts) {
        const content = script.textContent || '';

        // Look for Redoc initialization with specUrl
        const specUrlMatch = content.match(/specUrl\s*:\s*['"]([^'"]+)['"]/);
        if (specUrlMatch) {
          return { specUrl: specUrlMatch[1] };
        }

        // Look for spec-url in Redoc.init calls
        const initMatch = content.match(/Redoc\.init\s*\(\s*['"]([^'"]+)['"]/);
        if (initMatch) {
          return { specUrl: initMatch[1] };
        }

        // Look for inline spec object
        const specMatch = content.match(/spec\s*:\s*(\{[\s\S]*?\})\s*[,}]/);
        if (specMatch) {
          try {
            // eslint-disable-next-line no-eval
            const parsed = eval('(' + specMatch[1] + ')');
            if (parsed && (parsed.openapi || parsed.swagger)) {
              return { spec: parsed };
            }
          } catch {
            // Continue to next match
          }
        }
      }

      return null;
    });

    return result;
  } catch {
    return null;
  }
}

/**
 * Fetches spec from a URL
 *
 * @param {string} specUrl - URL to fetch spec from
 * @param {string} baseUrl - Base URL for resolving relative URLs
 * @returns {Promise<Object|null>} Parsed spec or null
 */
async function fetchSpecFromUrl(specUrl, baseUrl) {
  try {
    // Resolve relative URLs
    const absoluteUrl = new URL(specUrl, baseUrl).href;

    const response = await fetch(absoluteUrl);
    if (!response.ok) {
      return null;
    }

    const text = await response.text();

    // Try JSON first, then YAML
    try {
      return JSON.parse(text);
    } catch {
      try {
        return yaml.load(text);
      } catch {
        return null;
      }
    }
  } catch {
    return null;
  }
}

/**
 * Sets up network interception to capture spec requests
 *
 * @param {import('puppeteer').Page} page - Puppeteer page
 * @returns {Promise<{getSpec: () => Object|null, cleanup: () => void}>}
 */
async function setupNetworkInterception(page) {
  let capturedSpec = null;
  let capturedUrl = null;

  const responseHandler = async (response) => {
    if (capturedSpec) return; // Already captured

    const url = response.url();
    const isSpecUrl = SPEC_URL_PATTERNS.some((pattern) => pattern.test(url));

    if (!isSpecUrl) return;

    try {
      const contentType = response.headers()['content-type'] || '';
      if (contentType.includes('text/html')) return;

      const text = await response.text();
      if (!text || text.trim().startsWith('<')) return;

      // Try to parse as JSON first, then YAML
      let parsed = null;
      try {
        parsed = JSON.parse(text);
      } catch {
        // Not JSON, try YAML
        try {
          parsed = yaml.load(text);
        } catch {
          // Not valid YAML either
        }
      }

      if (parsed && validateSpec(parsed)) {
        capturedSpec = parsed;
        capturedUrl = url;
      }
    } catch {
      // Response might not be accessible
    }
  };

  page.on('response', responseHandler);

  return {
    getSpec: () => (capturedSpec ? { spec: capturedSpec, url: capturedUrl } : null),
    cleanup: () => {
      page.off('response', responseHandler);
    },
  };
}

/**
 * Detects if the page requires authentication
 *
 * @param {import('puppeteer').Page} page - Puppeteer page
 * @returns {Promise<boolean>} True if auth appears to be required
 */
async function detectAuthRequired(page) {
  try {
    const authIndicators = await page.evaluate(() => {
      // Check for login form elements
      const hasLoginForm =
        document.querySelector('input[type="password"]') !== null ||
        document.querySelector('form[action*="login"]') !== null;

      // Check for auth-specific page titles or headers (not API docs content)
      const title = document.title?.toLowerCase() || '';
      const h1Text = document.querySelector('h1')?.innerText?.toLowerCase() || '';

      const hasAuthTitle =
        title.includes('log in') ||
        title.includes('sign in') ||
        title.includes('login') ||
        title.includes('authentication');

      const hasAuthHeader =
        h1Text.includes('log in') ||
        h1Text.includes('sign in') ||
        h1Text.includes('authentication required');

      return hasLoginForm || hasAuthTitle || hasAuthHeader;
    });

    return authIndicators;
  } catch {
    return false;
  }
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Extracts OpenAPI specification from a Redoc page using Puppeteer.
 *
 * Tries multiple extraction strategies in order:
 * 1. Global state variables (__redoc_state, __REDOC_STORE__)
 * 2. Network interception - Captures spec fetch requests
 * 3. DOM/Script inspection - Looks for spec URLs or inline specs
 *
 * @param {string} url - URL of the Redoc page
 * @param {Object} options - Extraction options
 * @param {number} [options.timeout=30000] - Overall timeout in ms
 * @returns {Promise<Object|null>} Extracted spec result or null if not found
 * @returns {Object} result.spec - The parsed OpenAPI/Swagger specification
 * @returns {string} result.format - Always 'json' for Redoc extraction
 * @returns {Object} result.specInfo - Spec metadata (type, version, title)
 * @returns {string} result.sourceUrl - URL the spec was extracted from
 *
 * @throws {PageLoadError} If page fails to load
 * @throws {AuthenticationRequiredError} If authentication is needed
 * @throws {ExtractionTimeoutError} If extraction times out
 * @throws {BrowserError} If browser fails to launch
 *
 * @example
 * const result = await extractFromRedoc('https://redocly.github.io/redoc/');
 * console.log(result.specInfo.title); // "Swagger Petstore"
 */
export async function extractFromRedoc(url, options = {}) {
  const { timeout = DEFAULT_TIMEOUT_MS } = options;

  // Normalize URL
  let normalizedUrl = url.trim();
  if (!normalizedUrl.startsWith('http://') && !normalizedUrl.startsWith('https://')) {
    normalizedUrl = `https://${normalizedUrl}`;
  }

  let page = null;
  let networkInterceptor = null;

  try {
    // Get a new page from the browser singleton
    page = await getPage({ timeout });

    // Set up network interception before navigation
    networkInterceptor = await setupNetworkInterception(page);

    // Navigate to the page
    try {
      await page.goto(normalizedUrl, {
        waitUntil: 'networkidle2',
        timeout: timeout,
      });
    } catch (error) {
      if (error.name === 'TimeoutError') {
        throw new ExtractionTimeoutError(normalizedUrl, timeout);
      }
      throw new PageLoadError(normalizedUrl, error);
    }

    // Check for authentication requirement
    if (await detectAuthRequired(page)) {
      throw new AuthenticationRequiredError(normalizedUrl);
    }

    // Wait for Redoc to be ready
    const redocReady = await waitForRedoc(page);

    let spec = null;
    let sourceUrl = normalizedUrl;

    // Strategy 1: Try global state variables
    if (redocReady) {
      spec = await extractSpecFromGlobalState(page);
    }

    // Strategy 2: Check network interception results
    if (!spec) {
      const networkResult = networkInterceptor.getSpec();
      if (networkResult) {
        spec = networkResult.spec;
        sourceUrl = networkResult.url;
      }
    }

    // Strategy 3: Try script/DOM extraction
    if (!spec) {
      const scriptResult = await extractSpecFromScripts(page);
      if (scriptResult) {
        if (scriptResult.spec) {
          spec = scriptResult.spec;
        } else if (scriptResult.specUrl) {
          spec = await fetchSpecFromUrl(scriptResult.specUrl, normalizedUrl);
          if (spec) {
            sourceUrl = new URL(scriptResult.specUrl, normalizedUrl).href;
          }
        }
      }
    }

    // Validate and return
    if (spec) {
      const specInfo = validateSpec(spec);
      if (specInfo) {
        return {
          spec,
          format: 'json',
          specInfo,
          sourceUrl,
        };
      }
    }

    // No valid spec found
    return null;
  } catch (error) {
    // Re-throw our custom errors
    if (
      error instanceof RedocExtractorError ||
      error instanceof BrowserError
    ) {
      throw error;
    }

    // Wrap unexpected errors
    throw new RedocExtractorError(`Extraction failed: ${error.message}`, error);
  } finally {
    // Cleanup
    if (networkInterceptor) {
      networkInterceptor.cleanup();
    }
    if (page && !page.isClosed()) {
      try {
        await page.close();
      } catch {
        // Ignore close errors
      }
    }
  }
}

/**
 * Convenience function to check if a URL appears to be a Redoc page
 *
 * @param {string} url - URL to check
 * @param {Object} options - Options passed to extractFromRedoc
 * @returns {Promise<boolean>} True if spec is extractable
 */
export async function hasRedoc(url, options = {}) {
  try {
    const result = await extractFromRedoc(url, options);
    return result !== null;
  } catch {
    return false;
  }
}

/**
 * Closes the browser instance. Call this when done extracting.
 * Safe to call even if browser is not running.
 *
 * @returns {Promise<void>}
 */
export { closeBrowser };
