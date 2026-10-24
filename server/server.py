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

import copy
import json
import uuid
import argparse
import inspect
import logging
import sys
from pathlib import Path
from contextlib import asynccontextmanager
from datetime import datetime, timedelta
import asyncio
from typing import Any

from fastapi import FastAPI, Request, UploadFile, File
from fastapi.responses import JSONResponse, StreamingResponse, Response
from fastapi.middleware.cors import CORSMiddleware

# Import tool modules
from tools.shell import TOOL_DEFINITIONS as SHELL_TOOLS, HANDLERS as SHELL_HANDLERS
from tools.search import TOOL_DEFINITIONS as SEARCH_TOOLS, ASYNC_HANDLERS as SEARCH_HANDLERS
from tools.mcp_external import ExternalMCPProxy
from tools.tts import TOOL_DEFINITIONS as TTS_TOOLS, tts_synthesize, list_edge_voices
from tools.file_processor import process_file

__version__ = "4.0.1"

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
PRESETS_PATH = Path(__file__).parent / "presets.json"


def load_config(path: Path = CONFIG_PATH) -> dict[str, Any]:
    try:
        with open(path, encoding='utf-8') as f:
            return json.load(f)
    except FileNotFoundError:
        logger.warning(f"Config not found at {path}, using defaults")
        return {"server": {"host": "0.0.0.0", "port": 8024}, "services": {}}
    except json.JSONDecodeError as e:
        logger.error(f"配置文件格式错误: {e}")
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

# TTS tools (async)
for tool_def in TTS_TOOLS:
    ALL_TOOLS[tool_def["name"]] = tool_def

# TTS 工具实际处理器（原实现只注册了定义、没有 handler，
# 导致 tools/list 能看到 tts_synthesize 但调用必报“没有对应的处理器”）
_TTS_OUTPUT_DIR = Path(__file__).parent / "tts_output"


async def _handle_tts_synthesize(
    text: str,
    voice: str = "zh-CN-XiaoxiaoNeural",
    provider: str = "edge",
) -> str:
    tts_cfg = config.get("services", {}).get("tts", {}).get("config", {}) or {}
    audio = await tts_synthesize(text=text, voice=voice, provider=provider, config=tts_cfg)
    _TTS_OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    out_path = _TTS_OUTPUT_DIR / f"tts_{datetime.now():%Y%m%d_%H%M%S}_{uuid.uuid4().hex[:6]}.mp3"
    out_path.write_bytes(audio)
    return f"语音合成完成：{len(audio):,} 字节 MP3 已保存到 {out_path}"


ASYNC_HANDLERS_MAP["tts_synthesize"] = _handle_tts_synthesize

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

# ─── Argument Sanitizing (fix for {"input": "<json>"} wrapper) ─
_WRAPPER_KEYS = ("input", "arguments", "args", "params")

_ARG_ALIASES: dict[str, tuple[str, ...]] = {
    "path": ("file_path", "filepath", "filename", "file", "target_path"),
    "content": ("contents", "data", "body"),
    "command": ("cmd", "shell_command"),
    "url": ("link", "href"),
    "query": ("q", "keyword", "keywords"),
}

# 这些参数允许传空字符串（写空文件 / 空文本）
_ALLOW_EMPTY = {"content", "text"}


def _unwrap_arguments(arguments: Any) -> dict[str, Any]:
    """把各种非标准参数包装逐层解开，返回干净的 dict。

    兼容以下客户端行为：
      1. arguments 本身是 JSON 字符串: "{\"path\": \"a.txt\"}"
      2. {"input": "<json字符串>"} 或 {"input": {...}} 包装（可多层嵌套）
      3. {"arguments": {...}} / {"args": {...}} / {"params": {...}} 包装

    历史 bug：旧实现只处理 dict，遇到字符串参数直接返回 {}，导致
    write_file 收到空 path，路径被解析成工作区根目录（一个目录），
    写入时抛 PermissionError [Errno 13]，看起来就像“权限不足并输出工作目录”。
    """
    for _ in range(6):
        if isinstance(arguments, str):
            text = arguments.strip()
            if not text:
                return {}
            try:
                arguments = json.loads(text)
            except json.JSONDecodeError:
                return {}
            continue

        if isinstance(arguments, dict) and len(arguments) == 1:
            only_key = next(iter(arguments))
            if only_key in _WRAPPER_KEYS:
                inner = arguments[only_key]
                if isinstance(inner, str) and not inner.strip():
                    return {}
                arguments = inner
                continue
        break

    return arguments if isinstance(arguments, dict) else {}


