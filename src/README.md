# Userscript Source Layout

`src/entries/*.js` is the development entrypoint for the two published userscripts.

Run `npm run build` after editing an entry. The build script validates userscript metadata, runs an esbuild parse pass, and writes both:

- root install files: `ds-enhance.user.js`, `ds-mcp-bridge.user.js`
- release artifacts: `dist/ds-enhance.user.js`, `dist/ds-mcp-bridge.user.js`

The current migration keeps each userscript as one entry file to avoid a large behavior-changing refactor. When extracting modules, keep these boundaries:

- shared UI/storage helpers go under `src/core/`
- DeepSeek selectors go under `src/adapters/`
- product features go under `src/features/`
- final userscript headers stay owned by the entry files and are re-injected by `scripts/build-userscripts.js`

Tests should target `dist/*.user.js` so the built release artifacts remain the verified surface.

Current extracted modules:

- `src/core/dom-mount.js`
- `src/core/storage.js`
- `src/core/ui.js`
- `src/adapters/deepseek.js`
- `src/features/export/format.js`
- `src/features/mcp/tool-policy.js`
