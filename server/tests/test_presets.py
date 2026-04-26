"""Tests for preset marketplace API."""

import pytest
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
