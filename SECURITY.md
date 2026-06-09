# Security Policy

DS Enhance contains two separate userscripts with different risk levels.

## Script Boundaries

`ds-enhance.user.js` is the low-permission browser enhancement script. It runs on `chat.deepseek.com`, uses `@grant none`, and stores user configuration in browser storage.

`ds-mcp-bridge.user.js` is the advanced MCP bridge. It connects to the local service at `localhost:8024` and uses Tampermonkey GM APIs to bypass browser CORS restrictions for that local service. Install it only on machines and browser profiles you trust.

## MCP Local Tool Risks

The MCP bridge can ask the local server to run tools. Built-in tools include:

| Tool | Capability | Risk |
|------|------------|------|
| `execute_command` | Runs a shell command on the local machine | Can modify files, start processes, access environment variables, or run destructive commands |
| `read_file` | Reads a local file path allowed by the server process | Can expose private files or project secrets to the chat context |
| `write_file` | Writes content to a local file path allowed by the server process | Can overwrite or create files on disk |
| `list_directory` | Lists local directory entries | Can reveal project and filesystem structure |
| External MCP tools | Runs tools provided by configured third-party MCP servers | Capability depends on the external server configuration |

DeepSeek model output can trigger MCP tool calls when the bridge detects the supported tool-call format. Treat model-generated tool calls as untrusted input. Review commands and paths before enabling automatic execution in sensitive workspaces.

## Recommended Usage

- Use DS MCP Bridge only on a personal, trusted machine.
- Do not run the local MCP server with elevated privileges.
- Keep the MCP server bound to localhost unless you fully understand the exposure.
- Review `server/mcp.json` before enabling external MCP servers.
- Avoid placing secrets in prompts, tool results, or files that may be injected back into chat.
- Disable the MCP module when you only need normal DeepSeek browsing.

## Reporting Vulnerabilities

Report security issues through GitHub Issues: https://github.com/calendar0917/DeepseekWeb-enhance/issues

Please include the affected script, version, browser userscript manager, reproduction steps, and whether the local MCP server was running.
