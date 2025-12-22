#!/usr/bin/env node
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import chalk from 'chalk';
import {
  lookupProvider,
  ProviderNotFoundError,
  DiscoveryFetchError,
} from '../src/discovery.js';
import {
  fetchOpenAPISpec,
  OpenAPIExtractorError,
} from '../src/extractors/openapi.js';
import {
  extractFromSwaggerUI,
  SwaggerUIExtractorError,
} from '../src/extractors/swagger-ui.js';
import {
  scrapeEndpoints,
  DocsScraperError,
} from '../src/extractors/docs-scraper.js';
import { closeBrowser, getPage } from '../src/browser.js';
import {
  setCache,
  getCached,
  listCache,
  clearCache,
  CacheNotFoundError,
  CacheExpiredError,
} from '../src/cache.js';
import { formatEndpointList, formatScrapedEndpoints } from '../src/formatter.js';

/**
 * Checks if a URL looks like an OpenAPI spec file.
 *
 * @param {string} url - URL to check
 * @returns {boolean} True if URL appears to be an OpenAPI spec
 */
function isSpecUrl(url) {
  const lower = url.toLowerCase();
  return (
    lower.endsWith('.json') ||
    lower.endsWith('.yaml') ||
    lower.endsWith('.yml') ||
    lower.includes('openapi') ||
    lower.includes('swagger')
  );
}

/**
 * Common paths where API reference docs are often found.
 */
const API_REFERENCE_PATHS = [
  '/api/api-reference',
  '/api/api-reference/',
  '/api-reference',
  '/api-reference/',
  '/api/reference',
  '/api/reference/',
  '/reference/api',
  '/reference/api/',
  '/api/docs',
  '/api/docs/',
  '/api',
  '/api/',
  '/docs/api',
  '/docs/api/',
];

/**
 * Finds the API reference URL from a base docs URL.
 * Navigates to the page and looks for API reference links.
 *
 * @param {string} baseUrl - Base documentation URL
 * @param {import('puppeteer').Page} page - Puppeteer page to use
 * @returns {Promise<string|null>} API reference URL or null
 */
async function findApiReferenceUrl(baseUrl, page) {
  try {
    await page.goto(baseUrl, { waitUntil: 'networkidle2', timeout: 30000 });
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // Look for API reference links on the page
    const apiRefUrl = await page.evaluate((base) => {
      const links = Array.from(document.querySelectorAll('a[href]'));

      // Priority 1: Links with "API Reference" or similar text
      const apiRefKeywords = ['api reference', 'api-reference', 'api docs', 'rest api', 'api documentation'];
      for (const link of links) {
        const text = link.textContent?.toLowerCase().trim() || '';
        const href = link.getAttribute('href');
        if (!href || href.startsWith('#')) continue;

        for (const keyword of apiRefKeywords) {
          if (text.includes(keyword)) {
            // Make absolute URL
            if (href.startsWith('http')) return href;
            if (href.startsWith('/')) {
              const url = new URL(base);
              return `${url.origin}${href}`;
            }
            return new URL(href, base).toString();
          }
        }
      }

      // Priority 2: Links with href containing api-reference or similar
      for (const link of links) {
        const href = link.getAttribute('href');
        if (!href || href.startsWith('#')) continue;

        const lowerHref = href.toLowerCase();
        if (
          lowerHref.includes('api-reference') ||
          lowerHref.includes('api/reference') ||
          (lowerHref.includes('/api') && !lowerHref.includes('apitracker'))
        ) {
          if (href.startsWith('http')) return href;
          if (href.startsWith('/')) {
            const url = new URL(base);
            return `${url.origin}${href}`;
          }
          return new URL(href, base).toString();
        }
      }

      return null;
    }, baseUrl);

    return apiRefUrl;
  } catch {
    return null;
  }
}

/**
 * Handles the fetch command.
 *
 * @param {Object} argv - Command arguments
 */
