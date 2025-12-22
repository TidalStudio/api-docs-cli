/**
 * APITracker.io discovery module for api-docs-cli
 * Searches APITracker to find API documentation URLs by provider name
 */

import { getPage, closeBrowser } from '../browser.js';

// ============================================================================
// Custom Error Classes
// ============================================================================

/**
 * Base error class for APITracker-related errors
 */
export class APITrackerError extends Error {
  constructor(message, cause = null) {
    super(message);
    this.name = 'APITrackerError';
    this.cause = cause;
  }
}

/**
 * Thrown when search fails
 */
export class APITrackerSearchError extends APITrackerError {
  constructor(query, message, cause = null) {
    super(`APITracker search failed for "${query}": ${message}`, cause);
    this.name = 'APITrackerSearchError';
    this.query = query;
  }
}

/**
 * Thrown when provider is not found on APITracker
 */
export class ProviderNotFoundError extends APITrackerError {
  constructor(query, cause = null) {
    super(`Provider "${query}" not found on APITracker`, cause);
    this.name = 'ProviderNotFoundError';
    this.query = query;
  }
}

/**
 * Thrown when no docs URL could be extracted
 */
export class DocsUrlNotFoundError extends APITrackerError {
  constructor(provider, cause = null) {
    super(`Could not find documentation URL for "${provider}"`, cause);
    this.name = 'DocsUrlNotFoundError';
    this.provider = provider;
  }
}

// ============================================================================
// Configuration
// ============================================================================

const APITRACKER_BASE_URL = 'https://apitracker.io';
const SEARCH_TIMEOUT = 30000;
const NAVIGATION_TIMEOUT = 30000;

// ============================================================================
// Public API
// ============================================================================

/**
 * Searches APITracker.io for a provider and returns the API documentation URL.
 *
 * @param {string} query - Provider name to search for (e.g., "n8n", "stripe")
 * @param {Object} options - Search options
 * @param {number} [options.timeout=30000] - Search timeout in ms
 * @returns {Promise<Object>} Result with provider info and docs URL
 * @throws {ProviderNotFoundError} If no matching provider found
 * @throws {DocsUrlNotFoundError} If provider found but no docs URL available
 * @throws {APITrackerSearchError} If search fails
 *
 * @example
 * const result = await searchProvider('n8n');
 * console.log(result.docsUrl);     // 'https://docs.n8n.io/api/api-reference/'
 * console.log(result.provider);    // 'n8n'
 * console.log(result.apiTrackerUrl); // 'https://apitracker.io/a/n8n'
 */
