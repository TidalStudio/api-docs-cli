/**
 * DOM Scraper module for api-docs-cli
 * Extracts API endpoints from rendered documentation pages
 * Supports Scalar, Redoc, Swagger UI, and generic docs
 */

import { getPage } from '../browser.js';

// ============================================================================
// Custom Error Classes
// ============================================================================

/**
 * Base error class for docs scraper errors
 */
export class DocsScraperError extends Error {
  constructor(message, cause = null) {
    super(message);
    this.name = 'DocsScraperError';
    this.cause = cause;
  }
}

/**
 * Thrown when docs framework cannot be detected
 */
export class FrameworkNotDetectedError extends DocsScraperError {
  constructor(url, cause = null) {
    super(`Could not detect documentation framework at ${url}`, cause);
    this.name = 'FrameworkNotDetectedError';
    this.url = url;
  }
}

/**
 * Thrown when endpoint extraction fails
 */
export class ExtractionError extends DocsScraperError {
  constructor(url, framework, message, cause = null) {
    super(`Failed to extract endpoints from ${framework} at ${url}: ${message}`, cause);
    this.name = 'ExtractionError';
    this.url = url;
    this.framework = framework;
  }
}

/**
 * Thrown when page load fails
 */
export class PageLoadError extends DocsScraperError {
  constructor(url, message, cause = null) {
    super(`Failed to load page ${url}: ${message}`, cause);
    this.name = 'PageLoadError';
    this.url = url;
  }
}

// ============================================================================
// Configuration
// ============================================================================

const SUPPORTED_FRAMEWORKS = ['swagger-ui', 'redoc', 'scalar', 'generic'];
const PAGE_LOAD_TIMEOUT = 30000;
const EXTRACTION_TIMEOUT = 30000;

// ============================================================================
// Public API
// ============================================================================

/**
 * Extracts API endpoints from a documentation page.
 *
 * @param {string} url - Documentation page URL
 * @param {Object} options - Extraction options
 * @param {number} [options.timeout=30000] - Page load timeout in ms
 * @param {string} [options.framework] - Force specific framework detection
 * @returns {Promise<Object>} Extraction result with framework and endpoints
 * @throws {PageLoadError} If page fails to load
 * @throws {FrameworkNotDetectedError} If no supported framework detected
 * @throws {ExtractionError} If extraction fails
 *
 * @example
 * const result = await scrapeEndpoints('https://docs.n8n.io/api/api-reference/');
 * console.log(result.framework);   // 'scalar'
 * console.log(result.endpoints);   // [{ method: 'GET', path: '/users', description: '...' }, ...]
 */
export async function scrapeEndpoints(url, options = {}) {
  const { timeout = PAGE_LOAD_TIMEOUT, framework: forcedFramework } = options;
  let page = null;

  try {
    page = await getPage({ timeout });

    // Navigate to the docs page
    await page.goto(url, {
      waitUntil: 'networkidle2',
      timeout,
    });

    // Wait for dynamic content
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // Detect framework
    const framework = forcedFramework || await detectFramework(page);

    if (!framework) {
      throw new FrameworkNotDetectedError(url);
    }

    // Extract endpoints based on framework
    const endpoints = await extractEndpoints(page, framework, url);

    // Extract API info if available
    const apiInfo = await extractApiInfo(page, framework);

    return {
      url,
      framework,
      apiInfo,
      endpoints,
      extractedAt: new Date().toISOString(),
    };
  } catch (error) {
    if (
      error instanceof FrameworkNotDetectedError ||
      error instanceof ExtractionError
    ) {
      throw error;
    }
    if (error.name === 'TimeoutError') {
      throw new PageLoadError(url, 'Timeout while loading page', error);
    }
    throw new PageLoadError(url, error.message, error);
  } finally {
    if (page && !page.isClosed()) {
      await page.close();
    }
  }
}

/**
 * Detects the documentation framework used on the page.
 *
 * @param {string} url - Documentation page URL
 * @returns {Promise<string|null>} Framework name or null if not detected
 */
export async function detectFrameworkFromUrl(url) {
  let page = null;

  try {
    page = await getPage({ timeout: PAGE_LOAD_TIMEOUT });
    await page.goto(url, { waitUntil: 'networkidle2', timeout: PAGE_LOAD_TIMEOUT });
    await new Promise((resolve) => setTimeout(resolve, 1000));
    return await detectFramework(page);
  } finally {
    if (page && !page.isClosed()) {
      await page.close();
    }
  }
}

