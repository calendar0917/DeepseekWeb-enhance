"""Text-to-Speech tools — Edge TTS (free) + OpenAI TTS + External HTTP TTS."""

from __future__ import annotations

import io
import json
import logging
from typing import Any

import httpx

logger = logging.getLogger("ds-mcp-bridge.tts")

# ─── Edge TTS Provider ─────────────────────────────────────────

async def _edge_tts_synthesize(text: str, voice: str, **kwargs) -> bytes:
    """Synthesize using edge-tts — single pass, no splitting."""
    try:
        import edge_tts
    except ImportError:
        raise RuntimeError("Edge TTS 依赖未安装。请运行: pip install edge-tts")

    communicate = edge_tts.Communicate(text, voice)
    buf = io.BytesIO()
    async for chunk in communicate.stream():
        if chunk["type"] == "audio":
            buf.write(chunk["data"])
    audio = buf.getvalue()
    if not audio:
        raise RuntimeError("Edge TTS 返回了空音频数据，请检查文本内容和语音名称是否正确")
    return audio


# ─── OpenAI-Compatible TTS Provider ────────────────────────────

async def _openai_tts_synthesize(
    text: str,
    voice: str,
    api_key: str = "",
    base_url: str = "https://api.openai.com/v1",
    model: str = "tts-1",
    **kwargs,
) -> bytes:
    """Synthesize using OpenAI-compatible TTS API."""
    if not api_key:
        raise RuntimeError("OpenAI TTS 需要 API 密钥。请在请求中提供 api_key 或在 mcp.json 的 services.tts.config.api_key 中配置")

    url = base_url.rstrip("/") + "/audio/speech"
    headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
    payload = {"model": model, "input": text, "voice": voice, "response_format": "mp3"}

    async with httpx.AsyncClient(timeout=120) as client:
        resp = await client.post(url, headers=headers, json=payload)
        if resp.status_code != 200:
            raise RuntimeError(f"OpenAI TTS 接口返回错误 (HTTP {resp.status_code}): {resp.text[:200]}。请检查 API 密钥、模型名称和 base_url 是否正确")
        if not resp.content:
            raise RuntimeError("OpenAI TTS 接口返回了空音频数据，请检查文本内容是否过长或包含不支持的字符")
        return resp.content


# ─── Generic HTTP TTS Provider ─────────────────────────────────

async def _http_tts_synthesize(
    text: str,
    voice: str,
    url: str = "",
    api_key: str = "",
    headers: dict | None = None,
    body_template: dict | None = None,
    **kwargs,
) -> bytes:
    """Generic HTTP TTS provider."""
    if not url:
        raise RuntimeError("HTTP TTS 需要在配置中指定 'url' 参数。请在 mcp.json 的 services.tts.config.url 中填写 TTS 服务地址")

    req_headers = {"Content-Type": "application/json"}
    if api_key:
        req_headers["Authorization"] = f"Bearer {api_key}"
    if headers:
        req_headers.update(headers)

    if body_template:
        body_str = json.dumps(body_template).replace("{text}", text).replace("{voice}", voice)
        body = json.loads(body_str)
    else:
        body = {"text": text, "voice": voice}

    async with httpx.AsyncClient(timeout=120) as client:
        resp = await client.post(url, headers=req_headers, json=body)
        if resp.status_code != 200:
            raise RuntimeError(f"自定义 TTS 服务返回错误 (HTTP {resp.status_code}): {resp.text[:200]}。请检查 TTS 服务地址和参数配置是否正确")

        ct = resp.headers.get("content-type", "")
        if "audio" in ct or "octet-stream" in ct:
            return resp.content

        try:
            data = resp.json()
            audio_url = data.get("audio_url") or data.get("url")
            if audio_url and audio_url.startswith("http"):
                return (await client.get(audio_url)).content
            import base64
            b64 = data.get("audio_base64") or data.get("data")
            if b64:
                return base64.b64decode(b64)
        except (json.JSONDecodeError, KeyError):
            pass
        return resp.content


# ─── Provider Registry ─────────────────────────────────────────

PROVIDERS = {
    "edge": _edge_tts_synthesize,
    "openai": _openai_tts_synthesize,
    "http": _http_tts_synthesize,
}

# Edge TTS Chinese voices
EDGE_VOICES = {
    "xiaoxiao": "zh-CN-XiaoxiaoNeural",
    "xiaoyi": "zh-CN-XiaoyiNeural",
    "yunjian": "zh-CN-YunjianNeural",
    "yunxi": "zh-CN-YunxiNeural",
    "yunxia": "zh-CN-YunxiaNeural",
    "yunyang": "zh-CN-YunyangNeural",
}


async def tts_synthesize(
    text: str,
    voice: str = "zh-CN-XiaoxiaoNeural",
    provider: str = "edge",
    config: dict | None = None,
) -> bytes:
    """
    Synthesize text to MP3 audio bytes in a single pass.
    No chunking — let the provider handle long text natively.
    """
    if not text or not text.strip():
        raise ValueError("待朗读的文本不能为空")

    config = config or {}
    logger.info(f"TTS: provider={provider}, voice={voice}, chars={len(text)}")

    if provider == "edge":
        edge_voice = EDGE_VOICES.get(voice, voice)
        return await _edge_tts_synthesize(text, edge_voice)

    elif provider == "openai":
        return await _openai_tts_synthesize(
            text, voice,
            api_key=config.get("api_key", ""),
            base_url=config.get("base_url", "https://api.openai.com/v1"),
            model=config.get("model", "tts-1"),
        )

    elif provider == "http":
        return await _http_tts_synthesize(
            text, voice,
            url=config.get("url", ""),
            api_key=config.get("api_key", ""),
            headers=config.get("headers"),
            body_template=config.get("body_template"),
        )

    else:
        raise ValueError(f"未知的 TTS 引擎: '{provider}'。可选引擎: {list(PROVIDERS.keys())}")


# ─── Voice listing ─────────────────────────────────────────────

async def list_edge_voices() -> list[dict[str, str]]:
    """List all available Edge TTS voices."""
    try:
        import edge_tts
        voices = await edge_tts.list_voices()
        return [{"id": v["ShortName"], "gender": v["Gender"], "locale": v["Locale"]} for v in voices]
    except ImportError:
        return []


# ─── MCP Tool Definition ──────────────────────────────────────

TOOL_DEFINITIONS: list[dict[str, Any]] = [
    {
        "name": "tts_synthesize",
        "description": "将文本转为语音（MP3）。支持 Edge TTS（免费）、OpenAI 兼容 TTS、以及自定义 HTTP TTS。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "text": {"type": "string", "description": "要朗读的文本内容"},
                "voice": {"type": "string", "description": "声音名称", "default": "zh-CN-XiaoxiaoNeural"},
                "provider": {"type": "string", "enum": ["edge", "openai", "http"], "description": "TTS 提供者", "default": "edge"},
            },
            "required": ["text"],
        },
    }
]
