/**
 * Swagger UI page extractor module
 * Uses Puppeteer to extract OpenAPI specs from JavaScript-rendered Swagger UI pages
 */

import { getPage, closeBrowser, BrowserError } from '../browser.js';

// ============================================================================
// Custom Error Classes
// ============================================================================

/**
 * Base error class for Swagger UI extractor errors
 */
export class SwaggerUIExtractorError extends Error {
  constructor(message, cause = null) {
    super(message);
    this.name = 'SwaggerUIExtractorError';
    this.cause = cause;
  }
}

/**
 * Thrown when page fails to load
 */
export class PageLoadError extends SwaggerUIExtractorError {
  constructor(url, cause = null) {
    super(`Failed to load page: ${url}`, cause);
    this.name = 'PageLoadError';
    this.url = url;
  }
}

/**
 * Thrown when no spec can be found on the page
 */
export class SpecNotFoundError extends SwaggerUIExtractorError {
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
export class ExtractionTimeoutError extends SwaggerUIExtractorError {
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
export class AuthenticationRequiredError extends SwaggerUIExtractorError {
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
const SWAGGER_UI_READY_TIMEOUT_MS = 15000;
const NETWORK_IDLE_TIMEOUT_MS = 5000;

// Patterns that indicate spec-related network requests
const SPEC_URL_PATTERNS = [
  /openapi\.json/i,
  /openapi\.yaml/i,
  /swagger\.json/i,
  /swagger\.yaml/i,
  /api-docs/i,
  /\/v2\/api-docs/i,
  /\/v3\/api-docs/i,
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
 * Waits for Swagger UI to be ready on the page
 *
 * @param {import('puppeteer').Page} page - Puppeteer page
 * @param {number} timeout - Timeout in ms
 * @returns {Promise<boolean>} True if Swagger UI is detected and ready
 */
async function waitForSwaggerUI(page, timeout = SWAGGER_UI_READY_TIMEOUT_MS) {
  try {
    await page.waitForFunction(
      () => {
        // Check for Swagger UI presence via multiple indicators
        const hasSwaggerUI =
          typeof window.ui !== 'undefined' ||
          document.querySelector('.swagger-ui') !== null ||
          document.querySelector('#swagger-ui') !== null;
        return hasSwaggerUI;
      },
      { timeout }
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Attempts to extract spec from window.ui APIs
 *
 * @param {import('puppeteer').Page} page - Puppeteer page
 * @returns {Promise<Object|null>} Extracted spec or null
 */
async function extractSpecFromWindowUI(page) {
  try {
    const spec = await page.evaluate(() => {
      if (typeof window.ui === 'undefined') {
        return null;
      }

      // Strategy 1: Try specSelectors.specJson() - most reliable for loaded specs
      // This accesses the Redux state where the spec is stored after loading
      if (window.ui.specSelectors && typeof window.ui.specSelectors.specJson === 'function') {
        const specJson = window.ui.specSelectors.specJson();
        if (specJson) {
          // Handle Immutable.js objects (used by Swagger UI's Redux store)
          if (typeof specJson.toJS === 'function') {
            const jsSpec = specJson.toJS();
            // Check if the spec has content (not empty)
            if (jsSpec && (jsSpec.openapi || jsSpec.swagger)) {
              return jsSpec;
            }
          }
          // Handle plain objects
          if (typeof specJson === 'object' && (specJson.openapi || specJson.swagger)) {
            return specJson;
          }
        }
      }

      // Strategy 2: Try getConfigs().spec - for inline specs
      if (typeof window.ui.getConfigs === 'function') {
        const configs = window.ui.getConfigs();
        if (configs && configs.spec) {
          // Check if spec has content (not empty placeholder)
          if (configs.spec.openapi || configs.spec.swagger) {
            return configs.spec;
          }
        }
      }

      // Strategy 3: Try getState() directly
      if (typeof window.ui.getState === 'function') {
        const state = window.ui.getState();
        if (state && state.spec && state.spec.json) {
          const specJson = state.spec.json;
          if (typeof specJson.toJS === 'function') {
            return specJson.toJS();
          }
          if (typeof specJson === 'object') {
            return specJson;
          }
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
 * Attempts to extract spec from inline script tags
 *
 * @param {import('puppeteer').Page} page - Puppeteer page
 * @returns {Promise<Object|null>} Extracted spec or null
 */
async function extractSpecFromScripts(page) {
  try {
    const spec = await page.evaluate(() => {
      const scripts = document.querySelectorAll('script');
      for (const script of scripts) {
        const content = script.textContent || '';

        // Look for SwaggerUIBundle or SwaggerUI initialization with spec
        const specMatch = content.match(/spec\s*:\s*(\{[\s\S]*?\})\s*[,}]/);
        if (specMatch) {
          try {
            // This is risky but necessary for inline specs
            // eslint-disable-next-line no-eval
            return eval('(' + specMatch[1] + ')');
          } catch {
            // Continue to next match
          }
        }

        // Look for window.spec assignment
        const windowSpecMatch = content.match(/window\.spec\s*=\s*(\{[\s\S]*?\});/);
        if (windowSpecMatch) {
          try {
            // eslint-disable-next-line no-eval
            return eval('(' + windowSpecMatch[1] + ')');
          } catch {
            // Continue
          }
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

      // Try to parse as JSON
      try {
        const parsed = JSON.parse(text);
        if (validateSpec(parsed)) {
          capturedSpec = parsed;
          capturedUrl = url;
        }
      } catch {
        // Not JSON, could be YAML - skip for now
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
      const pageText = document.body?.innerText?.toLowerCase() || '';
      const hasLoginForm =
        document.querySelector('input[type="password"]') !== null ||
        document.querySelector('form[action*="login"]') !== null;
      const hasAuthText =
        pageText.includes('log in') ||
        pageText.includes('sign in') ||
        pageText.includes('authentication required') ||
        pageText.includes('unauthorized');

      return hasLoginForm || hasAuthText;
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
 * Extracts OpenAPI specification from a Swagger UI page using Puppeteer.
 *
 * Tries multiple extraction strategies in order:
 * 1. window.ui.getConfigs().spec - Most common Swagger UI API
 * 2. Network interception - Captures spec fetch requests
 * 3. DOM inspection - Looks for inline specs in script tags
 *
 * @param {string} url - URL of the Swagger UI page
 * @param {Object} options - Extraction options
 * @param {number} [options.timeout=30000] - Overall timeout in ms
 * @returns {Promise<Object|null>} Extracted spec result or null if not found
 * @returns {Object} result.spec - The parsed OpenAPI/Swagger specification
 * @returns {string} result.format - Always 'json' for Swagger UI extraction
 * @returns {Object} result.specInfo - Spec metadata (type, version, title)
 * @returns {string} result.sourceUrl - URL the spec was extracted from
 *
 * @throws {PageLoadError} If page fails to load
 * @throws {AuthenticationRequiredError} If authentication is needed
 * @throws {ExtractionTimeoutError} If extraction times out
 * @throws {BrowserError} If browser fails to launch
 *
 * @example
 * const result = await extractFromSwaggerUI('https://petstore.swagger.io/');
 * console.log(result.specInfo.title); // "Swagger Petstore"
 */
export async function extractFromSwaggerUI(url, options = {}) {
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

    // Wait for Swagger UI to be ready
    const swaggerUIReady = await waitForSwaggerUI(page);

    let spec = null;
    let sourceUrl = normalizedUrl;

    // Strategy 1: Try window.ui API
    if (swaggerUIReady) {
      spec = await extractSpecFromWindowUI(page);
    }

    // Strategy 2: Check network interception results
    if (!spec) {
      const networkResult = networkInterceptor.getSpec();
      if (networkResult) {
        spec = networkResult.spec;
        sourceUrl = networkResult.url;
      }
    }

    // Strategy 3: Try inline script extraction
    if (!spec) {
      spec = await extractSpecFromScripts(page);
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
      error instanceof SwaggerUIExtractorError ||
      error instanceof BrowserError
    ) {
      throw error;
    }

    // Wrap unexpected errors
    throw new SwaggerUIExtractorError(`Extraction failed: ${error.message}`, error);
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
 * Convenience function to check if a URL appears to be a Swagger UI page
 *
 * @param {string} url - URL to check
 * @param {Object} options - Options passed to extractFromSwaggerUI
 * @returns {Promise<boolean>} True if spec is extractable
 */
export async function hasSwaggerUI(url, options = {}) {
  try {
    const result = await extractFromSwaggerUI(url, options);
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
