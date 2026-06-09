# Manual Smoke Checklist

Run this checklist on `https://chat.deepseek.com` before publishing a release.

## DS Enhance

- Log in to DeepSeek and confirm the blue DS Enhance floating button appears.
- Open the DS Enhance panel and confirm sessions load.
- Confirm the native prompt button appears near the composer.
- Open search from the sidebar entry and verify text, date, and category filters render.
- Switch conversations and refresh the page; confirm prompt/sidebar buttons are not duplicated.
- Assign a category and confirm the sidebar conversation row shows a category dot.
- Run a small export and confirm the filename includes title/date or count/date.

## DS MCP Bridge

- With the MCP server stopped, open the green MCP panel and confirm the status clearly says disconnected.
- Start the server with `cd server && python server.py`, then refresh status and confirm builtin and external tool counts render.
- On the external MCP tab, confirm installed servers show running/stopped/error states and that failures show an inline summary.
- Confirm the native MCP composer entry appears near the DeepSeek composer.
- Generate or open an assistant reply and confirm exactly one TTS button appears in the message action area.
- Toggle current-session autoplay in a specific conversation and confirm it does not enable global autoplay.
- Open settings, filter voices, and run a voice preview; confirm loading and failure states are visible.
- Confirm an `execute_command` tool call asks for confirmation when the confirmation setting is enabled.

## Regression Watch

- Typing in the composer should not lag noticeably.
- Generating a reply should not duplicate native buttons.
- Switching conversations should preserve normal DeepSeek input and send behavior.
- If a native mount point cannot be found, the floating panel should remain usable.
