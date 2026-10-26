"""Tests for preset marketplace API."""

import pytest
from fastapi.testclient import TestClient
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))


class TestPresetAPI:
    @pytest.fixture
    def client(self):
        from fastapi.testclient import TestClient
        from server import app
        return TestClient(app)

    def test_list_presets(self, client):
        response = client.get("/api/presets")
        assert response.status_code == 200
        data = response.json()
        assert "presets" in data
        assert len(data["presets"]) > 0
        # Each preset has required fields
        for p in data["presets"]:
            assert "id" in p
            assert "name" in p
            assert "installed" in p

    def test_install_preset_missing(self, client):
        response = client.post("/api/presets/nonexistent/install", json={})
        assert response.status_code == 404

    def test_install_preset_missing_required_params(self, client):
        """filesystem requires PATH — missing it should fail."""
        response = client.post("/api/presets/filesystem/install", json={})
        assert response.status_code == 400
        assert "缺少必填参数" in response.json()["error"]


    @pytest.mark.parametrize("params", [{}, {"BAIZHI_API_KEY": ""}])
    def test_baizhi_missing_key_does_not_start_server(
        self, client: TestClient, monkeypatch: pytest.MonkeyPatch, params: dict[str, str],
    ) -> None:
        from unittest.mock import AsyncMock
        from server import external_proxy

        start = AsyncMock()
        monkeypatch.setattr(external_proxy, "add_server", start)
        response = client.post("/api/presets/baizhi/install", json={"params": params})
        assert response.status_code == 400
        start.assert_not_awaited()

    def test_baizhi_key_is_bound_only_to_authorization_header(
        self, client: TestClient, monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        from unittest.mock import AsyncMock
        from server import external_proxy

        key = 'fixture-key"with\\slash'
        start = AsyncMock(return_value={"ok": True, "tools": []})
        monkeypatch.setattr(external_proxy, "add_server", start)
        response = client.post("/api/presets/baizhi/install", json={
            "params": {"BAIZHI_API_KEY": key},
        })
        assert response.status_code == 200
        name, config = start.await_args.args
        assert name == "baizhi"
        assert config["url"] == "https://agent-toolkit.app.baizhi.cloud/mcp"
        assert key not in config["url"]
        assert config["headers"] == {"Authorization": "Bearer " + key}
        assert "env" not in config

    def test_deed_page_installs_without_params_or_headers(
        self, client: TestClient, monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        from unittest.mock import AsyncMock
        from server import external_proxy

        start = AsyncMock(return_value={"ok": True, "tools": []})
        monkeypatch.setattr(external_proxy, "add_server", start)
        response = client.post("/api/presets/deed-page/install", json={})
        assert response.status_code == 200
        name, config = start.await_args.args
        assert name == "deed-page"
        assert config["url"] == "https://deed.page/mcp"
        assert "headers" not in config
        assert "env" not in config


class TestDangerousPatterns:
    def test_taskkill_blocked(self):
        from tools.shell import execute_command
        result = execute_command("taskkill /F /IM python.exe")
        assert "安全拦截" in result

    def test_kill_blocked(self):
        from tools.shell import execute_command
        result = execute_command("kill -9 12345")
        assert "安全拦截" in result

    def test_pkill_blocked(self):
        from tools.shell import execute_command
        result = execute_command("pkill python")
        assert "安全拦截" in result

    def test_windows_del_blocked(self):
        from tools.shell import execute_command
        result = execute_command("del /f /s /q C:\\*")
        assert "安全拦截" in result

    def test_windows_rd_blocked(self):
        from tools.shell import execute_command
        result = execute_command("rd /s /q C:\\Users")
        assert "安全拦截" in result

    def test_windows_rmdir_blocked(self):
        from tools.shell import execute_command
        result = execute_command("rmdir /s /q C:\\")
        assert "安全拦截" in result

    def test_windows_format_blocked(self):
        from tools.shell import execute_command
        result = execute_command("format C: /fs:ntfs /q")
        assert "安全拦截" in result

    def test_windows_diskpart_blocked(self):
        from tools.shell import execute_command
        result = execute_command("diskpart /s script.txt")
        assert "安全拦截" in result