def _apply_arg_aliases(tool_name: str, arguments: dict[str, Any]) -> dict[str, Any]:
    """将常见参数别名映射到工具 schema 里的正式名称。

    只对目标工具 schema 真正声明了的参数生效，不会给 tts 这类
    同时有 text 参数的工具多塞一个 content（否则会被 _filter_kwargs 判为异常参数）。
    """
    props = ((ALL_TOOLS.get(tool_name) or {}).get("inputSchema") or {}).get("properties") or {}
    if not props or not arguments:
        return arguments

    fixed = dict(arguments)
    for canonical, aliases in _ARG_ALIASES.items():
        if canonical not in props:
            continue
        if fixed.get(canonical) not in (None, ""):
            continue
        for alias in aliases:
            if fixed.get(alias) not in (None, ""):
                fixed[canonical] = fixed.pop(alias)
                logger.warning(f"参数别名兼容: '{alias}' -> '{canonical}' (工具 {tool_name})")
                break
    return fixed


def _filter_kwargs(handler: Any, kwargs: dict[str, Any], tool_name: str) -> tuple[dict[str, Any], str | None]:
    """按 handler 签名过滤 kwargs，返回 (可调用参数, 错误信息)。

    - handler 接受 **kwargs 时原样放行
    - 否则丢弃未知参数并给出明确提示，避免裸 TypeError
    - 检查必填参数是否缺失
    """
    try:
        sig = inspect.signature(handler)
    except (TypeError, ValueError):
        return dict(kwargs), None

    params = sig.parameters
    if any(p.kind == inspect.Parameter.VAR_KEYWORD for p in params.values()):
        return dict(kwargs), None

    accepted = {k: v for k, v in kwargs.items() if k in params}
    dropped = sorted(set(kwargs) - set(accepted))
    if dropped:
        return accepted, (
            f"工具 '{tool_name}' 参数不匹配，已忽略未知参数: {dropped}；"
            f"该工具期望参数: {[p for p in params if p != 'api_key']}"
        )

    missing = [
        n for n, p in params.items()
        if p.default is inspect.Parameter.empty
        and p.kind in (inspect.Parameter.POSITIONAL_OR_KEYWORD, inspect.Parameter.KEYWORD_ONLY)
        and n not in accepted
    ]
    if missing:
        return accepted, f"工具 '{tool_name}' 缺少必填参数: {missing}"

    return accepted, None


def _validate_required(tool_name: str, arguments: dict[str, Any]) -> str | None:
    """按工具 schema 的 required 字段校验必填参数，返回错误文本或 None。"""
    schema = ((ALL_TOOLS.get(tool_name) or {}).get("inputSchema")) or {}
    props = schema.get("properties") or {}
    missing = []
    for key in schema.get("required") or []:
        value = arguments.get(key)
        if value is None:
            missing.append(key)
        elif key not in _ALLOW_EMPTY and isinstance(value, str) and not value.strip():
            missing.append(key)
    if not missing:
        return None
    details = "; ".join(
        f"{m} — {props.get(m, {}).get('description', '无说明')}" for m in missing
    )
    return f"工具 '{tool_name}' 缺少必填参数: {missing}。参数说明: {details}"


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

