import pytest
import sys
import os
from pathlib import Path
from unittest.mock import patch, MagicMock
import httpx

sys.path.insert(0, str(Path(__file__).parent.parent))

from tools import shell, search


class TestPathValidation:
    def test_validate_path_within_workspace(self, tmp_path, monkeypatch):
        monkeypatch.setenv("DS_WORKSPACE", str(tmp_path))
        monkeypatch.chdir(tmp_path)
        shell.WORKSPACE_ROOT = tmp_path.resolve()

        test_file = tmp_path / "test.txt"
        test_file.write_text("hello")

        result = shell._validate_path("test.txt")
        assert result == test_file.resolve()

    def test_validate_relative_path_uses_workspace_not_process_cwd(self, tmp_path, monkeypatch):
        workspace = tmp_path / "workspace"
        outside = tmp_path / "outside"
        workspace.mkdir()
        outside.mkdir()
        monkeypatch.setenv("DS_WORKSPACE", str(workspace))
        monkeypatch.chdir(outside)
        shell.WORKSPACE_ROOT = workspace.resolve()

        test_file = workspace / "test.txt"
        test_file.write_text("hello")

        result = shell._validate_path("test.txt")
        assert result == test_file.resolve()

    def test_validate_path_traversal_blocked(self, tmp_path, monkeypatch):
        monkeypatch.setenv("DS_WORKSPACE", str(tmp_path))
        shell.WORKSPACE_ROOT = tmp_path.resolve()

        with pytest.raises(ValueError, match="超出工作区范围"):
            shell._validate_path("../../../etc/passwd")

    def test_validate_path_absolute_within_workspace(self, tmp_path, monkeypatch):
        monkeypatch.setenv("DS_WORKSPACE", str(tmp_path))
        shell.WORKSPACE_ROOT = tmp_path.resolve()

        test_dir = tmp_path / "subdir"
        test_dir.mkdir()

        result = shell._validate_path(str(test_dir))
        assert result == test_dir.resolve()


class TestShellTools:
    def test_get_cwd(self, tmp_path, monkeypatch):
        monkeypatch.setenv("DS_WORKSPACE", str(tmp_path))
        monkeypatch.chdir(tmp_path)
        shell.WORKSPACE_ROOT = tmp_path.resolve()

        result = shell.get_cwd()
        assert result == str(tmp_path.resolve())

    def test_list_directory(self, tmp_path, monkeypatch):
        monkeypatch.setenv("DS_WORKSPACE", str(tmp_path))
        monkeypatch.chdir(tmp_path)
        shell.WORKSPACE_ROOT = tmp_path.resolve()

        (tmp_path / "file.txt").write_text("test")
        (tmp_path / "subdir").mkdir()

        result = shell.list_directory(".")
        assert "d subdir" in result
        assert "f file.txt" in result

    def test_list_directory_nonexistent(self, tmp_path, monkeypatch):
        monkeypatch.setenv("DS_WORKSPACE", str(tmp_path))
        monkeypatch.chdir(tmp_path)
        shell.WORKSPACE_ROOT = tmp_path.resolve()

        result = shell.list_directory("nonexistent")
        assert "路径不存在" in result

    def test_read_file(self, tmp_path, monkeypatch):
        monkeypatch.setenv("DS_WORKSPACE", str(tmp_path))
        monkeypatch.chdir(tmp_path)
        shell.WORKSPACE_ROOT = tmp_path.resolve()

        (tmp_path / "test.txt").write_text("hello world")

        result = shell.read_file("test.txt")
        assert result == "hello world"

    def test_read_file_too_large(self, tmp_path, monkeypatch):
        monkeypatch.setenv("DS_WORKSPACE", str(tmp_path))
        monkeypatch.chdir(tmp_path)
        shell.WORKSPACE_ROOT = tmp_path.resolve()

        large_content = "x" * 2000
        (tmp_path / "large.txt").write_text(large_content)

        result = shell.read_file("large.txt", max_bytes=1000)
        assert "文件过大" in result

    def test_write_file(self, tmp_path, monkeypatch):
        monkeypatch.setenv("DS_WORKSPACE", str(tmp_path))
        monkeypatch.chdir(tmp_path)
        shell.WORKSPACE_ROOT = tmp_path.resolve()

        result = shell.write_file("new.txt", "test content")
        assert "已写入" in result
        assert (tmp_path / "new.txt").read_text() == "test content"

    def test_execute_command_whitelisted(self, tmp_path, monkeypatch):
        monkeypatch.setenv("DS_WORKSPACE", str(tmp_path))
        shell.WORKSPACE_ROOT = tmp_path.resolve()

        result = shell.execute_command("echo hello")
        assert "hello" in result

    def test_execute_command_dangerous_blocked(self, tmp_path, monkeypatch):
        monkeypatch.setenv("DS_WORKSPACE", str(tmp_path))
        shell.WORKSPACE_ROOT = tmp_path.resolve()

        result = shell.execute_command("rm -rf /")
        assert "安全拦截" in result
        assert "危险操作" in result


class TestSearchTools:
    @pytest.mark.asyncio
    async def test_bing_search_no_api_key(self):
        result = await search.bing_search("test", api_key="")
        assert "未配置" in result

    @pytest.mark.asyncio
    async def test_bing_search_with_mock(self):
        mock_response = MagicMock()
        mock_response.json.return_value = {
            "webPages": {
                "value": [
                    {"name": "Test Result", "url": "https://example.com", "snippet": "Test snippet"}
                ]
            }
        }
        mock_response.raise_for_status = MagicMock()

        with patch.object(httpx.AsyncClient, "get", return_value=mock_response):
            result = await search.bing_search("test", api_key="fake-key")
            assert "Test Result" in result
            assert "https://example.com" in result

    @pytest.mark.asyncio
    async def test_crawl_webpage_mock(self):
        html_content = "<html><body><p>Hello World</p></body></html>"
        mock_response = MagicMock()
        mock_response.text = html_content
        mock_response.raise_for_status = MagicMock()

        with patch.object(httpx.AsyncClient, "get", return_value=mock_response):
            result = await search.crawl_webpage("https://example.com")
            assert "Hello World" in result

    @pytest.mark.asyncio
    async def test_crawl_webpage_truncation(self):
        long_content = "<html><body><p>" + "x" * 20000 + "</p></body></html>"
        mock_response = MagicMock()
        mock_response.text = long_content
        mock_response.raise_for_status = MagicMock()

        with patch.object(httpx.AsyncClient, "get", return_value=mock_response):
            result = await search.crawl_webpage("https://example.com", max_length=1000)
            assert "已截断" in result


class TestToolDefinitions:
    def test_shell_tool_definitions(self):
        assert len(shell.TOOL_DEFINITIONS) == 5
        names = [t["name"] for t in shell.TOOL_DEFINITIONS]
        assert "execute_command" in names
        assert "read_file" in names
        assert "write_file" in names

    def test_search_tool_definitions(self):
        assert len(search.TOOL_DEFINITIONS) == 2
        names = [t["name"] for t in search.TOOL_DEFINITIONS]
        assert "bing_search" in names
        assert "crawl_webpage" in names

    def test_tool_schemas(self):
        for tool in shell.TOOL_DEFINITIONS:
            assert "name" in tool
            assert "description" in tool
            assert "inputSchema" in tool
            assert "type" in tool["inputSchema"]
            assert "properties" in tool["inputSchema"]