// ============================================================================
// Framework Detection
// ============================================================================

/**
 * Detects which documentation framework is used on the page.
 *
 * @param {import('puppeteer').Page} page - Puppeteer page instance
 * @returns {Promise<string|null>} Framework name or null
 */
async function detectFramework(page) {
  return await page.evaluate(() => {
    // Check for Swagger UI
    if (
      document.querySelector('.swagger-ui') ||
      document.querySelector('#swagger-ui') ||
      window.ui ||
      window.SwaggerUIBundle
    ) {
      return 'swagger-ui';
    }

    // Check for Redoc
    if (
      document.querySelector('.redoc-wrap') ||
      document.querySelector('redoc') ||
      window.__redoc_state ||
      window.__REDOC_STORE__ ||
      document.querySelector('[data-role="redoc"]')
    ) {
      return 'redoc';
    }

    // Check for Scalar
    if (
      document.querySelector('.scalar-app') ||
      document.querySelector('[data-scalar]') ||
      document.querySelector('.scalar-api-reference') ||
      document.querySelector('#scalar') ||
      window.ScalarApiReference
    ) {
      return 'scalar';
    }

    // Check for common API doc patterns (generic)
    const hasHttpMethods = document.body.innerHTML.match(/\b(GET|POST|PUT|DELETE|PATCH)\b/gi);
    const hasApiPaths = document.body.innerHTML.match(/\/[a-z]+\/\{[^}]+\}/gi) ||
                        document.body.innerHTML.match(/\/api\/[a-z]+/gi);

    if (hasHttpMethods && hasApiPaths) {
      return 'generic';
    }

    return null;
  });
}

// ============================================================================
// Endpoint Extraction
// ============================================================================

/**
 * Extracts endpoints from the page based on detected framework.
 *
 * @param {import('puppeteer').Page} page - Puppeteer page instance
 * @param {string} framework - Detected framework name
 * @param {string} url - Page URL (for error messages)
 * @returns {Promise<Array<Object>>} Array of endpoint objects
 */
async function extractEndpoints(page, framework, url) {
  try {
    switch (framework) {
      case 'swagger-ui':
        return await extractSwaggerUiEndpoints(page);
      case 'redoc':
        return await extractRedocEndpoints(page);
      case 'scalar':
        return await extractScalarEndpoints(page);
      case 'generic':
        return await extractGenericEndpoints(page);
      default:
        throw new Error(`Unknown framework: ${framework}`);
    }
  } catch (error) {
    throw new ExtractionError(url, framework, error.message, error);
  }
}

/**
 * Extracts endpoints from Swagger UI.
 */
async function extractSwaggerUiEndpoints(page) {
  // First try to get spec from window.ui
  const specEndpoints = await page.evaluate(() => {
    if (window.ui && window.ui.specSelectors) {
      try {
        const spec = window.ui.specSelectors.specJson().toJS();
        if (spec && spec.paths) {
          const endpoints = [];
          for (const [path, methods] of Object.entries(spec.paths)) {
            for (const [method, details] of Object.entries(methods)) {
              if (['get', 'post', 'put', 'delete', 'patch', 'options', 'head'].includes(method.toLowerCase())) {
                endpoints.push({
                  method: method.toUpperCase(),
                  path,
                  description: details.summary || details.description || '',
                  tags: details.tags || [],
                  operationId: details.operationId || null,
                });
              }
            }
          }
          return endpoints;
        }
      } catch (e) {
        // Fall through to DOM extraction
      }
    }
    return null;
  });

  if (specEndpoints && specEndpoints.length > 0) {
    return specEndpoints;
  }

  // Fall back to DOM extraction
  return await page.evaluate(() => {
    const endpoints = [];
    const operations = document.querySelectorAll('.opblock');

    for (const op of operations) {
      const methodEl = op.querySelector('.opblock-summary-method');
      const pathEl = op.querySelector('.opblock-summary-path, .opblock-summary-path__deprecated');
      const descEl = op.querySelector('.opblock-summary-description');

      if (methodEl && pathEl) {
        endpoints.push({
          method: methodEl.textContent?.trim().toUpperCase() || 'UNKNOWN',
          path: pathEl.textContent?.trim() || '',
          description: descEl?.textContent?.trim() || '',
          tags: [],
          operationId: null,
        });
      }
    }

    return endpoints;
  });
}