app = FastAPI(title="DS MCP Bridge", version=__version__, lifespan=lifespan)

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
        return JSONResponse({"jsonrpc": "2.0", "error": {"code": -32700, "message": "请求体 JSON 解析失败，请确认发送了有效的 JSON 数据"}, "id": None}, status_code=400)

    # Handle batch
    if isinstance(body, list):
        results = []
        for msg in body:
            result = await handle_jsonrpc(msg)
            if result is not None:
                results.append(result)
        if not results:
            return Response(status_code=202)
        return JSONResponse(results)

    result = await handle_jsonrpc(body)
    if result is None:
        return Response(status_code=202)
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
        return JSONResponse({"ok": False, "error": "请求体 JSON 格式无效"}, status_code=400)

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
                results.append({"name": srv_name, "ok": False, "error": "配置格式无效 — 必须是一个 JSON 对象"})
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
        return JSONResponse({"ok": False, "error": "缺少 'name' 字段，请为 MCP 服务器指定一个名称"}, status_code=400)

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


# ─── Preset Marketplace API ────────────────────────────────────

def load_presets() -> list[dict]:
    try:
        with open(PRESETS_PATH, encoding='utf-8') as f:
            return json.load(f).get("presets", [])
    except (FileNotFoundError, json.JSONDecodeError):
        return []


@app.get("/api/presets")
async def list_presets():
    """Return available presets, marking which are already installed."""
    presets = load_presets()
    installed = set(external_proxy._configs.keys())
    result = []
    for p in presets:
        entry = {**p, "installed": p["id"] in installed}
        result.append(entry)
    return {"presets": result}


@app.post("/api/presets/{preset_id}/install")
async def install_preset(preset_id: str, request: Request):
    """Install a preset by ID, substituting user-provided params."""
    presets = load_presets()
    preset = next((p for p in presets if p["id"] == preset_id), None)
    if not preset:
        return JSONResponse({"ok": False, "error": f"预设 '{preset_id}' 不存在，请检查预设 ID 是否正确"}, status_code=404)

    try:
        body = await request.json()
    except Exception:
        body = {}
    user_params = body.get("params", {})

    # Validate required params
    missing = []
    for param in preset.get("params", []):
        if param["required"] and not user_params.get(param["key"]):
            missing.append(param["label"])
    if missing:
        return JSONResponse(
            {"ok": False, "error": f"缺少必填参数: {', '.join(missing)}，请补充这些参数后重试"},
            status_code=400,
        )

    # Deep copy config and substitute {{KEY}} placeholders
    cfg = copy.deepcopy(preset["config"])

    def substitute(obj):
        if isinstance(obj, str):
            for key, val in user_params.items():
                obj = obj.replace(f"{{{{{key}}}}}", val)
            return obj
        if isinstance(obj, list):
            return [substitute(item) for item in obj]
        if isinstance(obj, dict):
            return {k: substitute(v) for k, v in obj.items()}
        return obj

    cfg = substitute(cfg)

    # Remove env entries that have unresolved placeholders
    if "env" in cfg:
        cfg["env"] = {k: v for k, v in cfg["env"].items() if "{{" not in v}

    # Use preset name as server name (sanitize for ID)
    server_name = preset_id

    # If already installed, remove first (re-install)
    if server_name in external_proxy._configs:
        await external_proxy.remove_server(server_name)

    try:
        result = await external_proxy.add_server(server_name, cfg)
    except Exception as e:
        logger.error(f"安装预设失败: {e}")
        return JSONResponse({"ok": False, "error": f"安装预设时出错: {e}。请检查依赖是否已安装（如 npx、node 等）"}, status_code=500)

    status_code = 200 if result["ok"] else 400
    return JSONResponse(result, status_code=status_code)


