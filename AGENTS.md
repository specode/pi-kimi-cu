# Repository Guidelines

## Project Structure & Module Organization

This Node.js ESM package connects Pi to Kimi Computer Use. `extensions/kimi-cu.js` registers `/kimi-cu`; reusable modules live in `src/`. `skills/kimi-cu/SKILL.md` defines the agent workflow. Tests are in `test/pi-kimi-cu.test.js`; documentation is in both READMEs.

## Build, Test, and Development Commands

- `npm ci` installs the exact dependencies recorded in `package-lock.json`.
- `npm test` runs the full suite with Node's built-in test runner.
- `npm run check` syntax-checks shipped JavaScript, then runs all tests. Use it before a pull request.
- `npm pack --dry-run` previews published files. There is no compilation step.

Use Node.js 20+. Runtime setup requires Apple Silicon and macOS 14+; most tests are platform-independent.

## Coding Style & Naming Conventions

Use ESM imports/exports, double quotes, semicolons, and trailing commas. Follow each file's indentation: most JavaScript uses tabs, while `src/mcp-config.js` uses two spaces. Use camelCase for functions and variables, PascalCase for classes, and UPPER_SNAKE_CASE for exported constants. Keep user-facing messages in the existing `中文 / English` form. No formatter or linter is configured; avoid unrelated formatting changes.

## Testing Guidelines

Write tests with `node:test` and `node:assert/strict`. Name tests by observable behavior, for example `test("refuses malformed MCP JSON without replacing it", ...)`. Cover configuration precedence, filesystem safety, failures, and rollback. Use temporary directories and injected command runners instead of real settings or `/Applications`. Skip macOS-only tests elsewhere. No coverage threshold is enforced.

## Commit & Pull Request Guidelines

History favors short, imperative Conventional Commit subjects such as `feat:`, `test:`, `ci:`, `docs:`, and `chore:`. Keep commits focused. Pull requests should explain the user-visible effect, safety implications, and validation; link issues and add screenshots for interactive UI changes. Update both READMEs when public behavior changes, and include `npm run check` results.

## Release Process

The npm package is published through `.github/workflows/npm-publish.yml`. Update the version in `package.json` and `package-lock.json`, run `npm run check` and `npm pack --dry-run`, then commit. Create a GitHub Release with the matching `vX.Y.Z` tag; this triggers the Trusted Publisher workflow. Do not publish manually or add a long-lived npm token.

## Security & Configuration

Never weaken bundle ID, architecture, Team ID, or `codesign` checks without explicit justification and tests. Preserve unrelated MCP servers, file modes, atomic writes, and rollback paths. Do not commit local MCP configuration, credentials, downloaded app bundles, or generated package archives.