/**
 * Extracts endpoints from Redoc.
 */
async function extractRedocEndpoints(page) {
  // First try to get from Redoc state
  const stateEndpoints = await page.evaluate(() => {
    const state = window.__redoc_state || window.__REDOC_STORE__;
    if (state && state.spec && state.spec.data && state.spec.data.paths) {
      const endpoints = [];
      for (const [path, methods] of Object.entries(state.spec.data.paths)) {
        for (const [method, details] of Object.entries(methods)) {
          if (['get', 'post', 'put', 'delete', 'patch', 'options', 'head'].includes(method.toLowerCase())) {
            endpoints.push({
              method: method.toUpperCase(),
              path,
              description: details.summary || details.description || '',
              tags: details.tags || [],
              operationId: details.operationId || null,
            });
          }
        }
      }
      return endpoints;
    }
    return null;
  });

  if (stateEndpoints && stateEndpoints.length > 0) {
    return stateEndpoints;
  }

  // Fall back to DOM extraction
  return await page.evaluate(() => {
    const endpoints = [];

    // Redoc uses various selectors for operations
    const operations = document.querySelectorAll('[data-section-id*="operation"], .operation');

    for (const op of operations) {
      // Look for HTTP method badge
      const methodEl = op.querySelector('.http-verb, [class*="http-verb"], [class*="method"]');
      // Look for path
      const pathEl = op.querySelector('.operation-path, [class*="path"], code');
      // Look for description
      const descEl = op.querySelector('.operation-summary, [class*="summary"], p');

      if (methodEl || pathEl) {
        const method = methodEl?.textContent?.trim().toUpperCase() || 'UNKNOWN';
        const path = pathEl?.textContent?.trim() || '';

        if (path && path.startsWith('/')) {
          endpoints.push({
            method,
            path,
            description: descEl?.textContent?.trim() || '',
            tags: [],
            operationId: null,
          });
        }
      }
    }

    // Also try menu-based extraction
    if (endpoints.length === 0) {
      const menuItems = document.querySelectorAll('[class*="menu-content"] a, .api-content a');
      for (const item of menuItems) {
        const text = item.textContent || '';
        const methodMatch = text.match(/^(GET|POST|PUT|DELETE|PATCH|OPTIONS|HEAD)\s+(.+)/i);
        if (methodMatch) {
          endpoints.push({
            method: methodMatch[1].toUpperCase(),
            path: methodMatch[2].trim(),
            description: '',
            tags: [],
            operationId: null,
          });
        }
      }
    }

    return endpoints;
  });
}

/**
 * Extracts endpoints from Scalar.
 */
