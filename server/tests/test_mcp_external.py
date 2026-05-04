"""Tests for external MCP server proxy."""

import pytest
import asyncio
import json
import sys
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

sys.path.insert(0, str(Path(__file__).parent.parent))

from tools.mcp_external import StdioMCPServer, HTTPMCPServer, ExternalMCPProxy


class TestHTTPMCPServer:
    """Test HTTP transport (no subprocess needed)."""

    @pytest.mark.asyncio
    async def test_http_start_and_tools(self):
        """Test HTTP server start with mocked _post method."""
        server = HTTPMCPServer(name="test-http", url="http://localhost:9999/mcp")

        call_count = 0

        async def mock_post(body):
            nonlocal call_count
            call_count += 1
            if call_count == 2:  # notification — no response
                return None
            if call_count == 1:  # initialize
                return {
                    "jsonrpc": "2.0", "id": 1,
                    "result": {
                        "protocolVersion": "2025-03-26",
                        "capabilities": {"tools": {}},
                        "serverInfo": {"name": "mock", "version": "0.1"},
                        "sessionId": "sess-123",
                    },
                }
            if call_count == 3:  # tools/list
                return {
                    "jsonrpc": "2.0", "id": 3,
                    "result": {"tools": [
                        {"name": "mock_tool", "description": "A mock tool",
                         "inputSchema": {"type": "object", "properties": {}}}
                    ]},
                }

        server._post = mock_post
        ok = await server.start()

        assert ok is True
        assert server.connected is True
        assert len(server.tools) == 1
        assert server.tools[0]["name"] == "mock_tool"

    @pytest.mark.asyncio
    async def test_http_call_tool(self):
        """Test calling a tool via HTTP."""
        server = HTTPMCPServer(name="test-http", url="http://localhost:9999/mcp")
        server.connected = True
        server._tools = [{"name": "echo", "description": "echo"}]
        server._tool_to_server = {"echo": "test-http"}

        server._client = AsyncMock()
        mock_resp = MagicMock()
        mock_resp.headers = {"content-type": "application/json"}
        mock_resp.status_code = 200
        mock_resp.json.return_value = {
            "jsonrpc": "2.0", "id": 1,
            "result": {"content": [{"type": "text", "text": "hello"}]},
        }
        server._client.post.return_value = mock_resp

        result = await server.call_tool("echo", {"input": "hello"})
        assert "content" in result

    def test_http_headers_expand_env_vars(self, monkeypatch):
        """Header values can reference environment variables for secrets."""
        monkeypatch.setenv("MCP_TEST_TOKEN", "secret-token")
        server = HTTPMCPServer(
            name="test-http",
            url="http://localhost:9999/mcp",
            headers={"Authorization": "Bearer ${MCP_TEST_TOKEN}"},
        )

        headers = server._build_headers()

        assert headers["Authorization"] == "Bearer secret-token"

    @pytest.mark.asyncio
    async def test_http_start_uses_mcp_session_id_response_header(self):
        """Streamable HTTP servers may return the session id only as a header."""
        server = HTTPMCPServer(name="test-http", url="http://localhost:9999/mcp")

        class DummyResponse:
            def __init__(self, *, headers, status_code=200, text="", json_body=None):
                self.headers = headers
                self.status_code = status_code
                self.text = text
                self._json_body = json_body

            def json(self):
                return self._json_body

        class DummyClient:
            def __init__(self):
                self.calls = []
                self.responses = [
                    DummyResponse(
                        headers={
                            "content-type": "text/event-stream",
                            "mcp-session-id": "header-session",
                        },
                        text=(
                            'event: message\n'
                            'data: {"jsonrpc":"2.0","id":1,"result":'
                            '{"protocolVersion":"2025-03-26","capabilities":{"tools":{}},'
                            '"serverInfo":{"name":"mock","version":"0.1"}}}\n\n'
                        ),
                    ),
                    DummyResponse(
                        headers={"content-type": "application/json"},
                        status_code=202,
                        json_body=None,
                    ),
                    DummyResponse(
                        headers={"content-type": "text/event-stream"},
                        text=(
                            'event: message\n'
                            'data: {"jsonrpc":"2.0","id":2,"result":{"tools":'
                            '[{"name":"mock_tool","description":"A mock tool",'
                            '"inputSchema":{"type":"object","properties":{}}}]}}\n\n'
                        ),
                    ),
                ]

            async def post(self, url, json, headers):
                self.calls.append({"url": url, "json": json, "headers": headers})
                return self.responses.pop(0)

            async def aclose(self):
                pass

        dummy_client = DummyClient()
        with patch("tools.mcp_external.httpx.AsyncClient", return_value=dummy_client):
            ok = await server.start()

        assert ok is True
        assert server.connected is True
        assert server._session_id == "header-session"
        assert server.tools[0]["name"] == "mock_tool"
        assert dummy_client.calls[1]["headers"]["Mcp-Session-Id"] == "header-session"
        assert dummy_client.calls[2]["headers"]["Mcp-Session-Id"] == "header-session"


class TestExternalMCPProxy:
    """Test the proxy manager."""

    @pytest.mark.asyncio
    async def test_empty_config(self):
        """Empty config loads no servers."""
        proxy = ExternalMCPProxy()
        await proxy.load_config({})
        assert len(proxy.get_all_tools()) == 0
        assert len(proxy.get_all_tool_names()) == 0

    @pytest.mark.asyncio
    async def test_invalid_config(self):
        """Config missing command and url is skipped."""
        proxy = ExternalMCPProxy()
        await proxy.load_config({"bad": {"env": {"X": "1"}}})
        assert len(proxy.get_all_tools()) == 0

    @pytest.mark.asyncio
    async def test_stop_all(self):
        """stop_all cleans up everything."""
        proxy = ExternalMCPProxy()
        server = MagicMock()
        server.stop = AsyncMock()
        proxy._servers["test"] = server
        proxy._tool_to_server["foo"] = "test"
        await proxy.stop_all()
        assert len(proxy._servers) == 0
        assert len(proxy._tool_to_server) == 0
        server.stop.assert_called_once()

    @pytest.mark.asyncio
    async def test_call_tool_not_found(self):
        """Calling unknown tool returns error."""
        proxy = ExternalMCPProxy()
        result = await proxy.call_tool("nonexistent", {})
        assert "error" in result

    def test_get_status_empty(self):
        """Status with no servers is empty list."""
        proxy = ExternalMCPProxy()
        assert proxy.get_status() == []
