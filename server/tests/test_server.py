import pytest
import sys
from pathlib import Path
from unittest.mock import patch, MagicMock
import json

sys.path.insert(0, str(Path(__file__).parent.parent))


class TestMCPEndpoint:
    @pytest.fixture
    def client(self):
        from fastapi.testclient import TestClient
        from server import app
        return TestClient(app)

    def test_health_endpoint(self, client):
        response = client.get("/health")
        assert response.status_code == 200
        data = response.json()
        assert data["status"] == "ok"
        assert "tools" in data
        assert "sessions" in data

    def test_mcp_initialize(self, client):
        request = {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": "2025-03-26",
                "capabilities": {},
                "clientInfo": {"name": "test", "version": "1.0"}
            }
        }
        response = client.post("/mcp", json=request)
        assert response.status_code == 200
        data = response.json()
        assert data["jsonrpc"] == "2.0"
        assert data["id"] == 1
        assert "result" in data
        assert "sessionId" in data["result"]

    def test_mcp_tools_list(self, client):
        init_request = {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {"protocolVersion": "2025-03-26", "capabilities": {}, "clientInfo": {"name": "test", "version": "1.0"}}
        }
        client.post("/mcp", json=init_request)
        
        list_request = {
            "jsonrpc": "2.0",
            "id": 2,
            "method": "tools/list"
        }
        response = client.post("/mcp", json=list_request)
        assert response.status_code == 200
        data = response.json()
        assert "result" in data
        assert "tools" in data["result"]
        assert len(data["result"]["tools"]) > 0

    def test_mcp_tools_call_get_cwd(self, client):
        init_request = {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {"protocolVersion": "2025-03-26", "capabilities": {}, "clientInfo": {"name": "test", "version": "1.0"}}
        }
        client.post("/mcp", json=init_request)
        
        call_request = {
            "jsonrpc": "2.0",
            "id": 3,
            "method": "tools/call",
            "params": {"name": "get_cwd", "arguments": {}}
        }
        response = client.post("/mcp", json=call_request)
        assert response.status_code == 200
        data = response.json()
        assert "result" in data
        assert "content" in data["result"]

    def test_mcp_unknown_method(self, client):
        request = {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "unknown_method"
        }
        response = client.post("/mcp", json=request)
        assert response.status_code == 200
        data = response.json()
        assert "error" in data
        assert data["error"]["code"] == -32601

    def test_mcp_batch_request(self, client):
        requests = [
            {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-03-26", "capabilities": {}, "clientInfo": {"name": "test", "version": "1.0"}}},
            {"jsonrpc": "2.0", "id": 2, "method": "tools/list"}
        ]
        response = client.post("/mcp", json=requests)
        assert response.status_code == 202

    def test_mcp_invalid_json(self, client):
        response = client.post("/mcp", content="invalid json", headers={"Content-Type": "application/json"})
        assert response.status_code == 400


class TestSessionCleanup:
    def test_session_cleanup_on_initialize(self):
        from server import sessions, cleanup_expired_sessions
        from datetime import datetime, timedelta
        
        old_session_id = "old-session"
        sessions[old_session_id] = {
            "client": {"name": "test"},
            "last_activity": datetime.now() - timedelta(minutes=60)
        }
        
        cleanup_expired_sessions()
        
        assert old_session_id not in sessions
