#!/usr/bin/env python3
"""
DS MCP Bridge — Server

HTTP server that implements MCP (Model Context Protocol) over JSON-RPC 2.0.
Bridges browser userscript requests to local tools.

Usage:
    python server.py                    # Run with defaults from mcp.json
    python server.py --port 9000        # Override port
    python server.py --config other.json
"""

from __future__ import annotations

import json
import uuid
import argparse
import logging
import sys
from pathlib import Path
from contextlib import asynccontextmanager
from datetime import datetime, timedelta
from typing import Any

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from fastapi.middleware.cors import CORSMiddleware

# Import tool modules
from tools.shell import TOOL_DEFINITIONS as SHELL_TOOLS, HANDLERS as SHELL_HANDLERS
from tools.search import TOOL_DEFINITIONS as SEARCH_TOOLS, ASYNC_HANDLERS as SEARCH_HANDLERS
from tools.mcp_external import ExternalMCPProxy

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[
        logging.StreamHandler(),
    ]
)
logger = logging.getLogger("ds-mcp-bridge")


def setup_file_logging(log_file: str | None) -> None:
    if log_file:
        file_handler = logging.FileHandler(log_file, encoding='utf-8')
        file_handler.setFormatter(logging.Formatter("%(asctime)s [%(levelname)s] %(message)s"))
        logger.addHandler(file_handler)
        logger.info(f"Logging to file: {log_file}")


# ─── Config ────────────────────────────────────────────────────
CONFIG_PATH = Path(__file__).parent / "mcp.json"


def load_config(path: Path = CONFIG_PATH) -> dict[str, Any]:
    try:
        with open(path, encoding='utf-8') as f:
            return json.load(f)
    except FileNotFoundError:
        logger.warning(f"Config not found at {path}, using defaults")
        return {"server": {"host": "0.0.0.0", "port": 8024}, "services": {}}
    except json.JSONDecodeError as e:
        logger.error(f"Invalid config: {e}")
        sys.exit(1)


config = load_config()
server_cfg = config.get("server", {})

# ─── Tool Registry ─────────────────────────────────────────────
ALL_TOOLS: dict[str, dict[str, Any]] = {}
SYNC_HANDLERS: dict[str, Any] = {}
ASYNC_HANDLERS_MAP: dict[str, Any] = {}

# Shell tools (sync)
for tool_def in SHELL_TOOLS:
    ALL_TOOLS[tool_def["name"]] = tool_def
for name, handler in SHELL_HANDLERS.items():
    SYNC_HANDLERS[name] = handler

# Search tools (async)
for tool_def in SEARCH_TOOLS:
    ALL_TOOLS[tool_def["name"]] = tool_def
for name, handler in SEARCH_HANDLERS.items():
    ASYNC_HANDLERS_MAP[name] = handler

# Filter tools based on config
enabled_tools = set()
for svc in config.get("services", {}).values():
    if svc.get("type") == "builtin":
        enabled_tools.update(svc.get("tools", []))

if not enabled_tools:
    # If no config filter, enable all
    enabled_tools = set(ALL_TOOLS.keys())

logger.info(f"Enabled tools: {sorted(enabled_tools)}")

# ─── External MCP Proxy ────────────────────────────────────────
external_proxy = ExternalMCPProxy(config_path=CONFIG_PATH)

# ─── Sessions ──────────────────────────────────────────────────
SESSION_TIMEOUT_MINUTES = 30
SESSION_MAX_COUNT = 100
sessions: dict[str, dict[str, Any]] = {}


def cleanup_expired_sessions() -> None:
    now = datetime.now()
    expired = [
        sid for sid, data in sessions.items()
        if data.get("last_activity") and now - data["last_activity"] > timedelta(minutes=SESSION_TIMEOUT_MINUTES)
    ]
    for sid in expired:
        del sessions[sid]
        logger.info(f"Session expired: {sid}")

    if len(sessions) > SESSION_MAX_COUNT:
        oldest = sorted(sessions.items(), key=lambda x: x[1].get("last_activity", datetime.min))[:len(sessions) - SESSION_MAX_COUNT]
        for sid, _ in oldest:
            del sessions[sid]
            logger.info(f"Session evicted (max count): {sid}")

# ─── App ───────────────────────────────────────────────────────
@asynccontextmanager
async def lifespan(application: FastAPI):
    # Startup: load external MCP servers
    mcp_servers = config.get("mcpServers", {})
    if mcp_servers:
        logger.info(f"Loading {len(mcp_servers)} external MCP server(s): {list(mcp_servers.keys())}")
        await external_proxy.load_config(mcp_servers)
    yield
    # Shutdown: stop external servers
    await external_proxy.stop_all()

