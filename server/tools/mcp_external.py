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
import shutil
import subprocess
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
            cmd = self.command
            # On Windows, resolve .cmd/.bat wrappers (e.g. npx → npx.cmd)
            if sys.platform == 'win32':
                resolved = shutil.which(cmd)
                if resolved:
                    cmd = resolved
            kwargs: dict[str, Any] = {}
            if sys.platform == 'win32':
                kwargs['creationflags'] = 0x08000000  # CREATE_NO_WINDOW
            self._proc = await asyncio.create_subprocess_exec(
                cmd, *self.args,
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                env=merged_env,
                **kwargs,
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

        except FileNotFoundError:
            logger.error(f"[{self.name}] 启动失败：找不到命令 '{self.command}'，请确认已安装对应工具")
            await self.stop()
            return False
        except Exception as e:
            logger.error(f"[{self.name}] 启动失败: {e}")
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
                if sys.platform == 'win32':
                    # taskkill /F /T kills the process tree on Windows
                    subprocess.run(
                        ["taskkill", "/F", "/T", "/PID", str(self._proc.pid)],
                        capture_output=True,
                    )
                    try:
                        await asyncio.wait_for(self._proc.wait(), timeout=5)
                    except asyncio.TimeoutError:
                        self._proc.kill()
                else:
                    self._proc.terminate()
                    try:
                        await asyncio.wait_for(self._proc.wait(), timeout=5)
                    except asyncio.TimeoutError:
                        self._proc.kill()
            except Exception:
                self._proc.kill()
            self._proc = None

    async def call_tool(self, name: str, arguments: dict) -> dict:
        """Call a tool on the external server."""
        if not self.connected:
            return {"error": f"[{self.name}] 未连接 — 服务器进程可能已退出，请尝试重新启动"}
        result = await self._rpc("tools/call", {"name": name, "arguments": arguments})
        return result or {"error": f"[{self.name}] 调用工具 '{name}' 无响应 — 服务器可能已卡死，请重启该 MCP 服务器"}

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
            logger.error(f"[{self.name}] 写入失败: {e}")
            return None

        try:
            result = await asyncio.wait_for(future, timeout=30)
            if "error" in result:
                logger.error(f"[{self.name}] RPC 错误: {result['error']}")
                return None
            return result.get("result")
        except asyncio.TimeoutError:
            self._pending.pop(msg_id, None)
            logger.error(f"[{self.name}] RPC 超时 ({method}) — 服务器响应超过 30 秒")
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
                    logger.warning(f"[{self.name}] 进程已退出 — 如需使用请重启该 MCP 服务器")
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

            session_id = result.get("sessionId")
            if session_id:
                self._session_id = session_id
            await self._notify("notifications/initialized", {})

            tools_result = await self._rpc("tools/list", {})
            self._tools = tools_result.get("tools", []) if tools_result else []
            self.connected = True
            logger.info(f"[{self.name}] Connected — {len(self._tools)} tools: "
                        f"{[t['name'] for t in self._tools]}")
            return True

        except Exception as e:
            logger.error(f"[{self.name}] 连接失败: {e}。请检查 URL 是否正确以及目标服务是否已启动")
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
            return {"error": f"[{self.name}] 未连接 — HTTP 服务可能不可用，请检查服务地址"}
        result = await self._rpc("tools/call", {"name": name, "arguments": arguments})
        return result or {"error": f"[{self.name}] 调用工具 '{name}' 无响应 — 服务可能已超时或断开"}

    @property
    def tools(self) -> list[dict]:
        return self._tools

    def _expand_env_vars(self, value: str) -> str:
        """Expand ${VAR} / $VAR references in header values from process env."""
        return os.path.expandvars(value)

    def _build_headers(self) -> dict:
        h = {"Content-Type": "application/json", "Accept": "application/json, text/event-stream"}
        h.update({k: self._expand_env_vars(v) if isinstance(v, str) else v for k, v in self.headers.items()})
        if self._session_id:
            h["Mcp-Session-Id"] = self._session_id
        return h

    async def _post(self, body: dict) -> dict | None:
        """POST JSON-RPC message, handle both JSON and SSE responses."""
        resp = await self._client.post(self.url, json=body, headers=self._build_headers())

        # Streamable HTTP MCP servers commonly return the session id in the
        # Mcp-Session-Id response header during initialize. Preserve it so
        # subsequent notifications and tool requests do not fail with
        # session_required.
        session_id = resp.headers.get("mcp-session-id") or resp.headers.get("Mcp-Session-Id")
        if session_id:
            self._session_id = session_id

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
                logger.error(f"[{self.name}] RPC 错误: {resp['error']}")
                return None
            return resp.get("result")
        except Exception as e:
            logger.error(f"[{self.name}] RPC 调用失败: {e}")
            return None

    async def _notify(self, method: str, params: dict):
        """Send JSON-RPC notification."""
        msg = {"jsonrpc": "2.0", "method": method, "params": params}
        try:
            await self._post(msg)
        except Exception as e:
            logger.error(f"[{self.name}] 通知发送失败: {e}")


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
            logger.warning(f"[{name}] 配置格式错误 — 需要 'command'（stdio 模式）或 'url'（HTTP 模式）")
            return False

        ok = await server.start()
        if ok:
            self._servers[name] = server
            self._stopped.discard(name)
            for tool in server.tools:
                tname = tool["name"]
                if tname in self._tool_to_server:
                    logger.warning(f"[{name}] 工具名冲突: '{tname}' 已被 "
                                   f"'{self._tool_to_server[tname]}' 注册，已跳过")
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
            return {"ok": False, "error": f"服务器 '{name}' 已存在，请先删除后再添加"}

        self._configs[name] = cfg
        ok = await self._start_server(name, cfg)
        if not ok:
            self._configs.pop(name, None)
            return {"ok": False, "error": f"启动服务器 '{name}' 失败。请检查配置：stdio 模式需要正确的 command 和 args，HTTP 模式需要正确的 url"}

        self._save_persistent_config()
        return {"ok": True, "tools": [t["name"] for t in self._servers[name].tools]}

    async def remove_server(self, name: str) -> dict:
        """Stop and remove an external server."""
        if name not in self._configs:
            return {"ok": False, "error": f"未找到服务器 '{name}'，请确认名称是否正确"}

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
            return {"ok": False, "error": f"未找到服务器 '{name}'，请确认名称是否正确"}
        if name in self._servers and self._servers[name].connected:
            return {"ok": False, "error": f"服务器 '{name}' 已在运行中"}

        ok = await self._start_server(name, self._configs[name])
        if not ok:
            return {"ok": False, "error": f"启动服务器 '{name}' 失败，请检查配置和依赖是否正确"}
        return {"ok": True, "tools": [t["name"] for t in self._servers[name].tools]}

    async def stop_server(self, name: str) -> dict:
        """Stop a running server without removing config."""
        if name not in self._configs:
            return {"ok": False, "error": f"未找到服务器 '{name}'，请确认名称是否正确"}

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
        """Write current mcpServers config back to mcp.json (atomic write)."""
        if not self._config_path:
            return
        try:
            with open(self._config_path, encoding='utf-8') as f:
                data = json.load(f)
        except (FileNotFoundError, json.JSONDecodeError):
            data = {}

        data["mcpServers"] = self._configs
        tmp_path = self._config_path.with_suffix('.tmp')
        try:
            with open(tmp_path, 'w', encoding='utf-8') as f:
                json.dump(data, f, indent=2, ensure_ascii=False)
                f.write('\n')
            tmp_path.replace(self._config_path)
            logger.info(f"配置已保存到 {self._config_path}")
        except Exception as e:
            logger.error(f"保存配置失败: {e}")
            # Clean up temp file if it exists
            try:
                tmp_path.unlink(missing_ok=True)
            except Exception:
                pass

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
            return {"error": f"外部工具 '{tool_name}' 未找到 — 对应的 MCP 服务器可能未启动或已被移除"}
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
