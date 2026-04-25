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

import json
import uuid
import argparse
import logging
import sys
from pathlib import Path
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from fastapi.middleware.cors import CORSMiddleware

# Import tool modules
from tools.shell import TOOL_DEFINITIONS as SHELL_TOOLS, HANDLERS as SHELL_HANDLERS
from tools.search import TOOL_DEFINITIONS as SEARCH_TOOLS, ASYNC_HANDLERS as SEARCH_HANDLERS

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("ds-mcp-bridge")

# ─── Config ────────────────────────────────────────────────────
CONFIG_PATH = Path(__file__).parent / "mcp.json"


def load_config(path: Path = CONFIG_PATH) -> dict:
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
# Merge all tool definitions and handlers
ALL_TOOLS = {}
SYNC_HANDLERS = {}
ASYNC_HANDLERS_MAP = {}

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

# ─── Sessions ──────────────────────────────────────────────────
sessions: dict[str, dict] = {}

# ─── App ───────────────────────────────────────────────────────
app = FastAPI(title="DS MCP Bridge", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
async def health():
    return {
        "status": "ok",
        "tools": len([t for t in ALL_TOOLS if t in enabled_tools]),
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
        session_id = str(uuid.uuid4())
        sessions[session_id] = {"client": params.get("clientInfo", {})}
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
        return {
            "jsonrpc": "2.0",
            "id": msg_id,
            "result": {"tools": tools},
        }

    if method == "tools/call":
        tool_name = params.get("name", "")
        arguments = params.get("arguments", {})

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
    args = parser.parse_args()

    if args.config:
        config = load_config(Path(args.config))
        enabled_tools.clear()
        for svc in config.get("services", {}).values():
            if svc.get("type") == "builtin":
                enabled_tools.update(svc.get("tools", []))

    logger.info(f"Starting server on {args.host}:{args.port}")
    uvicorn.run(app, host=args.host, port=args.port, log_level="info")
