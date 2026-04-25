"""Local shell and file operation tools."""

from __future__ import annotations

import os
import subprocess
import pathlib
from typing import Any

WORKSPACE_ROOT: pathlib.Path = pathlib.Path(os.environ.get("DS_WORKSPACE", os.getcwd())).resolve()

COMMAND_WHITELIST: list[str] = [
    "ls", "dir", "cat", "head", "tail", "grep", "find", "pwd", "echo",
    "git", "npm", "node", "python", "pip", "pnpm", "yarn", "cargo", "rustc",
    "mkdir", "touch", "cp", "mv", "rm", "chmod", "stat", "wc", "diff",
    "curl", "wget", "http", "jq", "json", "tree", "which", "where",
]

DANGEROUS_PATTERNS: list[str] = [
    "rm -rf /", "rm -rf /*", ":(){ :|:& };:", "mkfs", "dd if=",
    "> /dev/sd", "chmod 777 /", "chown root",
]


def _validate_path(path: str) -> pathlib.Path:
    """Validate path is within workspace. Raises ValueError if outside."""
    p = pathlib.Path(path).expanduser().resolve()
    try:
        p.relative_to(WORKSPACE_ROOT)
    except ValueError:
        raise ValueError(f"Path '{p}' is outside workspace '{WORKSPACE_ROOT}'")
    return p


def _validate_command(command: str) -> str:
    """Validate command against whitelist. Returns error message or empty string."""
    cmd_lower = command.lower().strip()
    
    for pattern in DANGEROUS_PATTERNS:
        if pattern in cmd_lower:
            return f"Blocked dangerous pattern: {pattern}"
    
    first_word = command.strip().split()[0] if command.strip() else ""
    if first_word and first_word not in COMMAND_WHITELIST:
        return f"Command '{first_word}' not in whitelist. Allowed: {', '.join(COMMAND_WHITELIST[:10])}..."
    
    return ""


def execute_command(command: str, timeout: int = 30) -> str:
    """Execute a shell command and return stdout/stderr."""
    validation_error = _validate_command(command)
    if validation_error:
        return f"Security: {validation_error}"
    
    try:
        result = subprocess.run(
            command,
            shell=True,
            capture_output=True,
            text=True,
            timeout=timeout,
            cwd=str(WORKSPACE_ROOT),
        )
        output = result.stdout
        if result.stderr:
            output += ("\n--- stderr ---\n" if output else "") + result.stderr
        if result.returncode != 0:
            output += f"\n(exit code: {result.returncode})"
        return output or "(no output)"
    except subprocess.TimeoutExpired:
        return f"Command timed out after {timeout}s"
    except Exception as e:
        return f"Error: {e}"


def get_cwd() -> str:
    """Get the current workspace directory."""
    return str(WORKSPACE_ROOT)


def list_directory(path: str = ".") -> str:
    """List directory contents with type markers."""
    try:
        p = _validate_path(path)
    except ValueError as e:
        return f"Error: {e}"
    
    if not p.exists():
        return f"Error: path does not exist: {p}"
    if not p.is_dir():
        return f"Error: not a directory: {p}"

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
        return f"Error: permission denied: {p}"

    return "\n".join(entries) if entries else "(empty directory)"


def read_file(path: str, encoding: str = "utf-8", max_bytes: int = 1_048_576) -> str:
    """Read file content. Limited to 1MB by default."""
    try:
        p = _validate_path(path)
    except ValueError as e:
        return f"Error: {e}"
    
    if not p.exists():
        return f"Error: file does not exist: {p}"
    if not p.is_file():
        return f"Error: not a file: {p}"
    try:
        size = p.stat().st_size
        if size > max_bytes:
            return f"Error: file too large ({size:,} bytes, limit {max_bytes:,})"
        return p.read_text(encoding=encoding)
    except UnicodeDecodeError:
        return f"Error: cannot decode as {encoding}"
    except Exception as e:
        return f"Error: {e}"


def write_file(path: str, content: str, encoding: str = "utf-8") -> str:
    """Write content to a file."""
    try:
        p = _validate_path(path)
    except ValueError as e:
        return f"Error: {e}"
    
    try:
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(content, encoding=encoding)
        return f"Written {len(content):,} characters to {p}"
    except Exception as e:
        return f"Error: {e}"


TOOL_DEFINITIONS: list[dict[str, Any]] = [
    {
        "name": "execute_command",
        "description": f"Execute a whitelisted shell command. Workspace: {WORKSPACE_ROOT}",
        "inputSchema": {
            "type": "object",
            "properties": {
                "command": {"type": "string", "description": "The shell command to execute (whitelisted)"},
                "timeout": {"type": "integer", "description": "Timeout in seconds (default 30)"},
            },
            "required": ["command"],
        },
    },
    {
        "name": "get_cwd",
        "description": f"Get the current workspace directory ({WORKSPACE_ROOT})",
        "inputSchema": {"type": "object", "properties": {}},
    },
    {
        "name": "list_directory",
        "description": "List contents of a directory within workspace",
        "inputSchema": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "Directory path (default: current directory)"},
            },
        },
    },
    {
        "name": "read_file",
        "description": "Read the contents of a file within workspace",
        "inputSchema": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "File path to read"},
                "encoding": {"type": "string", "description": "File encoding (default: utf-8)"},
            },
            "required": ["path"],
        },
    },
    {
        "name": "write_file",
        "description": "Write content to a file within workspace",
        "inputSchema": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "File path to write"},
                "content": {"type": "string", "description": "Content to write"},
                "encoding": {"type": "string", "description": "File encoding (default: utf-8)"},
            },
            "required": ["path", "content"],
        },
    },
]

HANDLERS: dict[str, Any] = {
    "execute_command": lambda args: execute_command(args.get("command", ""), args.get("timeout", 30)),
    "get_cwd": lambda args: get_cwd(),
    "list_directory": lambda args: list_directory(args.get("path", ".")),
    "read_file": lambda args: read_file(args.get("path", ""), args.get("encoding", "utf-8")),
    "write_file": lambda args: write_file(args.get("path", ""), args.get("content", ""), args.get("encoding", "utf-8")),
}
