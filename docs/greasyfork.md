# GreasyFork / ScriptCat Publishing Copy

## DS Enhance

### Short Description

DeepSeek Chat conversation management helper for deletion, fork, categories, search, export, rename, and prompt injection.

### Permission Notes

DS Enhance runs only on `https://chat.deepseek.com/*` and keeps `@grant none`. It uses DeepSeek page APIs from the browser session and stores category and prompt settings locally in the browser.

### Privacy Notes

DS Enhance does not send data to third-party services. Conversation metadata and prompt settings are stored in local browser storage. Exported files are generated locally by the browser.

### Changelog Link

https://github.com/calendar0917/DeepseekWeb-enhance/blob/main/CHANGELOG.md

## DS MCP Bridge

### Short Description

DeepSeek Chat MCP bridge for local tool calling and TTS, connecting the page to a local MCP service on `localhost:8024`.

### Permission Notes

DS MCP Bridge runs only on `https://chat.deepseek.com/*`. It declares GM storage and request permissions so it can connect to the local MCP server. The script also declares `@connect localhost` and `@connect 127.0.0.1`.

### Security Warning

The local MCP server can expose tools such as `execute_command`, `read_file`, and `write_file`. These tools can run local commands and read or modify local files depending on server configuration. Install this script only in a trusted browser profile and run the server only on machines you control.

### Privacy Notes

Tool results may be inserted into the DeepSeek chat context. Do not use MCP tools on private files, credentials, or sensitive repositories unless you intend that content to be available to the chat page. DS MCP Bridge does not intentionally send data to services other than DeepSeek and the configured local MCP server.

### Changelog Link

https://github.com/calendar0917/DeepseekWeb-enhance/blob/main/CHANGELOG.md

### Security Link

https://github.com/calendar0917/DeepseekWeb-enhance/blob/main/SECURITY.md
