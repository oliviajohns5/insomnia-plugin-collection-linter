# insomnia-plugin-collection-linter

[![npm version](https://img.shields.io/npm/v/insomnia-plugin-collection-linter.svg)](https://www.npmjs.com/package/insomnia-plugin-collection-linter)
[![license: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

Local-only workspace linting for Insomnia. v1.0.1 adds a quality score and actionable fix guidance for every finding.

Collection Linter exports a redacted Markdown report for duplicate names, risky URLs, auth query strings, empty bodies, production mutations, and environment hygiene issues.

## Why

Insomnia workspaces grow messy over time: duplicate request names, copied prod URLs in dev folders, auth tokens in query strings, empty mutation bodies, and inconsistent environments.

This plugin gives teams a local hygiene report without sending workspace data anywhere.

## Features

- Adds a 0–100 workspace quality score
- Adds actionable remediation guidance for every finding
- Detects duplicate request/folder/environment names
- Detects duplicate method + host + path routes
- Flags auth-like query parameters: `api_key`, `access_token`, `client_secret`, `token`
- Flags destructive methods targeting production-like hosts
- Flags development-looking request names pointing at production hosts
- Flags invalid/missing URLs
- Flags empty mutation bodies
- Flags environments with no obvious base URL/host key
- Redacts secret-like values in reports
- No cloud
- No telemetry
- No backend
- No dependencies

## Install

From Insomnia:

1. Open **Preferences**
2. Go to **Plugins**
3. Enter:

```text
insomnia-plugin-collection-linter
```

4. Click **Install Plugin**

Manual local install:

```bash
cd "$HOME/Library/Application Support/Insomnia/plugins"
npm install insomnia-plugin-collection-linter
```

Linux plugin path:

```text
~/.config/Insomnia/plugins/
```

Windows plugin path:

```text
%APPDATA%\Insomnia\plugins\
```

## Usage

Open an action menu in Insomnia and run:

```text
Collection Linter: Export Report
```

The action is exposed through:

- `workspaceActions`
- `requestGroupActions`
- `requestActions`

In Insomnia 13, this may appear in the **New Request** dropdown or request/folder action menus.

## Example report

```markdown
# Insomnia Collection Linter Report

Generated: 2026-07-28T00:00:00.000Z

Local-only report. Secrets are redacted.

## Summary

- High: 2
- Medium: 3
- Low: 4

## Findings

| Severity | Type | Location | Message | Preview | Fix |
|---|---|---|---|---|---|
| high | query-auth | $.resources[0].url | Auth-like value in query string | api_key=reda…alue |
| medium | duplicate-route | workspace.requests | Duplicate method+host+path route | get api.example.com/users (2) |
```

## What it catches

### High

- auth-like values in query strings
- secret-looking values in workspace export
- destructive methods against production-like hosts

### Medium

- invalid URLs
- missing URLs
- duplicate method + host + path routes
- dev/test request names pointing at production-like hosts

### Low

- duplicate names
- empty mutation bodies
- environments missing obvious base URL/host keys
- many distinct hosts in one workspace
- risky-sounding requests with no description

## Privacy

Collection Linter is local-only.

- It does not call a backend.
- It does not use analytics.
- It does not need credentials.
- It exports with `includePrivate: false`.
- It writes a local Markdown file.
- It redacts secret-like values before writing the report.

## Development

```bash
git clone https://github.com/oliviajohns5/insomnia-plugin-collection-linter.git
cd insomnia-plugin-collection-linter
npm test
npm run test:packaged
npm pack --dry-run
```

## Verified QA

- `node --check main.js`
- `node --check test.js`
- `node --check real-insomnia-packaged-test.js`
- `node --check qa-packaged.js`
- `npm test`
- `npm run test:packaged`
- `npm pack --dry-run`
- isolated tarball install
- package metadata validation
- credential literal scan

## Requirements

- Insomnia
- Node.js/npm only for development or publishing

## License

MIT
