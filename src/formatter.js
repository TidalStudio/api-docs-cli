/**
 * Endpoint list formatter module for api-docs-cli
 * Outputs API endpoints in a scannable, color-coded format
 */

import chalk from 'chalk';

// ============================================================================
// Configuration
// ============================================================================

/**
 * HTTP method color mapping for terminal output
 * Colors extracted from n8n Scalar docs (display-p3 converted to sRGB)
 */
const HTTP_METHOD_COLORS = {
  GET: 'rgb(0,160,255)',      // neon blue
  POST: 'rgb(0,200,80)',      // neon green
  DELETE: 'rgb(255,50,50)',   // neon red
  PUT: 'rgb(255,120,30)',     // neon orange
  PATCH: 'rgb(255,220,50)',   // neon yellow
  HEAD: 'dim',
  OPTIONS: 'dim',
};

/**
 * Valid HTTP methods that represent operations
 * Used to filter out non-operation properties like $ref, parameters, etc.
 */
const VALID_METHODS = new Set([
  'get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace',
]);

/**
 * Fixed width for method column to ensure alignment
 */
const METHOD_COLUMN_WIDTH = 7;

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Extracts the base URL from an OpenAPI/Swagger spec
 *
 * @param {Object} spec - Parsed OpenAPI/Swagger spec
 * @returns {string|null} Base URL or null if not found
 */
function extractBaseUrl(spec) {
  // OpenAPI 3.x uses servers array
  if (spec.servers && spec.servers.length > 0) {
    return spec.servers[0].url;
  }

  // Swagger 2.0 uses host + basePath
  if (spec.host) {
    const scheme = spec.schemes?.[0] || 'https';
    const basePath = spec.basePath || '';
    return `${scheme}://${spec.host}${basePath}`;
  }

  return null;
}

/**
 * Formats an HTTP method with color and fixed width
 *
 * @param {string} method - HTTP method (lowercase)
 * @param {boolean} useColor - Whether to apply color
 * @returns {string} Formatted method string
 */
function formatMethod(method, useColor) {
  const upper = method.toUpperCase();
  const padded = upper.padEnd(METHOD_COLUMN_WIDTH);

  if (!useColor) {
    return padded;
  }

  const colorSpec = HTTP_METHOD_COLORS[upper] || 'white';

  // Handle RGB color specifications
  if (colorSpec.startsWith('rgb(')) {
    const match = colorSpec.match(/rgb\((\d+),(\d+),(\d+)\)/);
    if (match) {
      return chalk.rgb(parseInt(match[1]), parseInt(match[2]), parseInt(match[3]))(padded);
    }
  }

  // Handle named colors
  const colorFn = chalk[colorSpec];
  return colorFn ? colorFn(padded) : padded;
}

/**
 * Extracts description text from an operation
 *
 * @param {Object} operation - OpenAPI operation object
 * @param {boolean} verbose - Use full description instead of summary
 * @returns {string} Description text
 */
function extractDescription(operation, verbose) {
  if (verbose && operation.description) {
    // For verbose mode, use description but truncate if very long
    const desc = operation.description.replace(/\s+/g, ' ').trim();
    return desc.length > 200 ? desc.slice(0, 197) + '...' : desc;
  }

  if (operation.summary) {
    return operation.summary;
  }

  if (operation.description) {
    // Fall back to description if no summary
    const desc = operation.description.replace(/\s+/g, ' ').trim();
    return desc.length > 80 ? desc.slice(0, 77) + '...' : desc;
  }

  return '';
}

/**
 * Groups endpoints by their first tag or infers category from path
 *
 * @param {Array} endpoints - Array of endpoint objects with tags array
 * @returns {Map<string, Array>} Map of category name to endpoints
 */