async def handle_jsonrpc(msg: dict):
    """Process a single JSON-RPC 2.0 message."""
    method = msg.get("method", "")
    msg_id = msg.get("id")
    params = msg.get("params", {}) or {}

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
                "serverInfo": {"name": "ds-mcp-bridge", "version": __version__},
                "sessionId": session_id,
            },
        }

    # MCP 规范定义的健康检查方法。旧实现直接落到 "未知方法" 分支。
    if method == "ping":
        return {"jsonrpc": "2.0", "id": msg_id, "result": {}}

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
        tool_name = params.get("name", "") or ""
        if not tool_name:
            # 旧实现会继续往下走，最终报出让人摸不着头脑的 "工具 '' 未启用"
            return {
                "jsonrpc": "2.0",
                "id": msg_id,
                "error": {
                    "code": -32602,
                    "message": "缺少 'name' 参数：tools/call 必须在 params.name 中指定工具名（可用 tools/list 查询）",
                },
            }
        raw_arguments = params.get("arguments", {})
        arguments = _apply_arg_aliases(tool_name, _unwrap_arguments(raw_arguments))
        if raw_arguments != arguments:
            logger.warning(
                f"已解包异常参数包装: {json.dumps(raw_arguments, ensure_ascii=False)[:200]} "
                f"-> {json.dumps(arguments, ensure_ascii=False)[:200]}"
            )

        # Check external tools first
        if tool_name in external_proxy.get_all_tool_names():
            logger.info(f"外部工具调用: {tool_name}({json.dumps(arguments, ensure_ascii=False)[:200]})")
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
                logger.error(f"外部工具调用失败: {e}")
                return {
                    "jsonrpc": "2.0",
                    "id": msg_id,
                    "result": {"content": [{"type": "text", "text": f"外部工具调用异常: {e}"}], "isError": True},
                }

        if tool_name not in enabled_tools:
            return {
                "jsonrpc": "2.0",
                "id": msg_id,
                "result": {"content": [{"type": "text", "text": f"工具 '{tool_name}' 未启用。请在 mcp.json 的 services 配置中启用该工具，或联系管理员"}], "isError": True},
            }

        logger.info(f"工具调用: {tool_name}({json.dumps(arguments, ensure_ascii=False)[:200]})")

        cleanup_expired_sessions()

        required_error = _validate_required(tool_name, arguments)
        if required_error:
            logger.error(f"参数校验失败: {required_error}")
            return {
                "jsonrpc": "2.0",
                "id": msg_id,
                "result": {"content": [{"type": "text", "text": required_error}], "isError": True},
            }

        try:
            if tool_name in ASYNC_HANDLERS_MAP:
                # Async handler: 展开成关键字参数
                handler = ASYNC_HANDLERS_MAP[tool_name]
                call_kwargs = dict(arguments)
                # Pass api_key from config if the tool needs it
                if tool_name == "bing_search":
                    svc_cfg = config.get("services", {}).get("web_search", {}).get("config", {})
                    call_kwargs.setdefault("api_key", svc_cfg.get("bing_api_key", ""))

                checked_kwargs, arg_error = _filter_kwargs(handler, call_kwargs, tool_name)
                if arg_error:
                    logger.error(f"参数校验失败: {arg_error}")
                    result_text = arg_error
                    is_error = True
                else:
                    result_text = await handler(**checked_kwargs)
                    is_error = False
            elif tool_name in SYNC_HANDLERS:
                # Sync handler: 传入整个参数 dict
                result_text = SYNC_HANDLERS[tool_name](arguments)
                is_error = False
            else:
                result_text = f"工具 '{tool_name}' 没有对应的处理器，可能是配置错误"
                is_error = True

            return {
                "jsonrpc": "2.0",
                "id": msg_id,
                "result": {"content": [{"type": "text", "text": str(result_text)}], "isError": is_error},
            }
        except Exception as e:
            logger.error(f"工具执行失败: {e}")
            return {
                "jsonrpc": "2.0",
                "id": msg_id,
                "result": {"content": [{"type": "text", "text": f"工具执行异常: {e}"}], "isError": True},
            }

    # Unknown method
    return {
        "jsonrpc": "2.0",
        "id": msg_id,
        "error": {"code": -32601, "message": f"未知的 MCP 方法: '{method}'。支持的方法: initialize, tools/list, tools/call"},
    }



# ─── TTS Upload Queue ──────────────────────────────────────────
# Upload queue uses asyncio.Semaphore (see below)

_upload_semaphore = asyncio.Semaphore(3)


