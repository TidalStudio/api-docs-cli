<p align="center">
  <img src="api-docs-cli.png" alt="api-docs-cli logo" width="300">
</p>
<h1 align="center">api-docs-cli</h1>

<p align="center">
  A CLI for discovering and extracting API documentation from any source.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@tidalstudios/api-docs-cli"><img src="https://img.shields.io/npm/v/@tidalstudios/api-docs-cli.svg" alt="npm version"></a>
  <img src="https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen" alt="Node.js version">
  <a href="https://github.com/TidalStudio/api-docs-cli/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-Elastic--2.0-blue" alt="License"></a>
</p>

> **Why this tool?** API documentation is scattered across different formats and frameworks. This CLI gives you instant access to any API's endpoints—just provide a name or URL.

## Installation

```bash
npm install -g @tidalstudios/api-docs-cli
```

Or run directly with npx:

```bash
npx @tidalstudios/api-docs-cli endpoints stripe
```

## Quick Start

```bash
# List endpoints from any API provider
api-docs endpoints stripe

# Or from a direct URL
api-docs endpoints https://docs.n8n.io/api

# Get details for a specific endpoint
api-docs endpoint stripe /v1/customers --method GET

# View cached specs
api-docs list
```

## Features

- **Universal Discovery** - Find APIs by provider name via APITracker.io
- **Multi-Framework Support** - Swagger UI, Redoc, Scalar, and generic docs
- **Smart Extraction** - Automatic fallback through multiple strategies
- **Spec Caching** - Local cache with TTL for fast repeated access
- **Clean Output** - Color-coded, grouped endpoints

## Commands

| Command | Description |
|---------|-------------|
| `endpoints` | List all endpoints from an API |
| `endpoint` | Get details for a specific endpoint |
| `fetch` | Fetch and cache an API spec |
| `list` | List cached API specs |
| `clear` | Clear cached specs |

## AI Agent Integration

Works as a Claude Code subagent:

```
Task(subagent_type="api-docs", prompt="List endpoints for the Stripe API")
```