async function handleFetch(argv) {
  const { query, force, noCache } = argv;

  // Check if query looks like a URL
  const isUrl = query.startsWith('http://') || query.startsWith('https://');

  if (isUrl) {
    try {
      // Check cache first (unless --no-cache)
      if (!noCache) {
        try {
          const cached = await getCached(query);
          console.log(chalk.green(`Found cached spec for: ${query}`));
          console.log(chalk.dim(`Type: ${cached.metadata.specType} ${cached.metadata.specVersion}`));
          console.log(chalk.dim(`Cached: ${cached.metadata.cachedAt}`));
          console.log();
          const output = formatEndpointList(cached.spec);
          console.log(output);
          return;
        } catch (error) {
          if (!(error instanceof CacheNotFoundError) && !(error instanceof CacheExpiredError)) {
            throw error;
          }
          // Cache miss or expired - continue to fetch
        }
      }

      // If URL looks like a spec file, try direct OpenAPI fetch first
      if (isSpecUrl(query)) {
        console.log(chalk.dim('Attempting to fetch OpenAPI spec...'));
        const result = await fetchOpenAPISpec(query, { timeout: 15000 });

        if (result) {
          console.log(chalk.green(`Found: ${result.specInfo.title}`));
          console.log(chalk.dim(`Type: ${result.specInfo.type} ${result.specInfo.version}`));
          console.log();

          // Cache the result (unless --no-cache)
          if (!noCache) {
            await setCache(query, result.spec, {
              originalFormat: result.format,
              ttl: 24 * 60 * 60 * 1000, // 24 hours
            });
          }

          const output = formatEndpointList(result.spec);
          console.log(output);
          return;
        }
      }

      // Try DOM scraping for docs pages
      console.log(chalk.dim('Trying DOM scraping...'));
      try {
        const scraped = await scrapeEndpoints(query, { timeout: 30000 });
        if (scraped && scraped.endpoints.length > 0) {
          console.log(chalk.green(`Found: ${scraped.apiInfo?.title || 'API Documentation'}`));
          console.log(chalk.dim(`Framework: ${scraped.framework}`));
          console.log(chalk.dim(`Endpoints: ${scraped.endpoints.length}`));
          console.log();

          const output = formatScrapedEndpoints(scraped);
          console.log(output);
          await closeBrowser();
          return;
        }
      } catch (error) {
        if (!(error instanceof DocsScraperError)) {
          await closeBrowser();
          throw error;
        }
        // Fall through to Swagger UI extraction
      }

      // Fall back to Puppeteer-based Swagger UI extraction
      console.log(chalk.dim('Trying Swagger UI extraction...'));
      try {
        const swaggerResult = await extractFromSwaggerUI(query, { timeout: 30000 });
        if (swaggerResult) {
          console.log(chalk.green(`Found: ${swaggerResult.specInfo.title}`));
          console.log(chalk.dim(`Type: ${swaggerResult.specInfo.type} ${swaggerResult.specInfo.version}`));
          console.log(chalk.dim('(extracted via Swagger UI)'));
          console.log();

          // Cache the result (unless --no-cache)
          if (!noCache) {
            await setCache(query, swaggerResult.spec, {
              originalFormat: swaggerResult.format,
              ttl: 24 * 60 * 60 * 1000, // 24 hours
            });
          }

          const output = formatEndpointList(swaggerResult.spec);
          console.log(output);
          await closeBrowser();
          return;
        }
        console.log(chalk.yellow('No API documentation found.'));
        await closeBrowser();
      } catch (error) {
        await closeBrowser();
        if (error instanceof SwaggerUIExtractorError) {
          console.log(chalk.yellow('No OpenAPI spec found.'));
          console.log(chalk.dim(`Error: ${error.message}`));
          return;
        }
        throw error;
      }
    } catch (error) {
      await closeBrowser();
      if (error instanceof OpenAPIExtractorError) {
        console.log(chalk.red(`OpenAPI extraction failed: ${error.message}`));
        return;
      }
      throw error; // Re-throw unexpected errors
    }
    return;
  }

  // Provider name - use APITracker discovery
  try {
    console.log(chalk.dim(`Searching APITracker for "${query}"...`));
    const result = await lookupProvider(query, {
      forceRefresh: force,
    });

    console.log(chalk.green(`Found: ${result.provider}`));
    console.log(chalk.dim(`Docs URL: ${result.docsUrl}`));
    if (result.source === 'cache') {
      console.log(chalk.dim('(from cache)'));
    }
    console.log();
    console.log(chalk.bold('Documentation URL:'));
    console.log(result.docsUrl);
    await closeBrowser();
  } catch (error) {
    await closeBrowser();
    if (error instanceof ProviderNotFoundError) {
      console.log(chalk.red(`No API found for "${query}".`));
      console.log(chalk.dim('Tip: Try a URL if you have a direct link to API docs.'));
      return;
    }

    if (error instanceof DiscoveryFetchError) {
      console.log(chalk.red('Failed to search APITracker.'));
      console.log(chalk.dim(`Error: ${error.cause?.message || error.message}`));
      return;
    }

    // Unexpected error
    console.error(chalk.red('An unexpected error occurred:'), error.message);
    process.exit(1);
  }
}

