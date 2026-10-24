"""Local shell and file operation tools."""

from __future__ import annotations

import os
import re
import subprocess
import pathlib
import sys
from typing import Any

WORKSPACE_ROOT: pathlib.Path = pathlib.Path(os.environ.get("DS_WORKSPACE", os.getcwd())).resolve()
IS_WINDOWS: bool = sys.platform == "win32"
IS_DARWIN: bool = sys.platform == "darwin"
PLATFORM_NAME: str = "Windows" if IS_WINDOWS else ("macOS" if IS_DARWIN else "Linux")

DANGEROUS_PATTERNS: list[re.Pattern] = [
    # ── Unix 文件系统破坏 ──────────────────────────────────────────
    re.compile(r"rm\s+-[a-z]*r[a-z]*f[a-z]*\s+/"),      # rm -rf /
    re.compile(r"rm\s+-[a-z]*f[a-z]*r[a-z]*\s+/"),      # rm -fr /
    re.compile(r":\(\)\s*\{\s*:\|\:\&\s*\}\s*;:"),  # fork bomb
    re.compile(r"\bmkfs\b"),                              # mkfs
    re.compile(r"\bdd\s+if="),                            # dd if=
    re.compile(r">\s*/dev/sd"),                           # 覆写磁盘
    re.compile(r"chmod\s+777\s+/"),                      # chmod 777 /
    re.compile(r"chown\s+root\s+/"),                     # chown root /

    # ── Unix 结束进程 ──────────────────────────────────────────────
    # 只在“命令位”（行首，或 ; & | 之后）匹配。
    # 旧规则用 \bkill\b 匹配任意位置，导致 commit message 里的
    # "fix kill bug"、echo kill 被误杀。
    re.compile(r"(?:^|[;&|]\s*)(?:sudo\s+)?kill\b", re.MULTILINE),
    re.compile(r"(?:^|[;&|]\s*)(?:sudo\s+)?pkill\b", re.MULTILINE),
    re.compile(r"(?:^|[;&|]\s*)(?:sudo\s+)?killall\b", re.MULTILINE),

    # ── Windows 结束进程（命令位） ─────────────────────────────────
    re.compile(r"(?:^|[;&|]\s*)(?:start\s+)?taskkill(\.exe)?\b", re.MULTILINE),

    # ── Windows 文件系统破坏 ───────────────────────────────────────
    # 旧规则要求 /f /s /q 三个标志齐全，单写 del /f 即可绕过。
    # 现在只要出现 /f /s /q 任一标志就拦截。
    re.compile(r"(?:^|[;&|]\s*)del\s+(?:[^&|]*\s)?/[fFsSqQ]\b", re.MULTILINE),
    re.compile(r"(?:^|[;&|]\s*)rmdir\s+(?:[^&|]*\s)?/[sSqQ]\b", re.MULTILINE),
    re.compile(r"(?:^|[;&|]\s*)rd\s+(?:[^&|]*\s)?/[sSqQ]\b", re.MULTILINE),

    # ── 跨平台替代路径（PowerShell / Python 也能删文件） ───────────
    re.compile(r"\bremove-item\b(?=[^&|\n]*(?:-recurse|-force|-rf))", re.MULTILINE),
    re.compile(r"\b(?:shutil\.)?rmtree\b"),

    # ── 磁盘格式化 / 分区 ─────────────────────────────────────────
    # 旧规则 \bformat\.?com\b 误伤 pytest --format=json、echo format。
    # 真正的格式化命令形如 `format C:` / `format.com D:`。
    re.compile(r"(?:^|[;&|]\s*)format(?:\.com)?\s+[a-z]:", re.MULTILINE),
    re.compile(r"(?:^|[;&|]\s*)diskpart\b", re.MULTILINE),
]


