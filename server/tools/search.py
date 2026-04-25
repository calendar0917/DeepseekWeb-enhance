"""Web search and crawl tools."""

from __future__ import annotations

from typing import Any

import httpx
from bs4 import BeautifulSoup


async def bing_search(query: str, count: int = 10, offset: int = 0, api_key: str = "") -> str:
    """Search Bing and return results as text."""
    if not api_key:
        return "Error: Bing API key not configured. Set bing_api_key in mcp.json."

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
            return "No results found."

        lines: list[str] = []
        for i, r in enumerate(results, offset + 1):
            lines.append(f"{i}. {r.get('name', '')}")
            lines.append(f"   URL: {r.get('url', '')}")
            lines.append(f"   {r.get('snippet', '')}")
            lines.append("")

        return "\n".join(lines)
    except httpx.HTTPError as e:
        return f"Search error: {e}"


async def crawl_webpage(url: str, max_length: int = 10000) -> str:
    """Fetch a webpage and extract text content."""
    try:
        async with httpx.AsyncClient(timeout=15, follow_redirects=True) as client:
            resp = await client.get(url, headers={"User-Agent": "Mozilla/5.0 (compatible; DS-Enhance/1.0)"})
            resp.raise_for_status()

        soup = BeautifulSoup(resp.text, "html.parser")
        for tag in soup(["script", "style", "nav", "footer", "header"]):
            tag.decompose()
        text = soup.get_text(separator="\n", strip=True)
        lines = [line.strip() for line in text.splitlines() if line.strip()]
        text = "\n".join(lines)
        if len(text) > max_length:
            text = text[:max_length] + f"\n\n... (truncated, {len(text):,} total characters)"
        return text
    except Exception as e:
        return f"Crawl error: {e}"


TOOL_DEFINITIONS: list[dict[str, Any]] = [
    {
        "name": "bing_search",
        "description": "Search the web using Bing",
        "inputSchema": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "Search query"},
                "count": {"type": "integer", "description": "Number of results (default 10, max 50)"},
                "offset": {"type": "integer", "description": "Pagination offset (default 0)"},
            },
            "required": ["query"],
        },
    },
    {
        "name": "crawl_webpage",
        "description": "Fetch and extract text content from a web page",
        "inputSchema": {
            "type": "object",
            "properties": {
                "url": {"type": "string", "description": "URL to fetch"},
                "max_length": {"type": "integer", "description": "Max characters to return (default 10000)"},
            },
            "required": ["url"],
        },
    },
]

ASYNC_HANDLERS: dict[str, Any] = {
    "bing_search": bing_search,
    "crawl_webpage": crawl_webpage,
}