/**
 * Handles the endpoints command - outputs formatted endpoint list.
 *
 * @param {Object} argv - Command arguments
 */
async function handleEndpoints(argv) {
  const { query, force, verbose, grouped } = argv;

  // Check if query looks like a URL
  const isUrl = query.startsWith('http://') || query.startsWith('https://');

  let spec = null;
  let scrapedResult = null;

  if (isUrl) {
    try {
      // Check cache first (unless force refresh)
      if (!force) {
        try {
          const cached = await getCached(query);
          spec = cached.spec;
        } catch (error) {
          if (!(error instanceof CacheNotFoundError) && !(error instanceof CacheExpiredError)) {
            throw error;
          }
          // Cache miss or expired - continue to fetch
        }
      }

      // Fetch if not cached
      if (!spec) {
        // If URL looks like a spec file, try direct OpenAPI fetch first
        if (isSpecUrl(query)) {
          const result = await fetchOpenAPISpec(query, { timeout: 15000 });
          if (result) {
            spec = result.spec;
            // Cache the result
            await setCache(query, result.spec, {
              originalFormat: result.format,
              ttl: 24 * 60 * 60 * 1000,
            });
          }
        }

        // Try DOM scraping for docs pages
        if (!spec) {
          try {
            scrapedResult = await scrapeEndpoints(query, { timeout: 30000 });
            if (scrapedResult && scrapedResult.endpoints.length > 0) {
              const output = formatScrapedEndpoints(scrapedResult, { verbose, grouped });
              console.log(output);
              await closeBrowser();
              return;
            }
          } catch (error) {
            if (!(error instanceof DocsScraperError)) {
              await closeBrowser();
              throw error;
            }
            // Fall through to Swagger UI extraction
          }
        }

        // Fall back to Swagger UI extraction
        if (!spec) {
          console.log(chalk.dim('Trying Swagger UI extraction...'));
          try {
            const swaggerResult = await extractFromSwaggerUI(query, { timeout: 30000 });
            if (swaggerResult) {
              spec = swaggerResult.spec;
              await setCache(query, swaggerResult.spec, {
                originalFormat: swaggerResult.format,
                ttl: 24 * 60 * 60 * 1000,
              });
            }
            await closeBrowser();
          } catch (error) {
            await closeBrowser();
            if (!(error instanceof SwaggerUIExtractorError)) {
              throw error;
            }
          }

          if (!spec) {
            console.log(chalk.yellow('No API documentation found at the provided URL.'));
            return;
          }
        }
      }
    } catch (error) {
      await closeBrowser();
      if (error instanceof OpenAPIExtractorError) {
        console.log(chalk.red(`OpenAPI extraction failed: ${error.message}`));
        return;
      }
      throw error;
    }
  } else {
    // Provider name - use APITracker discovery + DOM scraping
    try {
      console.log(chalk.dim(`Searching APITracker for "${query}"...`));
      const result = await lookupProvider(query, {
        forceRefresh: force,
      });

      console.log(chalk.dim(`Found docs at: ${result.docsUrl}`));

      let docsUrl = result.docsUrl;
      let foundEndpoints = false;

      // Try DOM scraping on the discovered docs URL
      try {
        scrapedResult = await scrapeEndpoints(docsUrl, { timeout: 30000 });
        if (scrapedResult && scrapedResult.endpoints.length > 0) {
          foundEndpoints = true;
        }
      } catch (error) {
        if (!(error instanceof DocsScraperError)) {
          await closeBrowser();
          throw error;
        }
      }

      // If no endpoints found, try to find API reference page
      if (!foundEndpoints) {
        console.log(chalk.dim('Looking for API reference page...'));
        const page = await getPage({ timeout: 30000 });
        const apiRefUrl = await findApiReferenceUrl(docsUrl, page);
        await page.close();

        if (apiRefUrl && apiRefUrl !== docsUrl) {
          console.log(chalk.dim(`Found API reference: ${apiRefUrl}`));
          docsUrl = apiRefUrl;

          // Try scraping the API reference page
          try {
            scrapedResult = await scrapeEndpoints(docsUrl, { timeout: 30000 });
            if (scrapedResult && scrapedResult.endpoints.length > 0) {
              foundEndpoints = true;
            }
          } catch (error) {
            if (!(error instanceof DocsScraperError)) {
              await closeBrowser();
              throw error;
            }
          }
        }
      }

      // Output if we found endpoints
      if (foundEndpoints && scrapedResult) {
        const output = formatScrapedEndpoints(scrapedResult, { verbose, grouped });
        console.log(output);
        await closeBrowser();
        return;
      }

      // Try direct OpenAPI fetch
      console.log(chalk.dim('Trying OpenAPI extraction...'));
      const fetchResult = await fetchOpenAPISpec(docsUrl, { timeout: 15000 });
      if (fetchResult) {
        spec = fetchResult.spec;
        await setCache(docsUrl, fetchResult.spec, {
          originalFormat: fetchResult.format,
          ttl: 24 * 60 * 60 * 1000,
        });
      } else {
        // Try Swagger UI extraction
        try {
          const swaggerResult = await extractFromSwaggerUI(docsUrl, { timeout: 30000 });
          if (swaggerResult) {
            spec = swaggerResult.spec;
            await setCache(docsUrl, swaggerResult.spec, {
              originalFormat: swaggerResult.format,
              ttl: 24 * 60 * 60 * 1000,
            });
          }
          await closeBrowser();
        } catch (error) {
          await closeBrowser();
          if (!(error instanceof SwaggerUIExtractorError)) {
            throw error;
          }
        }
      }

      if (!spec) {
        console.log(chalk.yellow('Could not extract endpoints from the API documentation.'));
        console.log(chalk.dim(`Docs URL: ${docsUrl}`));
        return;
      }
    } catch (error) {
      await closeBrowser();
      if (error instanceof ProviderNotFoundError) {
        console.log(chalk.red(`No API found for "${query}".`));
        console.log(chalk.dim('Tip: Try a URL if you have a direct link to API docs.'));
        return;
      }

      if (error instanceof DiscoveryFetchError) {
        console.log(chalk.red('Failed to search APITracker.'));
        console.log(chalk.dim(`Error: ${error.cause?.message || error.message}`));
        return;
      }

      throw error;
    }
  }

  // Format and output the endpoint list
  if (spec) {
    const output = formatEndpointList(spec, { verbose, grouped });
    console.log(output);
  }
  await closeBrowser();
}