async function extractScalarEndpoints(page) {
  // First, try to intercept the OpenAPI spec that Scalar loads
  // Check for spec in various Scalar storage locations
  const specEndpoints = await page.evaluate(() => {
    // Try to find spec in Scalar's configuration or state
    const scalarEl = document.querySelector('[data-spec-url], [data-configuration], .scalar-api-reference');

    // Check for spec URL in data attribute
    const specUrl = scalarEl?.getAttribute('data-spec-url') ||
                    scalarEl?.getAttribute('data-url') ||
                    document.querySelector('script[data-spec]')?.getAttribute('data-spec');

    // Look for inline spec in script tags
    const scripts = document.querySelectorAll('script');
    for (const script of scripts) {
      const content = script.textContent || '';
      // Look for OpenAPI spec patterns
      if (content.includes('"openapi"') || content.includes('"swagger"')) {
        try {
          // Try to extract JSON spec
          const specMatch = content.match(/\{[\s\S]*"(openapi|swagger)"[\s\S]*"paths"[\s\S]*\}/);
          if (specMatch) {
            const spec = JSON.parse(specMatch[0]);
            if (spec.paths) {
              const endpoints = [];
              for (const [path, methods] of Object.entries(spec.paths)) {
                for (const [method, details] of Object.entries(methods)) {
                  if (['get', 'post', 'put', 'delete', 'patch', 'options', 'head'].includes(method.toLowerCase())) {
                    endpoints.push({
                      method: method.toUpperCase(),
                      path,
                      description: details.summary || details.description || '',
                      tags: details.tags || [],
                      operationId: details.operationId || null,
                    });
                  }
                }
              }
              return { endpoints, specUrl: null };
            }
          }
        } catch (e) {
          // Continue searching
        }
      }
    }

    return { endpoints: null, specUrl };
  });

  if (specEndpoints.endpoints && specEndpoints.endpoints.length > 0) {
    return specEndpoints.endpoints;
  }

  // If we found a spec URL, try to fetch it
  if (specEndpoints.specUrl) {
    try {
      const specResponse = await page.evaluate(async (url) => {
        const resp = await fetch(url);
        return await resp.json();
      }, specEndpoints.specUrl);

      if (specResponse && specResponse.paths) {
        const endpoints = [];
        for (const [path, methods] of Object.entries(specResponse.paths)) {
          for (const [method, details] of Object.entries(methods)) {
            if (['get', 'post', 'put', 'delete', 'patch', 'options', 'head'].includes(method.toLowerCase())) {
              endpoints.push({
                method: method.toUpperCase(),
                path,
                description: details.summary || details.description || '',
                tags: details.tags || [],
                operationId: details.operationId || null,
              });
            }
          }
        }
        if (endpoints.length > 0) {
          return endpoints;
        }
      }
    } catch (e) {
      // Fall through to DOM extraction
    }
  }

  // Fall back to DOM extraction
  return await page.evaluate(() => {
    const endpoints = [];
    const seen = new Set();

    // Scalar uses specific classes for operations
    const operations = document.querySelectorAll(
      '.scalar-card, [class*="operation"], [class*="endpoint"], .request-block, [class*="HttpOperation"]'
    );

    for (const op of operations) {
      // Look for method badge
      const methodEl = op.querySelector(
        '[class*="method"], [class*="http-method"], .badge, [class*="request-method"], [class*="HttpMethod"]'
      );
      // Look for path
      const pathEl = op.querySelector(
        '[class*="path"], [class*="url"], code, [class*="endpoint-path"], [class*="OperationPath"]'
      );
      // Look for description - try multiple selectors
      const descEl = op.querySelector(
        '[class*="description"], [class*="summary"], [class*="Description"], p:not([class*="path"])'
      );

      const method = methodEl?.textContent?.trim().toUpperCase();
      const path = pathEl?.textContent?.trim();

      if (method && path && ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS', 'HEAD'].includes(method)) {
        const key = `${method}:${path}`;
        if (!seen.has(key)) {
          seen.add(key);
          endpoints.push({
            method,
            path,
            description: descEl?.textContent?.trim() || '',
            tags: [],
            operationId: null,
          });
        }
      }
    }

    // Try sidebar/navigation extraction if no operations found
    if (endpoints.length === 0) {
      const navItems = document.querySelectorAll(
        '.sidebar a, nav a, [class*="sidebar"] a, [class*="navigation"] a'
      );

      for (const item of navItems) {
        const text = item.textContent || '';
        // Match patterns like "GET /users" or "POST /api/items"
        const methodMatch = text.match(/^(GET|POST|PUT|DELETE|PATCH)\s+(\/.+)/i);
        if (methodMatch) {
          const key = `${methodMatch[1].toUpperCase()}:${methodMatch[2].trim()}`;
          if (!seen.has(key)) {
            seen.add(key);
            endpoints.push({
              method: methodMatch[1].toUpperCase(),
              path: methodMatch[2].trim(),
              description: '',
              tags: [],
              operationId: null,
            });
          }
        }
      }
    }

    // Last resort: scan entire page for HTTP method + path patterns
    if (endpoints.length === 0) {
      const bodyText = document.body.innerText;
      const matches = bodyText.matchAll(/(GET|POST|PUT|DELETE|PATCH)\s+(\/[^\s\n]+)/gi);

      for (const match of matches) {
        const key = `${match[1].toUpperCase()}:${match[2]}`;
        if (!seen.has(key)) {
          seen.add(key);
          endpoints.push({
            method: match[1].toUpperCase(),
            path: match[2],
            description: '',
            tags: [],
            operationId: null,
          });
        }
      }
    }

    return endpoints;
  });
}

/**
 * Extracts endpoints from generic/unknown documentation.
 */
