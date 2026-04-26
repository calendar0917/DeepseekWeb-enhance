"""Web search and crawl tools."""

from __future__ import annotations

from typing import Any

import httpx
from bs4 import BeautifulSoup


async def bing_search(query: str, count: int = 10, offset: int = 0, api_key: str = "") -> str:
    """Search Bing and return results as text."""
    if not api_key:
        return "错误：未配置 Bing 搜索 API 密钥。请在 mcp.json 的 services.web_search.config.bing_api_key 中填入 API Key"

    url = "https://api.bing.microsoft.com/v7.0/search"
    headers = {"Ocp-Apim-Subscription-Key": api_key}
    params = {"q": query, "count": min(count, 50), "offset": offset, "mkt": "zh-CN"}

    try:
        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.get(url, headers=headers, params=params)
            resp.raise_for_status()
            data = resp.json()

        results = data.get("webPages", {}).get("value", [])
        if not results:
            return "搜索无结果。请尝试调整关键词后重试"

        lines: list[str] = []
        for i, r in enumerate(results, offset + 1):
            lines.append(f"{i}. {r.get('name', '')}")
            lines.append(f"   URL: {r.get('url', '')}")
            lines.append(f"   {r.get('snippet', '')}")
            lines.append("")

        return "\n".join(lines)
    except httpx.HTTPError as e:
        return f"搜索请求失败: {e}。请检查网络连接和 API 密钥是否正确"


async def crawl_webpage(url: str, max_length: int = 10000) -> str:
    """Fetch a webpage and extract text content."""
    try:
        async with httpx.AsyncClient(timeout=15, follow_redirects=True) as client:
            resp = await client.get(url, headers={"User-Agent": "Mozilla/5.0 (compatible; DS-Enhance/1.0)"})
            resp.raise_for_status()

        soup = BeautifulSoup(resp.text, "html.parser")
        # Remove scripts and styles
        for tag in soup(["script", "style", "nav", "footer", "header"]):
            tag.decompose()
        text = soup.get_text(separator="\n", strip=True)
        # Collapse multiple blank lines
        lines = [line.strip() for line in text.splitlines() if line.strip()]
        text = "\n".join(lines)
        if len(text) > max_length:
            text = text[:max_length] + f"\n\n... (已截断，原文共 {len(text):,} 个字符)"
        return text
    except Exception as e:
        return f"网页抓取失败: {e}。目标页面可能无法访问或响应超时"


TOOL_DEFINITIONS: list[dict[str, Any]] = [
    {
        "name": "bing_search",
        "description": "使用 Bing 搜索网页内容",
        "inputSchema": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "搜索关键词"},
                "count": {"type": "integer", "description": "返回结果数量（默认 10，最大 50）"},
                "offset": {"type": "integer", "description": "分页偏移量（默认 0）"},
            },
            "required": ["query"],
        },
    },
    {
        "name": "crawl_webpage",
        "description": "抓取网页并提取纯文本内容",
        "inputSchema": {
            "type": "object",
            "properties": {
                "url": {"type": "string", "description": "要抓取的网页 URL"},
                "max_length": {"type": "integer", "description": "最大返回字符数（默认 10000）"},
            },
            "required": ["url"],
        },
    },
]

ASYNC_HANDLERS: dict[str, Any] = {
    "bing_search": bing_search,
    "crawl_webpage": crawl_webpage,
}