/**
 * Handles the list command - shows all cached API specs.
 */
async function handleListCached() {
  const entries = await listCache({ checkFiles: true });

  if (entries.length === 0) {
    console.log(chalk.dim('No cached API specs found.'));
    console.log(chalk.dim('Use "api-docs fetch <url>" to cache a spec.'));
    return;
  }

  console.log(chalk.bold(`Cached API Specs (${entries.length}):`));
  console.log();

  entries.forEach((entry) => {
    const status = entry.isExpired ? chalk.yellow(' (expired)') : '';
    const title = entry.specInfo?.title || 'Unknown API';
    console.log(`  ${chalk.bold(title)}${status}`);
    console.log(chalk.dim(`    URL: ${entry.url}`));
    console.log(chalk.dim(`    Cached: ${entry.cachedAt}`));
    console.log();
  });
}

/**
 * Handles the clear command - clears cached specs.
 *
 * @param {Object} argv - Command arguments
 */
async function handleClear(argv) {
  const { url } = argv;

  try {
    if (url) {
      await clearCache(url);
      console.log(chalk.green(`Cleared cache for: ${url}`));
    } else {
      const result = await clearCache();
      console.log(chalk.green(`Cleared ${result.cleared} cached spec(s).`));
      if (result.urls.length > 0) {
        result.urls.forEach((u) => {
          console.log(chalk.dim(`  - ${u}`));
        });
      }
    }
  } catch (error) {
    if (error instanceof CacheNotFoundError) {
      console.log(chalk.yellow(`No cache entry found for: ${url}`));
      return;
    }
    throw error;
  }
}