function groupByCategory(endpoints) {
  const groups = new Map();

  for (const endpoint of endpoints) {
    let category = 'Other';

    // Use first tag if available
    if (endpoint.tags && endpoint.tags.length > 0) {
      category = endpoint.tags[0];
    } else if (endpoint.path) {
      // Infer from path - use first segment after leading slash
      const pathMatch = endpoint.path.match(/^\/([^/]+)/);
      if (pathMatch) {
        // Capitalize first letter
        category = pathMatch[1].charAt(0).toUpperCase() + pathMatch[1].slice(1);
      }
    }

    if (!groups.has(category)) {
      groups.set(category, []);
    }
    groups.get(category).push(endpoint);
  }

  return groups;
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Formats an API spec's endpoints as a scannable list.
 *
 * Output format:
 * ```
 * API Title
 * https://base.url
 *
 * Category
 * ────────
 *   GET    /path/to/resource     Description of the endpoint
 *   POST   /path/to/resource     Create a new resource
 * ```
 *
 * @param {Object} spec - Parsed OpenAPI/Swagger specification
 * @param {Object} options - Formatting options
 * @param {boolean} [options.verbose=false] - Show full descriptions
 * @param {boolean} [options.grouped=false] - Group endpoints by tag/category
 * @param {boolean} [options.color] - Force color on/off (defaults to TTY detection)
 * @returns {string} Formatted endpoint list
 *
 * @example
 * const output = formatEndpointList(spec, { verbose: true });
 * console.log(output);
 */
export function formatEndpointList(spec, options = {}) {
  const { verbose = false, grouped = false } = options;
  const useColor = options.color ?? process.stdout.isTTY ?? false;

  const lines = [];

  // Header: API title
  const title = spec.info?.title || 'Unknown API';
  const version = spec.info?.version;
  const titleLine = version ? `${title} v${version}` : title;
  lines.push(useColor ? chalk.bold(titleLine) : titleLine);

  // Header: Base URL
  const baseUrl = extractBaseUrl(spec);
  if (baseUrl) {
    lines.push(useColor ? chalk.dim(baseUrl) : baseUrl);
  }

  lines.push(''); // Empty line after header

  // Check for paths
  if (!spec.paths || Object.keys(spec.paths).length === 0) {
    lines.push('No endpoints found');
    return lines.join('\n');
  }

  // Collect all endpoints with their tags
  const endpoints = [];
  for (const [path, pathItem] of Object.entries(spec.paths)) {
    if (!pathItem || typeof pathItem !== 'object') {
      continue;
    }

    for (const [method, operation] of Object.entries(pathItem)) {
      // Skip non-operation properties
      if (!VALID_METHODS.has(method.toLowerCase())) {
        continue;
      }

      if (!operation || typeof operation !== 'object') {
        continue;
      }

      endpoints.push({
        method,
        path,
        description: extractDescription(operation, verbose),
        tags: operation.tags || [],
      });
    }
  }

  // Format endpoints (grouped or flat)
  if (grouped && endpoints.length > 0) {
    const groups = groupByCategory(endpoints);

    let first = true;
    for (const [category, categoryEndpoints] of groups) {
      if (!first) {
        lines.push(''); // Empty line between categories
      }
      first = false;

      // Category header - plain text with underline decoration
      lines.push(category);
      lines.push('─'.repeat(category.length));

      for (const endpoint of categoryEndpoints) {
        const formattedMethod = formatMethod(endpoint.method, useColor);
        const desc = endpoint.description || '';
        lines.push(`  ${formattedMethod} ${endpoint.path}${desc ? '  ' + desc : ''}`);
      }
    }
  } else {
    for (const endpoint of endpoints) {
      const formattedMethod = formatMethod(endpoint.method, useColor);
      const desc = endpoint.description || '';
      lines.push(`${formattedMethod} ${endpoint.path}${desc ? '  ' + desc : ''}`);
    }
  }

  return lines.join('\n');
}

/**
 * Formats scraped endpoints from DOM scraper as a scannable list.
 *
 * Output format:
 * ```
 * API Title
 * (extracted via DOM scraping)
 *
 * Category
 * ────────
 *   GET    /path/to/resource     Description of the endpoint
 *   POST   /path/to/resource     Create a new resource
 * ```
 *
 * @param {Object} scrapedResult - Result from scrapeEndpoints()
 * @param {Object} options - Formatting options
 * @param {boolean} [options.verbose=false] - Show full descriptions
 * @param {boolean} [options.grouped=true] - Group endpoints by tag/category (default true for scraped)
 * @param {boolean} [options.color] - Force color on/off (defaults to TTY detection)
 * @param {string} [options.sourceUrl] - Source URL for hint message
 * @returns {string} Formatted endpoint list
 *
 * @example
 * const output = formatScrapedEndpoints(scraped, { verbose: true });
 * console.log(output);
 */
export function formatScrapedEndpoints(scrapedResult, options = {}) {
  const { verbose = false, grouped = true, sourceUrl } = options;
  const useColor = options.color ?? process.stdout.isTTY ?? false;

  const lines = [];

  // Header: API title
  const title = scrapedResult.apiInfo?.title || 'API Documentation';
  const version = scrapedResult.apiInfo?.version;
  const titleLine = version ? `${title} v${version}` : title;
  lines.push(useColor ? chalk.bold(titleLine) : titleLine);

  // Header: Framework info
  const frameworkInfo = `(extracted via ${scrapedResult.framework})`;
  lines.push(useColor ? chalk.dim(frameworkInfo) : frameworkInfo);

  lines.push(''); // Empty line after header

  // Check for endpoints
  if (!scrapedResult.endpoints || scrapedResult.endpoints.length === 0) {
    lines.push('No endpoints found');
    return lines.join('\n');
  }

  // Check if any endpoints have descriptions
  const hasDescriptions = scrapedResult.endpoints.some(e => e.description && e.description.trim());

  // Format endpoints (grouped or flat)
  if (grouped && scrapedResult.endpoints.length > 0) {
    const groups = groupByCategory(scrapedResult.endpoints);

    let first = true;
    for (const [category, categoryEndpoints] of groups) {
      if (!first) {
        lines.push(''); // Empty line between categories
      }
      first = false;

      // Category header - plain text with underline decoration
      lines.push(category);
      lines.push('─'.repeat(category.length));

      for (const endpoint of categoryEndpoints) {
        const formattedMethod = formatMethod(endpoint.method, useColor);
        let description = endpoint.description || '';

        if (description) {
          if (!verbose && description.length > 80) {
            description = description.slice(0, 77) + '...';
          } else if (verbose && description.length > 200) {
            description = description.slice(0, 197) + '...';
          }
        }

        lines.push(`  ${formattedMethod} ${endpoint.path}${description ? '  ' + description : ''}`);
      }
    }
  } else {
    for (const endpoint of scrapedResult.endpoints) {
      const formattedMethod = formatMethod(endpoint.method, useColor);
      let description = endpoint.description || '';

      if (description) {
        if (!verbose && description.length > 80) {
          description = description.slice(0, 77) + '...';
        } else if (verbose && description.length > 200) {
          description = description.slice(0, 197) + '...';
        }
      }

      lines.push(`${formattedMethod} ${endpoint.path}${description ? '  ' + description : ''}`);
    }
  }

  // Add hint about verbose mode if descriptions are missing
  if (!hasDescriptions && !verbose) {
    lines.push('');
    const hint = 'Tip: Use -v for verbose output, or pipe specific paths to see details';
    lines.push(useColor ? chalk.dim(hint) : hint);
  }

  return lines.join('\n');
}

/**
 * Formats endpoint details for display.
 *
 * @param {Object} endpoint - Endpoint object with method, path, description, tags
 * @param {Object} options - Formatting options
 * @param {boolean} [options.color] - Force color on/off
 * @returns {string} Formatted endpoint details
 */
export function formatEndpointDetail(endpoint, options = {}) {
  const useColor = options.color ?? process.stdout.isTTY ?? false;

  const lines = [];

  // Method and path header
  const methodColors = {
    GET: chalk.green,
    POST: chalk.blue,
    PUT: chalk.yellow,
    PATCH: chalk.magenta,
    DELETE: chalk.red,
    HEAD: chalk.dim,
    OPTIONS: chalk.dim,
  };

  const colorFn = methodColors[endpoint.method] || chalk.white;
  const header = `${endpoint.method} ${endpoint.path}`;
  lines.push(useColor ? colorFn.bold(header) : header);

  // Description
  if (endpoint.description) {
    lines.push(endpoint.description);
  }

  // Tags
  if (endpoint.tags && endpoint.tags.length > 0) {
    lines.push('');
    const tagsLine = `Tags: ${endpoint.tags.join(', ')}`;
    lines.push(useColor ? chalk.dim(tagsLine) : tagsLine);
  }

  // Operation ID
  if (endpoint.operationId) {
    const opIdLine = `Operation ID: ${endpoint.operationId}`;
    lines.push(useColor ? chalk.dim(opIdLine) : opIdLine);
  }

  return lines.join('\n');
}