def _validate_path(path: str) -> pathlib.Path:
    """Validate path is within workspace. Raises ValueError if outside."""
    if path is None or not str(path).strip():
        raise ValueError(
            f"缺少 'path' 参数：请提供相对于工作区 '{WORKSPACE_ROOT}' 的文件路径"
        )
    raw = pathlib.Path(str(path)).expanduser()
    if not raw.is_absolute():
        raw = WORKSPACE_ROOT / raw
    p = raw.resolve()
    try:
        p.relative_to(WORKSPACE_ROOT)
    except ValueError:
        raise ValueError(f"路径 '{p}' 超出工作区范围，仅允许访问 '{WORKSPACE_ROOT}' 内的文件")
    return p


def execute_command(command: str, timeout: int = 30) -> str:
    """Execute a shell command and return stdout/stderr."""
    cmd_lower = command.lower().strip()
    for pattern in DANGEROUS_PATTERNS:
        match = pattern.search(cmd_lower)
        if match:
            matched = match.group(0)
            return f"安全拦截：命令中包含危险操作 '{matched}'，已阻止执行以保护系统安全"

    try:
        result = subprocess.run(
            command,
            shell=True,
            stdin=subprocess.DEVNULL,  # 防止命令等待交互输入（如 rmdir /s 的确认提示）而挂死
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout,
            cwd=str(WORKSPACE_ROOT),
        )
        output = result.stdout
        if result.stderr:
            output += ("\n--- stderr ---\n" if output else "") + result.stderr
        if result.returncode != 0:
            output += f"\n(退出码: {result.returncode})"
            if IS_WINDOWS and result.returncode == 1 and "is not recognized" in (result.stderr or ""):
                output += f"\n提示：当前运行在 Windows 上，请使用 cmd.exe 语法（如 dir 代替 ls，type 代替 cat）"
            elif not IS_WINDOWS and result.returncode == 127:
                output += "\n提示：命令未找到（退出码 127），请检查命令名称是否正确"
        return output or "(命令执行完毕，无输出)"
    except subprocess.TimeoutExpired:
        return (
            f"命令执行超时（限制 {timeout} 秒）。如需更长时间，请增大 timeout 参数。\n"
            f"提示：stdin 已重定向到 DEVNULL，需要交互确认的命令（如 rmdir /s、del 无 /q）会直接失败或阻塞，"
            f"请改用非交互参数（如 /q 静默标志）"
        )
    except Exception as e:
        return f"命令执行失败: {e}"


def get_cwd() -> str:
    """Get the current workspace directory."""
    return str(WORKSPACE_ROOT)


def list_directory(path: str = ".") -> str:
    """List directory contents with type markers."""
    try:
        p = _validate_path(path)
    except ValueError as e:
        return str(e)

    if not p.exists():
        return f"错误：路径不存在 — {p}"
    if not p.is_dir():
        return f"错误：这不是一个目录 — {p}"

    entries: list[str] = []
    try:
        for item in sorted(p.iterdir()):
            prefix = "d " if item.is_dir() else "f "
            size = ""
            if item.is_file():
                try:
                    size = f" ({item.stat().st_size:,} bytes)"
                except OSError:
                    pass
            entries.append(f"{prefix}{item.name}{size}")
    except PermissionError:
        return f"错误：没有权限访问目录 — {p}"

    return "\n".join(entries) if entries else "(空目录)"


def read_file(path: str, encoding: str = "utf-8", max_bytes: int = 1_048_576) -> str:
    """Read file content. Limited to 1MB by default."""
    try:
        p = _validate_path(path)
    except ValueError as e:
        return str(e)

    if not p.exists():
        return f"错误：文件不存在 — {p}"
    if not p.is_file():
        return f"错误：'{p}' 不是一个文件（可能是目录）。请提供具体文件名"
    try:
        size = p.stat().st_size
        if size > max_bytes:
            return f"错误：文件过大（{size:,} 字节，限制 {max_bytes:,} 字节）。请增大 max_bytes 参数或读取部分内容"
        return p.read_text(encoding=encoding)
    except UnicodeDecodeError:
        return f"错误：无法以 '{encoding}' 编码读取文件，文件可能包含二进制数据，请尝试其他编码"
    except PermissionError as e:
        return f"读取文件失败（权限不足）: {e}"
    except Exception as e:
        return f"读取文件失败: {e}"