/**
 * Handles the endpoint command - shows details for a specific endpoint.
 *
 * @param {Object} argv - Command arguments
 */
async function handleEndpoint(argv) {
  const { url, path: endpointPath, method } = argv;

  // Get the cached spec
  let spec;
  try {
    const cached = await getCached(url);
    spec = cached.spec;
  } catch (error) {
    if (error instanceof CacheNotFoundError) {
      console.log(chalk.red(`No cached spec found for: ${url}`));
      console.log(chalk.dim('Use "api-docs fetch <url>" first to cache the spec.'));
      return;
    }
    if (error instanceof CacheExpiredError) {
      console.log(chalk.yellow(`Cached spec expired for: ${url}`));
      console.log(chalk.dim('Use "api-docs fetch <url>" to refresh the cache.'));
      return;
    }
    throw error;
  }

  // Find the endpoint
  const pathItem = spec.paths?.[endpointPath];
  if (!pathItem) {
    console.log(chalk.red(`Endpoint not found: ${endpointPath}`));
    console.log();
    console.log(chalk.dim('Available endpoints:'));
    const paths = Object.keys(spec.paths || {});
    paths.slice(0, 10).forEach((p) => {
      console.log(chalk.dim(`  ${p}`));
    });
    if (paths.length > 10) {
      console.log(chalk.dim(`  ... and ${paths.length - 10} more`));
    }
    return;
  }

  const httpMethods = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'];

  // If method specified, show only that method
  if (method) {
    const operation = pathItem[method.toLowerCase()];
    if (!operation) {
      console.log(chalk.red(`Method ${method.toUpperCase()} not found for ${endpointPath}`));
      console.log();
      console.log(chalk.dim('Available methods:'));
      httpMethods.forEach((m) => {
        if (pathItem[m]) {
          console.log(chalk.dim(`  ${m.toUpperCase()}`));
        }
      });
      return;
    }
    formatEndpointDetails(endpointPath, method.toLowerCase(), operation);
  } else {
    // Show all methods for this path
    let first = true;
    for (const m of httpMethods) {
      if (pathItem[m]) {
        if (!first) console.log();
        first = false;
        formatEndpointDetails(endpointPath, m, pathItem[m]);
      }
    }
  }
}

/**
 * Formats and prints detailed endpoint information.
 *
 * @param {string} path - Endpoint path
 * @param {string} method - HTTP method
 * @param {Object} operation - OpenAPI operation object
 */
