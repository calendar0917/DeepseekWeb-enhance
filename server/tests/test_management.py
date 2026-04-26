"""Tests for external server management API."""

import pytest
import sys
from pathlib import Path
from unittest.mock import patch, AsyncMock

sys.path.insert(0, str(Path(__file__).parent.parent))


class TestExternalServerManagementAPI:
    """Test the /api/external-servers endpoints."""

    @pytest.fixture
    def client(self):
        from fastapi.testclient import TestClient
        from server import app
        return TestClient(app)

    def test_list_external_servers_empty(self, client):
        response = client.get("/api/external-servers")
        assert response.status_code == 200
        data = response.json()
        assert "servers" in data
        assert isinstance(data["servers"], list)

    def test_add_missing_name(self, client):
        response = client.post("/api/external-servers", json={"command": "echo"})
        assert response.status_code == 400
        assert "Missing" in response.json()["error"]

    def test_add_invalid_json(self, client):
        response = client.post("/api/external-servers",
                               content="not json",
                               headers={"Content-Type": "application/json"})
        assert response.status_code == 400

    def test_batch_import_invalid_server(self, client):
        """Batch with bad config returns per-server errors."""
        response = client.post("/api/external-servers", json={
            "mcpServers": {"bad": {"type": "stdio"}}
        })
        assert response.status_code == 200
        data = response.json()
        assert "results" in data
        assert data["results"][0]["ok"] is False

    def test_remove_not_found(self, client):
        response = client.delete("/api/external-servers/nonexistent")
        assert response.status_code == 404

    def test_start_not_found(self, client):
        response = client.post("/api/external-servers/nonexistent/start")
        assert response.status_code == 400

    def test_stop_not_found(self, client):
        response = client.post("/api/external-servers/nonexistent/stop")
        assert response.status_code == 404

    def test_health_includes_external(self, client):
        response = client.get("/health")
        assert response.status_code == 200
        data = response.json()
        assert "external_servers" in data
        assert "builtin_tools" in data
        assert "external_tools" in data
