/**
 * Browser management module for api-docs-cli
 * Handles Puppeteer browser lifecycle with singleton pattern
 */

import puppeteer from 'puppeteer';

// ============================================================================
// Custom Error Classes
// ============================================================================

/**
 * Base error class for browser-related errors
 */
export class BrowserError extends Error {
  constructor(message, cause = null) {
    super(message);
    this.name = 'BrowserError';
    this.cause = cause;
  }
}

/**
 * Thrown when Puppeteer browser executable is not found
 */
export class BrowserNotInstalledError extends BrowserError {
  constructor(cause = null) {
    super('Browser not found. Run `npx puppeteer browsers install chrome` to install.', cause);
    this.name = 'BrowserNotInstalledError';
  }
}

/**
 * Thrown when browser fails to launch
 */
export class BrowserLaunchError extends BrowserError {
  constructor(message, cause = null) {
    super(`Failed to launch browser: ${message}`, cause);
    this.name = 'BrowserLaunchError';
  }
}

// ============================================================================
// Default Configurations
// ============================================================================

const DEFAULT_LAUNCH_OPTIONS = {
  headless: true,
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  timeout: 30000,
};

const DEFAULT_PAGE_OPTIONS = {
  viewport: {
    width: 1280,
    height: 800,
  },
  timeout: 30000,
};

// ============================================================================
// Module State
// ============================================================================

let browserInstance = null;
const activePages = new Set();

// ============================================================================
// Public API
// ============================================================================

/**
 * Launches a headless Puppeteer browser instance.
 * Uses singleton pattern - returns existing instance if already launched.
 *
 * @param {Object} options - Launch options (merged with defaults)
 * @param {boolean} [options.headless=true] - Run in headless mode
 * @param {string[]} [options.args] - Additional Chrome arguments
 * @param {number} [options.timeout=30000] - Browser launch timeout in ms
 * @param {boolean} [options.force=false] - Force new instance even if one exists
 * @returns {Promise<import('puppeteer').Browser>} Puppeteer Browser instance
 * @throws {BrowserNotInstalledError} If browser executable not found
 * @throws {BrowserLaunchError} If browser fails to launch
 */
export async function launchBrowser(options = {}) {
  if (browserInstance && !options.force) {
    return browserInstance;
  }

  if (browserInstance && options.force) {
    await closeBrowser();
  }

  const launchOptions = {
    ...DEFAULT_LAUNCH_OPTIONS,
    ...options,
    args: [...DEFAULT_LAUNCH_OPTIONS.args, ...(options.args || [])],
  };

  try {
    browserInstance = await puppeteer.launch(launchOptions);

    browserInstance.on('disconnected', () => {
      browserInstance = null;
      activePages.clear();
    });

    return browserInstance;
  } catch (error) {
    if (
      error.message?.includes('Could not find browser') ||
      error.message?.includes('Failed to launch') ||
      error.message?.includes('ENOENT')
    ) {
      throw new BrowserNotInstalledError(error);
    }
    throw new BrowserLaunchError(error.message, error);
  }
}

/**
 * Creates a new page with sensible defaults for API doc extraction.
 * Automatically launches browser if not already running.
 *
 * @param {Object} options - Page configuration options
 * @param {Object} [options.viewport] - Viewport dimensions
 * @param {number} [options.viewport.width=1280] - Viewport width
 * @param {number} [options.viewport.height=800] - Viewport height
 * @param {number} [options.timeout=30000] - Default timeout for operations
 * @param {boolean} [options.track=true] - Track page for cleanup
 * @returns {Promise<import('puppeteer').Page>} Configured Puppeteer Page instance
 * @throws {BrowserError} If page creation fails
 */
export async function getPage(options = {}) {
  const browser = await launchBrowser();
  const page = await browser.newPage();

  const viewport = {
    ...DEFAULT_PAGE_OPTIONS.viewport,
    ...options.viewport,
  };
  await page.setViewport(viewport);

  const timeout = options.timeout ?? DEFAULT_PAGE_OPTIONS.timeout;
  page.setDefaultTimeout(timeout);
  page.setDefaultNavigationTimeout(timeout);

  if (options.track !== false) {
    activePages.add(page);
    page.once('close', () => {
      activePages.delete(page);
    });
  }

  return page;
}

/**
 * Closes browser and all tracked pages.
 * Safe to call even if browser is not running.
 *
 * @returns {Promise<void>}
 */
export async function closeBrowser() {
  const closePromises = Array.from(activePages).map(async (page) => {
    try {
      if (!page.isClosed()) {
        await page.close();
      }
    } catch {
      // Ignore errors - browser might already be closed
    }
  });

  await Promise.all(closePromises);
  activePages.clear();

  if (browserInstance) {
    try {
      await browserInstance.close();
    } catch {
      // Ignore errors - browser might already be closed
    } finally {
      browserInstance = null;
    }
  }
}

/**
 * Removes a page from tracking without closing it.
 * Useful when caller wants to manage page lifecycle manually.
 *
 * @param {import('puppeteer').Page} page - Page to release from tracking
 */
export function releasePage(page) {
  activePages.delete(page);
}

/**
 * Gets the current browser instance (if any).
 * Useful for advanced operations not covered by this module.
 *
 * @returns {import('puppeteer').Browser|null} Current browser instance or null
 */
export function getBrowserInstance() {
  return browserInstance;
}

// ============================================================================
// Process Exit Handlers
// ============================================================================

const cleanup = async () => {
  await closeBrowser();
};

process.on('SIGINT', async () => {
  await cleanup();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  await cleanup();
  process.exit(0);
});

process.on('uncaughtException', async (error) => {
  console.error('Uncaught exception:', error);
  await cleanup();
  process.exit(1);
});