async function extractGenericEndpoints(page) {
  return await page.evaluate(() => {
    const endpoints = [];
    const seen = new Set();

    // Strategy 1: Look for code blocks or preformatted text with endpoints
    const codeBlocks = document.querySelectorAll('pre, code, .highlight');
    for (const block of codeBlocks) {
      const text = block.textContent || '';
      const matches = text.matchAll(/(GET|POST|PUT|DELETE|PATCH|OPTIONS|HEAD)\s+(\/[^\s\n'"]+)/gi);
      for (const match of matches) {
        const key = `${match[1].toUpperCase()}:${match[2]}`;
        if (!seen.has(key)) {
          seen.add(key);
          endpoints.push({
            method: match[1].toUpperCase(),
            path: match[2].replace(/['"]+$/, ''), // Remove trailing quotes
            description: '',
            tags: [],
            operationId: null,
          });
        }
      }
    }

    // Strategy 2: Look for tables with method/path columns
    const tables = document.querySelectorAll('table');
    for (const table of tables) {
      const rows = table.querySelectorAll('tr');
      for (const row of rows) {
        const cells = row.querySelectorAll('td, th');
        const cellTexts = Array.from(cells).map(c => c.textContent?.trim() || '');

        // Look for method in first few cells
        for (let i = 0; i < Math.min(cellTexts.length, 3); i++) {
          const methodMatch = cellTexts[i].match(/^(GET|POST|PUT|DELETE|PATCH)$/i);
          if (methodMatch) {
            // Look for path in subsequent cells
            for (let j = i + 1; j < cellTexts.length; j++) {
              if (cellTexts[j].startsWith('/')) {
                const key = `${methodMatch[1].toUpperCase()}:${cellTexts[j]}`;
                if (!seen.has(key)) {
                  seen.add(key);
                  endpoints.push({
                    method: methodMatch[1].toUpperCase(),
                    path: cellTexts[j],
                    description: cellTexts[j + 1] || '',
                    tags: [],
                    operationId: null,
                  });
                }
                break;
              }
            }
          }
        }
      }
    }

    // Strategy 3: Scan body text for patterns
    if (endpoints.length === 0) {
      const bodyText = document.body.innerText;
      const matches = bodyText.matchAll(/(GET|POST|PUT|DELETE|PATCH)\s+(\/[a-zA-Z0-9_\-/{}\[\]]+)/gi);

      for (const match of matches) {
        const key = `${match[1].toUpperCase()}:${match[2]}`;
        if (!seen.has(key)) {
          seen.add(key);
          endpoints.push({
            method: match[1].toUpperCase(),
            path: match[2],
            description: '',
            tags: [],
            operationId: null,
          });
        }
      }
    }

    return endpoints;
  });
}

// ============================================================================
// API Info Extraction
// ============================================================================

/**
 * Extracts API metadata from the page.
 *
 * @param {import('puppeteer').Page} page - Puppeteer page instance
 * @param {string} framework - Detected framework name
 * @returns {Promise<Object>} API info object
 */
async function extractApiInfo(page, framework) {
  return await page.evaluate((fw) => {
    let title = document.title || 'Unknown API';
    let version = null;
    let description = null;

    // Try framework-specific extraction
    if (fw === 'swagger-ui' && window.ui && window.ui.specSelectors) {
      try {
        const spec = window.ui.specSelectors.specJson().toJS();
        if (spec && spec.info) {
          title = spec.info.title || title;
          version = spec.info.version || null;
          description = spec.info.description || null;
        }
      } catch (e) {
        // Fall through
      }
    }

    if (fw === 'redoc') {
      const state = window.__redoc_state || window.__REDOC_STORE__;
      if (state && state.spec && state.spec.data && state.spec.data.info) {
        title = state.spec.data.info.title || title;
        version = state.spec.data.info.version || null;
        description = state.spec.data.info.description || null;
      }
    }

    // Generic extraction from meta tags or headings
    if (!version) {
      const versionEl = document.querySelector('[class*="version"], .api-version');
      version = versionEl?.textContent?.trim() || null;
    }

    if (!description) {
      const metaDesc = document.querySelector('meta[name="description"]');
      description = metaDesc?.getAttribute('content') || null;
    }

    // Clean up title
    title = title.replace(/\s*[-|]\s*API\s*(Reference|Documentation|Docs)?$/i, '').trim();

    return {
      title,
      version,
      description,
    };
  }, framework);
}