export async function searchProvider(query) {
  const normalizedQuery = query.trim().toLowerCase();
  let page = null;

  try {
    page = await getPage({ timeout: NAVIGATION_TIMEOUT });

    // First, try direct URL pattern /a/{provider}
    const directUrl = `${APITRACKER_BASE_URL}/a/${encodeURIComponent(normalizedQuery)}`;
    const response = await page.goto(directUrl, {
      waitUntil: 'networkidle2',
      timeout: SEARCH_TIMEOUT,
    });

    // Check if the direct URL worked (200 OK and on an API page)
    const currentUrl = page.url();
    if (response && response.ok() && currentUrl.includes('/a/')) {
      try {
        return await extractDocsFromApiPage(page, normalizedQuery);
      } catch (error) {
        // Direct page exists but couldn't extract docs, continue to search
        if (!(error instanceof DocsUrlNotFoundError)) {
          throw error;
        }
      }
    }

    // Fall back to search if direct URL didn't work
    const searchUrl = `${APITRACKER_BASE_URL}/search?q=${encodeURIComponent(normalizedQuery)}`;
    await page.goto(searchUrl, {
      waitUntil: 'networkidle2',
      timeout: SEARCH_TIMEOUT,
    });

    // Wait for search results to load
    await page.waitForSelector('body', { timeout: SEARCH_TIMEOUT });

    // Check if we're redirected to an API page
    const newUrl = page.url();
    if (newUrl.includes('/a/')) {
      return await extractDocsFromApiPage(page, normalizedQuery);
    }

    // Look for search results
    const searchResult = await findBestSearchResult(page, normalizedQuery);

    if (!searchResult) {
      throw new ProviderNotFoundError(query);
    }

    // Navigate to the API detail page
    await page.goto(searchResult.url, {
      waitUntil: 'networkidle2',
      timeout: NAVIGATION_TIMEOUT,
    });

    // Extract docs URL from the API page
    return await extractDocsFromApiPage(page, normalizedQuery);
  } catch (error) {
    if (
      error instanceof ProviderNotFoundError ||
      error instanceof DocsUrlNotFoundError
    ) {
      throw error;
    }
    throw new APITrackerSearchError(query, error.message, error);
  } finally {
    if (page && !page.isClosed()) {
      await page.close();
    }
  }
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Finds the best matching search result from the results page.
 *
 * @param {import('puppeteer').Page} page - Puppeteer page on search results
 * @param {string} query - Normalized search query
 * @returns {Promise<Object|null>} Best matching result or null
 */
async function findBestSearchResult(page, query) {
  // Wait a bit for dynamic content to load
  await new Promise((resolve) => setTimeout(resolve, 1000));

  // Extract search results - APITracker uses various link formats
  const results = await page.evaluate((searchQuery) => {
    const links = Array.from(document.querySelectorAll('a[href*="/a/"]'));
    const results = [];

    for (const link of links) {
      const href = link.getAttribute('href');
      const text = link.textContent?.trim().toLowerCase() || '';
      const parentText =
        link.closest('div, li, article')?.textContent?.trim().toLowerCase() ||
        '';

      // Extract provider slug from URL
      const match = href.match(/\/a\/([^/?#]+)/);
      if (match) {
        const slug = match[1].toLowerCase();

        // Score the result based on match quality
        let score = 0;
        if (slug === searchQuery) score = 100;
        else if (slug.startsWith(searchQuery)) score = 80;
        else if (slug.includes(searchQuery)) score = 60;
        else if (text.includes(searchQuery)) score = 40;
        else if (parentText.includes(searchQuery)) score = 20;

        if (score > 0) {
          results.push({
            url: href.startsWith('http')
              ? href
              : `https://apitracker.io${href}`,
            slug,
            text,
            score,
          });
        }
      }
    }

    // Sort by score descending
    results.sort((a, b) => b.score - a.score);
    return results;
  }, query);

  return results.length > 0 ? results[0] : null;
}

/**
 * Extracts the documentation URL from an APITracker API detail page.
 *
 * @param {import('puppeteer').Page} page - Puppeteer page on API detail page
 * @param {string} query - Original search query
 * @returns {Promise<Object>} Provider info with docs URL
 * @throws {DocsUrlNotFoundError} If no docs URL found
 */
async function extractDocsFromApiPage(page, query) {
  const currentUrl = page.url();

  // Extract provider slug from URL
  const slugMatch = currentUrl.match(/\/a\/([^/?#]+)/);
  const provider = slugMatch ? slugMatch[1] : query;

  // Wait for page content to load
  await new Promise((resolve) => setTimeout(resolve, 500));

  // Try to find documentation links on the page
  const docsUrl = await page.evaluate(() => {
    // APITracker uses "Developer Portal" as the primary docs link label
    // First look for explicit developer portal link
    const allLinks = Array.from(document.querySelectorAll('a[href]'));

    // Priority 1: Look for "Developer Portal" link (APITracker's primary docs link)
    for (const link of allLinks) {
      const text = link.textContent?.toLowerCase().trim() || '';
      const href = link.getAttribute('href');

      if (!href || href.includes('apitracker.io') || href.startsWith('#')) {
        continue;
      }

      if (text.includes('developer portal') || text === 'developer docs') {
        return href.startsWith('http') ? href : `https://${href}`;
      }
    }

    // Priority 2: Look for links with documentation keywords
    const keywords = [
      'api reference',
      'api docs',
      'documentation',
      'api documentation',
      'openapi',
      'swagger',
      'developer',
    ];

    for (const link of allLinks) {
      const text = link.textContent?.toLowerCase() || '';
      const href = link.getAttribute('href');

      if (!href || href.includes('apitracker.io') || href.startsWith('#')) {
        continue;
      }

      for (const keyword of keywords) {
        if (text.includes(keyword)) {
          return href.startsWith('http') ? href : `https://${href}`;
        }
      }
    }

    // Priority 3: Look for common docs URL patterns
    const patterns = [
      'a[href*="api-reference"]',
      'a[href*="api-docs"]',
      'a[href*="/docs"]',
      'a[href*="documentation"]',
      'a[href*="swagger"]',
      'a[href*="openapi"]',
      'a[href*="redoc"]',
    ];

    for (const selector of patterns) {
      const link = document.querySelector(selector);
      if (link) {
        const href = link.getAttribute('href');
        if (href && !href.includes('apitracker.io')) {
          return href.startsWith('http') ? href : `https://${href}`;
        }
      }
    }

    // Priority 4: Look for external links that might be documentation
    // First prefer links with 'api' in them, then fall back to 'docs'/'developer'
    let fallbackDocsUrl = null;
    for (const link of allLinks) {
      const href = link.getAttribute('href');
      if (
        href &&
        href.startsWith('http') &&
        !href.includes('apitracker.io') &&
        !href.includes('github.com') &&
        !href.includes('twitter.com') &&
        !href.includes('linkedin.com') &&
        !href.includes('facebook.com')
      ) {
        // Prefer URLs with 'api' in them
        if (href.includes('api')) {
          return href;
        }
        // Keep first docs/developer URL as fallback
        if (!fallbackDocsUrl && (href.includes('docs') || href.includes('developer'))) {
          fallbackDocsUrl = href;
        }
      }
    }

    return fallbackDocsUrl;
  });

  if (!docsUrl) {
    throw new DocsUrlNotFoundError(provider);
  }

  return {
    provider,
    docsUrl,
    apiTrackerUrl: currentUrl,
    source: 'apitracker',
  };
}

/**
 * Closes the browser instance (convenience function).
 * Useful for cleanup after multiple searches.
 *
 * @returns {Promise<void>}
 */
export async function cleanup() {
  await closeBrowser();
}