# ─── API: TTS ──────────────────────────────────────────────────
@app.post("/api/tts")
async def api_tts(request: Request):
    """Synthesize text to speech, return MP3 audio bytes."""
    try:
        body = await request.json()
    except Exception:
        return JSONResponse({"error": "请求体 JSON 格式无效"}, status_code=400)

    text = body.get("text", "").strip()
    if not text:
        return JSONResponse({"error": "缺少 'text' 字段，请提供要朗读的文本内容"}, status_code=400)

    voice = body.get("voice", "xiaoxiao")
    provider = body.get("provider", "edge")

    # Build provider config: request body > mcp.json > defaults
    tts_cfg = config.get("services", {}).get("tts", {}).get("config", {})
    provider_config = {}
    if provider == "openai":
        provider_config["api_key"] = body.get("api_key", "") or tts_cfg.get("api_key", "")
        provider_config["base_url"] = body.get("base_url", "") or tts_cfg.get("base_url", "https://api.openai.com/v1")
        provider_config["model"] = body.get("model", "") or tts_cfg.get("model", "tts-1")
    elif provider == "http":
        provider_config["url"] = body.get("url", "") or tts_cfg.get("url", "")
        provider_config["api_key"] = body.get("api_key", "") or tts_cfg.get("api_key", "")
        provider_config["headers"] = tts_cfg.get("headers")
        provider_config["body_template"] = tts_cfg.get("body_template")

    try:
        audio = await tts_synthesize(
            text=text,
            voice=voice,
            provider=provider,
            config=provider_config,
        )
        return Response(
            content=audio,
            media_type="audio/mpeg",
            headers={"Content-Disposition": "inline; filename=tts.mp3"},
        )
    except Exception as e:
        logger.error(f"TTS 合成失败: {e}")
        return JSONResponse({"error": f"语音合成失败: {e}"}, status_code=500)




# ─── API: TTS Voices ──────────────────────────────────────────
@app.get("/api/tts/voices")
async def api_tts_voices():
    """List available Edge TTS voices."""
    voices = await list_edge_voices()
    return JSONResponse({"voices": voices})

# ─── API: File Upload ──────────────────────────────────────────
@app.post("/api/upload")
async def api_upload(file: UploadFile = File(...)):
    """Process an uploaded file, return extracted text and metadata."""
    if not file.filename:
        return JSONResponse({"error": "未提供文件名，请确保上传请求中包含文件"}, status_code=400)

    try:
        file_bytes = await file.read()
    except Exception as e:
        return JSONResponse({"error": f"读取上传文件失败: {e}"}, status_code=400)

    if not file_bytes:
        return JSONResponse({"error": "上传的文件内容为空"}, status_code=400)

    # Enforce concurrency limit — wait up to 5s for a free slot (旧实现用 _value 探测，有竞态)
    try:
        await asyncio.wait_for(_upload_semaphore.acquire(), timeout=5)
    except asyncio.TimeoutError:
        return JSONResponse(
            {"error": "上传队列已满（最多 3 个并发），请稍后重试", "queue_full": True},
            status_code=429,
        )

    try:
        result = process_file(
            file_bytes=file_bytes,
            filename=file.filename,
            mime_type=file.content_type or "",
        )
        return JSONResponse(result.to_dict())
    except Exception as e:
        logger.error(f"文件处理失败: {e}")
        return JSONResponse({"error": f"文件处理失败: {e}"}, status_code=500)
    finally:
        _upload_semaphore.release()


# ─── API: Upload Queue Status ──────────────────────────────────
@app.get("/api/upload/status")
async def api_upload_status():
    """Return upload queue status."""
    available = getattr(_upload_semaphore, "_value", -1)
    return JSONResponse({
        "max_concurrent": 3,
        "available_slots": available,
    })



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
        config_path = Path(args.config).resolve()
        config = load_config(config_path)
        enabled_tools.clear()
        for svc in config.get("services", {}).values():
            if svc.get("type") == "builtin":
                enabled_tools.update(svc.get("tools", []))
        # 外部 MCP 服务器的增删也要写回同一个配置文件
        external_proxy._config_path = config_path
        logger.info(f"Using config: {config_path}")

    logger.info(f"Starting server on {args.host}:{args.port}")
    uvicorn.run(app, host=args.host, port=args.port, log_level="info")