def write_file(path: str, content: str, encoding: str = "utf-8") -> str:
    """Write content to a file inside the workspace."""
    if content is None:
        return "错误：缺少 'content' 参数（要写入的文本内容）"
    if not isinstance(content, str):
        content = str(content)

    try:
        p = _validate_path(path)
    except ValueError as e:
        return str(e)

    # 目标必须是一个文件路径，不能是目录
    # （旧实现对目录写入会抛 PermissionError [Errno 13]，误导成“权限不足”）
    if p.is_dir():
        return (
            f"错误：'{p}' 是一个目录，不能作为写入目标。"
            f"请提供包含文件名的完整路径，例如 '{p / 'note.txt'}'"
        )
    if p.exists() and not p.is_file():
        return f"错误：'{p}' 不是普通文件，拒绝写入"

    try:
        p.parent.mkdir(parents=True, exist_ok=True)
    except (PermissionError, OSError) as e:
        return (
            f"创建目录失败: {e}\n目标目录: {p.parent}\n"
            f"工作区根目录: {WORKSPACE_ROOT}"
        )

    try:
        p.write_text(content, encoding=encoding)
        return f"已写入 {len(content):,} 个字符到 {p}"
    except PermissionError as e:
        return (
            f"写入文件失败（权限不足）: {e}\n"
            f"目标路径: {p}\n"
            f"工作区根目录: {WORKSPACE_ROOT}\n"
            f"可能原因：文件只读、被其他程序占用，或当前用户对该位置没有写权限"
        )
    except IsADirectoryError as e:
        return f"写入文件失败：目标是一个目录 — {e}"
    except UnicodeEncodeError as e:
        return f"写入文件失败：内容无法用 '{encoding}' 编码保存 — {e}。请改用 encoding='utf-8'"
    except Exception as e:
        return f"写入文件失败: {e}"


TOOL_DEFINITIONS: list[dict[str, Any]] = [
    {
        "name": "execute_command",
        "description": f"执行 shell 命令。工作区: {WORKSPACE_ROOT}（平台: {PLATFORM_NAME}，{'请使用 cmd.exe 语法' if IS_WINDOWS else '请使用 bash 语法'}）",
        "inputSchema": {
            "type": "object",
            "properties": {
                "command": {"type": "string", "description": "要执行的 shell 命令"},
                "timeout": {"type": "integer", "description": "超时时间（秒，默认 30）"},
            },
            "required": ["command"],
        },
    },
    {
        "name": "get_cwd",
        "description": f"获取当前工作区目录路径（{WORKSPACE_ROOT}）",
        "inputSchema": {"type": "object", "properties": {}},
    },
    {
        "name": "list_directory",
        "description": "列出工作区内指定目录的文件和子目录",
        "inputSchema": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "目录路径（默认为当前目录）"},
            },
        },
    },
    {
        "name": "read_file",
        "description": "读取工作区内指定文件的内容",
        "inputSchema": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "要读取的文件路径（相对工作区）"},
                "encoding": {"type": "string", "description": "文件编码（默认: utf-8）"},
                "max_bytes": {"type": "integer", "description": "最大读取字节数（默认 1MB）"},
            },
            "required": ["path"],
        },
    },
    {
        "name": "write_file",
        "description": "将内容写入工作区内的指定文件",
        "inputSchema": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "要写入的文件路径（相对工作区，必须包含文件名，如 notes/a.txt）"},
                "content": {"type": "string", "description": "要写入的文本内容"},
                "encoding": {"type": "string", "description": "文件编码（默认: utf-8）"},
            },
            "required": ["path", "content"],
        },
    },
]

HANDLERS: dict[str, Any] = {
    "execute_command": lambda args: execute_command(args.get("command", ""), args.get("timeout", 30)),
    "get_cwd": lambda args: get_cwd(),
    "list_directory": lambda args: list_directory(args.get("path", ".")),
    "read_file": lambda args: read_file(
        args.get("path", ""), args.get("encoding", "utf-8"), args.get("max_bytes", 1_048_576)
    ),
    "write_file": lambda args: write_file(
        args.get("path", ""), args.get("content"), args.get("encoding", "utf-8")
    ),
}