app = FastAPI(title="DS MCP Bridge", version="2.0.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
async def health():
    ext_tools = external_proxy.get_all_tool_names()
    return {
        "status": "ok",
        "tools": len([t for t in ALL_TOOLS if t in enabled_tools]) + len(ext_tools),
        "builtin_tools": len([t for t in ALL_TOOLS if t in enabled_tools]),
        "external_tools": len(ext_tools),
        "external_servers": external_proxy.get_status(),
        "sessions": len(sessions),
    }


@app.post("/mcp")
async def mcp_endpoint(request: Request):
    try:
        body = await request.json()
    except Exception:
        return JSONResponse({"jsonrpc": "2.0", "error": {"code": -32700, "message": "Parse error"}, "id": None}, status_code=400)

    # Handle batch
    if isinstance(body, list):
        results = []
        for msg in body:
            result = await handle_jsonrpc(msg)
            if result is not None:
                results.append(result)
        return JSONResponse(results if results else None, status_code=202)

    result = await handle_jsonrpc(body)
    if result is None:
        return JSONResponse(None, status_code=202)
    return JSONResponse(result)


# ─── External Server Management API ────────────────────────────

@app.get("/api/external-servers")
async def list_external_servers():
    """List all external MCP servers and their status."""
    return {"servers": external_proxy.get_status()}


@app.post("/api/external-servers")
async def add_external_server(request: Request):
    """Add and start a new external MCP server.

    Body: {"name": "github", "command": "npx", "args": [...], "env": {...}}
      or: {"name": "remote", "url": "http://...", "headers": {...}}
      or: {"mcpServers": {"name1": {...}, "name2": {...}}} — batch import
    """
    try:
        body = await request.json()
    except Exception:
        return JSONResponse({"ok": False, "error": "Invalid JSON"}, status_code=400)

    # Detect batch format: mcpServers wrapper or {name: config, ...} map
    servers_map = None
    if "mcpServers" in body and isinstance(body["mcpServers"], dict):
        servers_map = body["mcpServers"]
    elif "servers" in body and isinstance(body["servers"], dict):
        servers_map = body["servers"]

    # Batch import
    if servers_map:
        results = []
        for srv_name, srv_cfg in servers_map.items():
            if not isinstance(srv_cfg, dict):
                results.append({"name": srv_name, "ok": False, "error": "Invalid config"})
                continue
            try:
                r = await external_proxy.add_server(srv_name, srv_cfg)
                results.append({"name": srv_name, **r})
            except Exception as e:
                results.append({"name": srv_name, "ok": False, "error": str(e)})
        return {"ok": all(r["ok"] for r in results), "results": results}

    # Single server format
    name = body.pop("name", "").strip()
    if not name:
        return JSONResponse({"ok": False, "error": "Missing 'name'"}, status_code=400)

    try:
        result = await external_proxy.add_server(name, body)
    except Exception as e:
        logger.error(f"add_server error: {e}")
        return JSONResponse({"ok": False, "error": str(e)}, status_code=500)

    status_code = 200 if result["ok"] else 400
    return JSONResponse(result, status_code=status_code)


@app.delete("/api/external-servers/{name}")
async def remove_external_server(name: str):
    """Stop and remove an external MCP server."""
    result = await external_proxy.remove_server(name)
    status_code = 200 if result["ok"] else 404
    return JSONResponse(result, status_code=status_code)


@app.post("/api/external-servers/{name}/start")
async def start_external_server(name: str):
    """Start a stopped external MCP server."""
    result = await external_proxy.start_server(name)
    status_code = 200 if result["ok"] else 400
    return JSONResponse(result, status_code=status_code)


@app.post("/api/external-servers/{name}/stop")
async def stop_external_server(name: str):
    """Stop a running external MCP server without removing config."""
    result = await external_proxy.stop_server(name)
    status_code = 200 if result["ok"] else 404
    return JSONResponse(result, status_code=status_code)


async def handle_jsonrpc(msg: dict):
    """Process a single JSON-RPC 2.0 message."""
    method = msg.get("method", "")
    msg_id = msg.get("id")
    params = msg.get("params", {})

    # Notifications have no id — acknowledge with 202
    if msg_id is None and method:
        logger.info(f"Notification: {method}")
        return None

    logger.info(f"Request: {method} (id={msg_id})")

    if method == "initialize":
        cleanup_expired_sessions()
        session_id = str(uuid.uuid4())
        sessions[session_id] = {"client": params.get("clientInfo", {}), "last_activity": datetime.now()}
        logger.info(f"Session created: {session_id}")
        return {
            "jsonrpc": "2.0",
            "id": msg_id,
            "result": {
                "protocolVersion": "2025-03-26",
                "capabilities": {"tools": {"listChanged": False}},
                "serverInfo": {"name": "ds-mcp-bridge", "version": "1.0.0"},
                "sessionId": session_id,
            },
        }

    if method == "tools/list":
        tools = [t for name, t in ALL_TOOLS.items() if name in enabled_tools]
        # Add external tools
        tools.extend(external_proxy.get_all_tools())
        return {
            "jsonrpc": "2.0",
            "id": msg_id,
            "result": {"tools": tools},
        }

    if method == "tools/call":
        tool_name = params.get("name", "")
        arguments = params.get("arguments", {})

        # Check external tools first
        if tool_name in external_proxy.get_all_tool_names():
            logger.info(f"External tool call: {tool_name}({json.dumps(arguments, ensure_ascii=False)[:200]})")
            try:
                ext_result = await external_proxy.call_tool(tool_name, arguments)
                if "error" in ext_result:
                    return {
                        "jsonrpc": "2.0",
                        "id": msg_id,
                        "result": {"content": [{"type": "text", "text": ext_result["error"]}], "isError": True},
                    }
                # External servers may return result in MCP format or raw
                if "content" in ext_result:
                    return {
                        "jsonrpc": "2.0",
                        "id": msg_id,
                        "result": ext_result,
                    }
                return {
                    "jsonrpc": "2.0",
                    "id": msg_id,
                    "result": {"content": [{"type": "text", "text": json.dumps(ext_result, ensure_ascii=False)}], "isError": False},
                }
            except Exception as e:
                logger.error(f"External tool error: {e}")
                return {
                    "jsonrpc": "2.0",
                    "id": msg_id,
                    "result": {"content": [{"type": "text", "text": f"Error: {e}"}], "isError": True},
                }

        if tool_name not in enabled_tools:
            return {
                "jsonrpc": "2.0",
                "id": msg_id,
                "result": {"content": [{"type": "text", "text": f"Error: tool '{tool_name}' not available"}], "isError": True},
            }

        logger.info(f"Tool call: {tool_name}({json.dumps(arguments, ensure_ascii=False)[:200]})")

        try:
            if tool_name in ASYNC_HANDLERS_MAP:
                # Async handler
                handler = ASYNC_HANDLERS_MAP[tool_name]
                # Pass api_key from config if the tool needs it
                if tool_name == "bing_search":
                    svc_cfg = config.get("services", {}).get("web_search", {}).get("config", {})
                    arguments.setdefault("api_key", svc_cfg.get("bing_api_key", ""))
                result_text = await handler(**arguments)
            elif tool_name in SYNC_HANDLERS:
                result_text = SYNC_HANDLERS[tool_name](arguments)
            else:
                result_text = f"Error: no handler for '{tool_name}'"

            return {
                "jsonrpc": "2.0",
                "id": msg_id,
                "result": {"content": [{"type": "text", "text": str(result_text)}], "isError": False},
            }
        except Exception as e:
            logger.error(f"Tool error: {e}")
            return {
                "jsonrpc": "2.0",
                "id": msg_id,
                "result": {"content": [{"type": "text", "text": f"Error: {e}"}], "isError": True},
            }

    # Unknown method
    return {
        "jsonrpc": "2.0",
        "id": msg_id,
        "error": {"code": -32601, "message": f"Method not found: {method}"},
    }


# ─── Main ──────────────────────────────────────────────────────
if __name__ == "__main__":
    import uvicorn

    parser = argparse.ArgumentParser(description="DS MCP Bridge Server")
    parser.add_argument("--host", default=server_cfg.get("host", "0.0.0.0"))
    parser.add_argument("--port", type=int, default=server_cfg.get("port", 8024))
    parser.add_argument("--config", type=str, default=None)
    parser.add_argument("--log-file", type=str, default=None, help="Log file path")
    args = parser.parse_args()

    setup_file_logging(args.log_file)

    if args.config:
        config = load_config(Path(args.config))
        enabled_tools.clear()
        for svc in config.get("services", {}).values():
            if svc.get("type") == "builtin":
                enabled_tools.update(svc.get("tools", []))

    logger.info(f"Starting server on {args.host}:{args.port}")
    uvicorn.run(app, host=args.host, port=args.port, log_level="info")
