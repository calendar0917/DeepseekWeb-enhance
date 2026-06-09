# Release Process

This project publishes two independent userscripts:

- `ds-enhance.user.js` for normal DeepSeek Chat enhancements.
- `ds-mcp-bridge.user.js` for MCP tool calling and TTS.

## Version Update

1. Decide the release type.
   - Patch: selector fixes, small bug fixes, documentation updates.
   - Minor: new features, new DOM embed points, new configuration options.
   - Major: storage migrations, build-system changes, or permission changes.
2. Update the `@version` field in every changed `.user.js` file.
3. Update `CHANGELOG.md` with user-visible changes, permission changes, and migration notes.
4. Verify metadata fields are present before publishing:
   - `@homepageURL`
   - `@supportURL`
   - `@downloadURL`
   - `@updateURL`
   - `@license`
   - `@icon`
   - `@connect` only for `ds-mcp-bridge.user.js`

## Pre-Release Checks

Run these commands from the repository root:

```bash
npm ci
npm run build
npm run check
npm run check:release
npm test
```

For MCP server changes, also run the Python tests:

```bash
cd server
pytest
```

## Manual Smoke Test

1. Open `chat.deepseek.com` with Tampermonkey enabled.
2. Confirm the DS Enhance blue floating button appears.
3. Confirm DS Enhance can open its panel, load sessions, and show prompt controls.
4. Confirm the DS MCP Bridge green button appears.
5. With the MCP server stopped, confirm the bridge shows a clear disconnected state.
6. Start the MCP server and confirm the tool list refreshes.
7. Generate or open a reply and confirm TTS/action injection does not duplicate buttons.

Use `docs/manual-smoke.md` for the full checklist. Review `docs/storage-migration.md` before changing any localStorage or GM storage key.

## GitHub Release

1. Push the release branch and open a pull request.
2. Merge after checks and manual smoke testing pass.
3. Create a GitHub Release tagged with the released version.
4. Include links to the raw userscript install URLs:
   - `https://raw.githubusercontent.com/calendar0917/DeepseekWeb-enhance/main/ds-enhance.user.js`
   - `https://raw.githubusercontent.com/calendar0917/DeepseekWeb-enhance/main/ds-mcp-bridge.user.js`
5. Attach the corresponding `dist/*.user.js` files as release assets.

## Userscript Platform Sync

After GitHub is updated, publish the same script bodies to GreasyFork and ScriptCat.

Use the prepared copy in `docs/greasyfork.md` for the script descriptions, permission notes, privacy notes, and changelog links. Confirm that platform metadata matches the repository version and that update checks resolve to the raw GitHub URLs.
