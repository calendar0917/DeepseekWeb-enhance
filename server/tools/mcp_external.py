"""External MCP server proxy — connect to third-party MCP servers.

Supports two transports:
  - stdio: spawn a subprocess, communicate via stdin/stdout JSON-RPC
  - http: POST to a remote MCP endpoint (Streamable HTTP / SSE)

Config format (mcp.json "mcpServers" section):
{
  "github": {
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-github"],
    "env": { "GITHUB_TOKEN": "..." }
  },
  "web-search": {
    "url": "http://localhost:3000/mcp"
  }
}
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import sys
from pathlib import Path
from typing import Any

import httpx

logger = logging.getLogger("ds-mcp-bridge.external")


# ─── Stdio Transport ──────────────────────────────────────────

class StdioMCPServer:
    """Connect to an external MCP server via stdio (subprocess)."""

    def __init__(self, name: str, command: str, args: list[str] | None = None,
                 env: dict[str, str] | None = None):
        self.name = name
        self.command = command
        self.args = args or []
        self.env = env or {}
        self._proc: asyncio.subprocess.Process | None = None
        self._next_id = 1
        self._pending: dict[int, asyncio.Future] = {}
        self._read_task: asyncio.Task | None = None
        self._tools: list[dict] = []
        self.connected = False

    async def start(self) -> bool:
        """Spawn subprocess and initialize MCP session."""
        try:
            merged_env = {**os.environ, **self.env}
            self._proc = await asyncio.create_subprocess_exec(
                self.command, *self.args,
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                env=merged_env,
            )
            self._read_task = asyncio.create_task(self._read_loop())

            # MCP initialize handshake
            result = await self._rpc("initialize", {
                "protocolVersion": "2025-03-26",
                "capabilities": {},
                "clientInfo": {"name": "ds-mcp-bridge", "version": "1.0.0"},
            })
            if result is None:
                return False

            # Send initialized notification
            await self._notify("notifications/initialized", {})

            # Fetch tool list
            tools_result = await self._rpc("tools/list", {})
            self._tools = tools_result.get("tools", []) if tools_result else []
            self.connected = True
            logger.info(f"[{self.name}] Connected — {len(self._tools)} tools: "
                        f"{[t['name'] for t in self._tools]}")
            return True

        except Exception as e:
            logger.error(f"[{self.name}] Failed to start: {e}")
            await self.stop()
            return False

    async def stop(self):
        """Kill subprocess and clean up."""
        self.connected = False
        if self._read_task:
            self._read_task.cancel()
        if self._proc:
            try:
                self._proc.stdin.close()
                self._proc.terminate()
                await asyncio.wait_for(self._proc.wait(), timeout=5)
            except Exception:
                self._proc.kill()
            self._proc = None

    async def call_tool(self, name: str, arguments: dict) -> dict:
        """Call a tool on the external server."""
        if not self.connected:
            return {"error": f"[{self.name}] Not connected"}
        result = await self._rpc("tools/call", {"name": name, "arguments": arguments})
        return result or {"error": f"[{self.name}] No response"}

    @property
    def tools(self) -> list[dict]:
        return self._tools

    async def _rpc(self, method: str, params: dict) -> dict | None:
        """Send JSON-RPC request and wait for response."""
        msg_id = self._next_id
        self._next_id += 1
        future: asyncio.Future = asyncio.get_event_loop().create_future()
        self._pending[msg_id] = future

        msg = {"jsonrpc": "2.0", "id": msg_id, "method": method, "params": params}
        try:
            line = json.dumps(msg) + "\n"
            self._proc.stdin.write(line.encode())
            await self._proc.stdin.drain()
        except Exception as e:
            self._pending.pop(msg_id, None)
            logger.error(f"[{self.name}] Write error: {e}")
            return None

        try:
            result = await asyncio.wait_for(future, timeout=30)
            if "error" in result:
                logger.error(f"[{self.name}] RPC error: {result['error']}")
                return None
            return result.get("result")
        except asyncio.TimeoutError:
            self._pending.pop(msg_id, None)
            logger.error(f"[{self.name}] RPC timeout: {method}")
            return None

    async def _notify(self, method: str, params: dict):
        """Send JSON-RPC notification (no response expected)."""
        msg = {"jsonrpc": "2.0", "method": method, "params": params}
        try:
            line = json.dumps(msg) + "\n"
            self._proc.stdin.write(line.encode())
            await self._proc.stdin.drain()
        except Exception as e:
            logger.error(f"[{self.name}] Notify error: {e}")

    async def _read_loop(self):
        """Read JSON-RPC messages from stdout."""
        try:
            while True:
                line = await self._proc.stdout.readline()
                if not line:
                    logger.info(f"[{self.name}] Process exited")
                    self.connected = False
                    break
                try:
                    msg = json.loads(line.decode().strip())
                except json.JSONDecodeError:
                    continue

                msg_id = msg.get("id")
                if msg_id is not None and msg_id in self._pending:
                    self._pending.pop(msg_id).set_result(msg)
        except asyncio.CancelledError:
            pass
        except Exception as e:
            logger.error(f"[{self.name}] Read loop error: {e}")
            self.connected = False


# ─── HTTP Transport ────────────────────────────────────────────

class HTTPMCPServer:
    """Connect to an external MCP server via HTTP (Streamable HTTP / SSE)."""

    def __init__(self, name: str, url: str, headers: dict[str, str] | None = None):
        self.name = name
        self.url = url
        self.headers = headers or {}
        self._next_id = 1
        self._session_id: str | None = None
        self._tools: list[dict] = []
        self._client: httpx.AsyncClient | None = None
        self.connected = False

    async def start(self) -> bool:
        """Initialize MCP session over HTTP."""
        try:
            self._client = httpx.AsyncClient(timeout=30)
            result = await self._rpc("initialize", {
                "protocolVersion": "2025-03-26",
                "capabilities": {},
                "clientInfo": {"name": "ds-mcp-bridge", "version": "1.0.0"},
            })
            if result is None:
                return False

            self._session_id = result.get("sessionId")
            await self._notify("notifications/initialized", {})

            tools_result = await self._rpc("tools/list", {})
            self._tools = tools_result.get("tools", []) if tools_result else []
            self.connected = True
            logger.info(f"[{self.name}] Connected — {len(self._tools)} tools: "
                        f"{[t['name'] for t in self._tools]}")
            return True

        except Exception as e:
            logger.error(f"[{self.name}] Failed to connect: {e}")
            await self.stop()
            return False

    async def stop(self):
        """Close HTTP client."""
        self.connected = False
        if self._client:
            await self._client.aclose()
            self._client = None

    async def call_tool(self, name: str, arguments: dict) -> dict:
        """Call a tool on the external server."""
        if not self.connected:
            return {"error": f"[{self.name}] Not connected"}
        result = await self._rpc("tools/call", {"name": name, "arguments": arguments})
        return result or {"error": f"[{self.name}] No response"}

    @property
    def tools(self) -> list[dict]:
        return self._tools

    def _build_headers(self) -> dict:
        h = {"Content-Type": "application/json", "Accept": "application/json, text/event-stream"}
        h.update(self.headers)
        if self._session_id:
            h["Mcp-Session-Id"] = self._session_id
        return h

    async def _post(self, body: dict) -> dict | None:
        """POST JSON-RPC message, handle both JSON and SSE responses."""
        resp = await self._client.post(self.url, json=body, headers=self._build_headers())
        ct = resp.headers.get("content-type", "")

        # SSE response — parse first data event
        if "text/event-stream" in ct:
            for line in resp.text.split("\n"):
                if line.startswith("data: "):
                    return json.loads(line[6:])
            return None

        # JSON response
        if resp.status_code == 202:
            return None
        return resp.json()

    async def _rpc(self, method: str, params: dict) -> dict | None:
        """Send JSON-RPC request and wait for response."""
        msg_id = self._next_id
        self._next_id += 1
        msg = {"jsonrpc": "2.0", "id": msg_id, "method": method, "params": params}

        try:
            resp = await self._post(msg)
            if resp is None:
                return None
            if "error" in resp:
                logger.error(f"[{self.name}] RPC error: {resp['error']}")
                return None
            return resp.get("result")
        except Exception as e:
            logger.error(f"[{self.name}] RPC error: {e}")
            return None

    async def _notify(self, method: str, params: dict):
        """Send JSON-RPC notification."""
        msg = {"jsonrpc": "2.0", "method": method, "params": params}
        try:
            await self._post(msg)
        except Exception as e:
            logger.error(f"[{self.name}] Notify error: {e}")


# ─── Proxy Manager ─────────────────────────────────────────────

class ExternalMCPProxy:
    """Manage multiple external MCP servers and aggregate their tools."""

    def __init__(self, config_path: str | Path | None = None):
        self._servers: dict[str, StdioMCPServer | HTTPMCPServer] = {}
        self._tool_to_server: dict[str, str] = {}  # tool_name -> server_name
        self._configs: dict[str, dict] = {}  # name -> raw config
        self._config_path = Path(config_path) if config_path else None
        self._stopped: set[str] = set()  # intentionally stopped servers

    async def load_config(self, mcp_servers: dict[str, dict]):
        """Load and start external servers from config.

        Config format per server:
          stdio: {"command": "...", "args": [...], "env": {...}}
          http:  {"url": "...", "headers": {...}}
        """
        for name, cfg in mcp_servers.items():
            self._configs[name] = cfg
            await self._start_server(name, cfg)

        logger.info(f"External proxy: {len(self._servers)} servers, "
                    f"{len(self._tool_to_server)} tools")

    async def _start_server(self, name: str, cfg: dict) -> bool:
        """Start a single server from config dict. Returns True on success.

        Accepted formats:
          MCP standard: {"type": "http", "url": "...", "headers": {...}}
                        {"type": "stdio", "command": "...", "args": [...], "env": {...}}
          Shortcut:     {"command": "..."}  → stdio
                        {"url": "..."}      → http
        """
        transport = cfg.get("type", "")

        is_stdio = transport == "stdio" or (not transport and "command" in cfg)
        is_http = transport in ("http", "sse") or (not transport and "url" in cfg)

        if is_stdio:
            server = StdioMCPServer(
                name=name,
                command=cfg["command"],
                args=cfg.get("args", []),
                env=cfg.get("env", {}),
            )
        elif is_http:
            server = HTTPMCPServer(
                name=name,
                url=cfg["url"],
                headers=cfg.get("headers", {}),
            )
        else:
            logger.warning(f"[{name}] Invalid config — need 'command' (stdio) or 'url' (http)")
            return False

        ok = await server.start()
        if ok:
            self._servers[name] = server
            self._stopped.discard(name)
            for tool in server.tools:
                tname = tool["name"]
                if tname in self._tool_to_server:
                    logger.warning(f"[{name}] Tool '{tname}' conflicts with "
                                   f"'{self._tool_to_server[tname]}' — skipped")
                    continue
                self._tool_to_server[tname] = name
            return True
        return False

    async def _unregister_server_tools(self, name: str):
        """Remove tool-to-server mappings for a server."""
        to_remove = [t for t, s in self._tool_to_server.items() if s == name]
        for t in to_remove:
            del self._tool_to_server[t]

    # ── Runtime Management ──────────────────────────────────────

    async def add_server(self, name: str, cfg: dict) -> dict:
        """Add and start a new external server at runtime. Returns status dict."""
        if name in self._configs:
            return {"ok": False, "error": f"Server '{name}' already exists. Remove it first."}

        self._configs[name] = cfg
        ok = await self._start_server(name, cfg)
        if not ok:
            self._configs.pop(name, None)
            return {"ok": False, "error": f"Failed to start server '{name}'"}

        self._save_persistent_config()
        return {"ok": True, "tools": [t["name"] for t in self._servers[name].tools]}

    async def remove_server(self, name: str) -> dict:
        """Stop and remove an external server."""
        if name not in self._configs:
            return {"ok": False, "error": f"Server '{name}' not found"}

        # Stop if running
        if name in self._servers:
            await self._servers[name].stop()
            await self._unregister_server_tools(name)
            del self._servers[name]

        self._configs.pop(name, None)
        self._stopped.discard(name)
        self._save_persistent_config()
        return {"ok": True}

    async def start_server(self, name: str) -> dict:
        """Start a stopped server."""
        if name not in self._configs:
            return {"ok": False, "error": f"Server '{name}' not found"}
        if name in self._servers and self._servers[name].connected:
            return {"ok": False, "error": f"Server '{name}' already running"}

        ok = await self._start_server(name, self._configs[name])
        if not ok:
            return {"ok": False, "error": f"Failed to start server '{name}'"}
        return {"ok": True, "tools": [t["name"] for t in self._servers[name].tools]}

    async def stop_server(self, name: str) -> dict:
        """Stop a running server without removing config."""
        if name not in self._configs:
            return {"ok": False, "error": f"Server '{name}' not found"}

        if name in self._servers:
            await self._servers[name].stop()
            await self._unregister_server_tools(name)
            del self._servers[name]

        self._stopped.add(name)
        return {"ok": True}

    def get_server_config(self, name: str) -> dict | None:
        """Return raw config for a server (masks env values)."""
        cfg = self._configs.get(name)
        if cfg is None:
            return None
        # Return a copy with env values masked
        safe = json.loads(json.dumps(cfg))
        if "env" in safe:
            for k in safe["env"]:
                safe["env"][k] = "***"
        return safe

    def _save_persistent_config(self):
        """Write current mcpServers config back to mcp.json."""
        if not self._config_path:
            return
        try:
            with open(self._config_path, encoding='utf-8') as f:
                data = json.load(f)
        except (FileNotFoundError, json.JSONDecodeError):
            data = {}

        data["mcpServers"] = self._configs
        with open(self._config_path, 'w', encoding='utf-8') as f:
            json.dump(data, f, indent=2, ensure_ascii=False)
            f.write('\n')
        logger.info(f"Saved external server config to {self._config_path}")

    async def stop_all(self):
        """Stop all external servers."""
        for server in self._servers.values():
            await server.stop()
        self._servers.clear()
        self._tool_to_server.clear()

    def get_all_tools(self) -> list[dict]:
        """Return aggregated tool definitions from all servers."""
        tools = []
        for server in self._servers.values():
            for tool in server.tools:
                if tool["name"] in self._tool_to_server and self._tool_to_server[tool["name"]] == server.name:
                    tools.append(tool)
        return tools

    def get_all_tool_names(self) -> set[str]:
        """Return set of all external tool names."""
        return set(self._tool_to_server.keys())

    async def call_tool(self, tool_name: str, arguments: dict) -> dict:
        """Route tool call to the correct server."""
        server_name = self._tool_to_server.get(tool_name)
        if not server_name or server_name not in self._servers:
            return {"error": f"External tool '{tool_name}' not found"}
        return await self._servers[server_name].call_tool(tool_name, arguments)

    def get_status(self) -> list[dict]:
        """Return status of all known external servers (including stopped)."""
        result = []
        for name in self._configs:
            if name in self._servers:
                server = self._servers[name]
                result.append({
                    "name": name,
                    "transport": "stdio" if isinstance(server, StdioMCPServer) else "http",
                    "connected": server.connected,
                    "status": "running" if server.connected else "error",
                    "tools": [t["name"] for t in server.tools],
                })
            elif name in self._stopped:
                result.append({
                    "name": name,
                    "transport": "stdio" if "command" in self._configs[name] else "http",
                    "connected": False,
                    "status": "stopped",
                    "tools": [],
                })
            else:
                result.append({
                    "name": name,
                    "transport": "stdio" if "command" in self._configs[name] else "http",
                    "connected": False,
                    "status": "pending",
                    "tools": [],
                })
        return result
