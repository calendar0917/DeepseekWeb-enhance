function parseToolList(value) {
  return String(value || '')
    .split(/[\n,]/)
    .map(s => s.trim())
    .filter(Boolean);
}

function createToolPolicy({ getValue, whitelistKey, blacklistKey, getTools, systemHintStart, systemHintEnd }) {
  function getToolPolicy() {
    return {
      whitelist: parseToolList(getValue(whitelistKey, '')),
      blacklist: parseToolList(getValue(blacklistKey, '')),
    };
  }

  function isToolAllowed(toolName) {
    const { whitelist, blacklist } = getToolPolicy();
    if (blacklist.includes(toolName)) return false;
    if (whitelist.length && !whitelist.includes(toolName)) return false;
    return true;
  }

  function getAllowedTools() {
    return getTools().filter(t => isToolAllowed(t.name));
  }

  function describeToolPolicyBlock(toolName) {
    const { whitelist, blacklist } = getToolPolicy();
    if (blacklist.includes(toolName)) return `${toolName} 在黑名单中`;
    if (whitelist.length && !whitelist.includes(toolName)) return `${toolName} 不在白名单中`;
    return `${toolName} 不允许执行`;
  }

  function buildToolHint() {
    const allowedTools = getAllowedTools();
    if (!allowedTools.length) return '';
    let hint = `${systemHintStart} 你拥有以下 MCP 工具。当用户的需求可以用工具完成时，你必须在回复中调用工具。`;
    hint += ' 调用格式：用代码块写 ```mcp:工具名``` 后紧跟一个 JSON 代码块写参数。\n\n';
    hint += '示例：\n```mcp:execute_command\n{"command": "ls -la"}\n```\n\n';
    hint += '可用工具列表：\n';
    allowedTools.forEach(t => {
      hint += `- ${t.name}: ${t.description || ''}`;
      const req = t.inputSchema?.required;
      if (req?.length) hint += ` (参数: ${req.join(', ')})`;
      hint += '\n';
    });
    hint += '\n如果不需要工具就正常回答。需要工具时一定要调用。';
    hint += '\n\n当收到用户发送的 <tool_result> 包裹的文本时，这是你之前调用的工具的执行结果。请基于结果继续回答用户的问题。';
    hint += `\n${systemHintEnd}`;
    return hint;
  }

  return {
    buildToolHint,
    describeToolPolicyBlock,
    getAllowedTools,
    getToolPolicy,
    isToolAllowed,
  };
}

function parseToolArgs(rawArgs) {
  const text = (rawArgs || '').trim();
  if (!text) return {};
  try { return JSON.parse(text); }
  catch { return { input: text }; }
}

module.exports = { createToolPolicy, parseToolArgs, parseToolList };