function formatEndpointDetails(path, method, operation) {
  const methodColors = {
    get: chalk.green,
    post: chalk.blue,
    put: chalk.yellow,
    patch: chalk.yellow,
    delete: chalk.red,
    head: chalk.magenta,
    options: chalk.cyan,
  };

  const colorFn = methodColors[method] || chalk.white;
  console.log(colorFn.bold(`${method.toUpperCase()} ${path}`));

  if (operation.summary) {
    console.log(operation.summary);
  }
  if (operation.description && operation.description !== operation.summary) {
    console.log(chalk.dim(operation.description));
  }

  // Parameters
  if (operation.parameters?.length) {
    console.log();
    console.log(chalk.bold('Parameters:'));
    operation.parameters.forEach((param) => {
      const required = param.required ? chalk.red('*') : '';
      const desc = param.description || 'no description';
      console.log(`  ${param.name}${required} (${param.in}) - ${desc}`);
    });
  }

  // Request body (OpenAPI 3.x)
  if (operation.requestBody) {
    console.log();
    console.log(chalk.bold('Request Body:'));
    const content = operation.requestBody.content;
    if (content) {
      Object.keys(content).forEach((mediaType) => {
        console.log(chalk.dim(`  ${mediaType}`));
      });
    }
    if (operation.requestBody.description) {
      console.log(chalk.dim(`  ${operation.requestBody.description}`));
    }
  }

  // Responses
  if (operation.responses) {
    console.log();
    console.log(chalk.bold('Responses:'));
    Object.entries(operation.responses).forEach(([code, response]) => {
      const desc = response.description || 'no description';
      console.log(`  ${code}: ${desc}`);
    });
  }
}

yargs(hideBin(process.argv))
  .command(
    'endpoints <query>',
    'List API endpoints in a scannable format',
    (yargs) => {
      return yargs
        .positional('query', {
          describe: 'Provider name (e.g., "n8n", "stripe") or URL to API docs',
          type: 'string',
        })
        .option('force', {
          alias: 'f',
          describe: 'Force fresh fetch (bypass cache)',
          type: 'boolean',
          default: false,
        })
        .option('verbose', {
          alias: 'v',
          describe: 'Show full descriptions instead of summaries',
          type: 'boolean',
          default: false,
        })
        .option('grouped', {
          alias: 'g',
          describe: 'Group endpoints by category/tag',
          type: 'boolean',
          default: true,
        });
    },
    handleEndpoints
  )
  .command(
    'fetch <query>',
    'Fetch an API specification by provider name or URL',
    (yargs) => {
      return yargs
        .positional('query', {
          describe: 'Provider name (e.g., "n8n", "stripe") or URL to API docs',
          type: 'string',
        })
        .option('force', {
          alias: 'f',
          describe: 'Force refresh (bypass APITracker cache)',
          type: 'boolean',
          default: false,
        })
        .option('no-cache', {
          describe: 'Bypass spec cache (fetch fresh)',
          type: 'boolean',
          default: false,
        });
    },
    handleFetch
  )
  .command(
    'list',
    'List all cached API specifications',
    () => {},
    handleListCached
  )
  .command(
    'clear [url]',
    'Clear cached API specifications',
    (yargs) => {
      return yargs.positional('url', {
        describe: 'URL of spec to clear (omit to clear all)',
        type: 'string',
      });
    },
    handleClear
  )
  .command(
    'endpoint <url> <path>',
    'Get details for a specific API endpoint',
    (yargs) => {
      return yargs
        .positional('url', {
          describe: 'URL of the cached API spec',
          type: 'string',
        })
        .positional('path', {
          describe: 'Endpoint path (e.g., /users/{id})',
          type: 'string',
        })
        .option('method', {
          alias: 'm',
          describe: 'HTTP method to show (e.g., GET, POST)',
          type: 'string',
        });
    },
    handleEndpoint
  )
  .command('$0', 'API documentation extractor CLI', () => {}, () => {
    console.log(chalk.green('api-docs CLI'));
    console.log(chalk.dim('Extract API endpoints from any documentation.'));
    console.log();
    console.log(chalk.dim('Use --help to see available commands.'));
  })
  .help()
  .parse();
