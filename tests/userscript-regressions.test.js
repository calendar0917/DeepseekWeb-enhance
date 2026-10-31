const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const enhanceSource = fs.readFileSync(path.join(ROOT, 'ds-enhance.user.js'), 'utf8');
const bridgeSource = fs.readFileSync(path.join(ROOT, 'ds-mcp-bridge.user.js'), 'utf8');

function extractFunction(source, name) {
  const functionStart = source.indexOf(`function ${name}(`);
  assert.notEqual(functionStart, -1, `missing function ${name}`);

  const asyncPrefix = 'async ';
  const start = source.slice(Math.max(0, functionStart - asyncPrefix.length), functionStart) === asyncPrefix
    ? functionStart - asyncPrefix.length
    : functionStart;

  const bodyStart = source.indexOf('{', functionStart);
  assert.notEqual(bodyStart, -1, `missing body for function ${name}`);

  let depth = 0;
  for (let i = bodyStart; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`unterminated function ${name}`);
}

function buildSessionHarness(pages) {
  const functions = [
    'getSessionKey',
    'getSessionUpdatedAt',
    'normalizeSession',
    'buildSessionCursor',
    'cursorKey',
    'fetchAllSessions',
  ].map(name => extractFunction(enhanceSource, name)).join('\n\n');

  const sandbox = {
    pages,
    module: { exports: {} },
  };

  vm.runInNewContext(`${functions}
    let pageIndex = 0;
    const calls = [];
    async function fetchSessionsPage(cursor) {
      calls.push(cursor);
      const page = pages[Math.min(pageIndex, pages.length - 1)];
      pageIndex++;
      return page;
    }
    module.exports = { calls, fetchAllSessions };
  `, sandbox);

  return sandbox.module.exports;
}

function sessionPage(chatSessions, hasMore = true) {
  return { biz_data: { chat_sessions: chatSessions, has_more: hasMore } };
}

test('fetchAllSessions deduplicates repeated pages and stops without inflating counts', async () => {
  const repeatedPage = sessionPage([
    { id: 'session-a', pinned: false, updated_at: 200 },
    { id: 'session-b', pinned: false, updated_at: 100 },
  ]);
  const harness = buildSessionHarness([repeatedPage, repeatedPage, repeatedPage]);

  const sessions = await harness.fetchAllSessions();

  assert.deepEqual(Array.from(sessions, s => s.id), ['session-a', 'session-b']);
  assert.equal(harness.calls.length, 2);
});

test('fetchAllSessions normalizes common session id and timestamp aliases', async () => {
  const harness = buildSessionHarness([
    sessionPage([
      { chat_session_id: 'legacy-id', pinned: true, updatedAt: '321' },
    ], false),
  ]);

  const sessions = await harness.fetchAllSessions();

  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].id, 'legacy-id');
  assert.equal(sessions[0].updated_at, 321);
});

test('inline prompt button anchor no longer depends on role=button', () => {
  assert.match(enhanceSource, /querySelectorAll\('\.ds-toggle-button, \[class\*="ds-toggle-button"\]'\)/);
  assert.doesNotMatch(enhanceSource, /querySelectorAll\('div\[role="button"\]\.ds-toggle-button'\)/);
});

test('MCP tool-call regex accepts dotted and dashed tool names', () => {
  const match = bridgeSource.match(/const TOOL_CALL_RE = (\/.*?\/g);/);
  assert.ok(match, 'missing TOOL_CALL_RE');
  const regex = vm.runInNewContext(match[1]);

  const content = '```mcp:server.tool-name\n{"path":"/tmp/a"}\n```';
  const parsed = regex.exec(content);

  assert.ok(parsed);
  assert.equal(parsed[1], 'server.tool-name');
  assert.equal(parsed[2].trim(), '{"path":"/tmp/a"}');
});

test('MCP tool hint includes system instruction end marker', () => {
  const functions = [extractFunction(bridgeSource, 'buildToolHint')].join('\n\n');
  const sandbox = {
    SYSTEM_HINT_START: '[系统指令]',
    SYSTEM_HINT_END: '[系统指令结束]',
    toolRegistry: [
      { name: 'execute_command', description: 'run shell', inputSchema: { required: ['command'] } },
    ],
    module: { exports: {} },
  };

  vm.runInNewContext(`${functions}
    module.exports = { buildToolHint };
  `, sandbox);

  const hint = sandbox.module.exports.buildToolHint();

  assert.match(hint, /^\[系统指令\]/);
  assert.match(hint, /execute_command/);
  assert.match(hint, /\[系统指令结束\]$/);
});

test('MCP resend argument parser preserves JSON and wraps plain text', () => {
  const functions = [extractFunction(bridgeSource, 'parseToolArgs')].join('\n\n');
  const sandbox = { module: { exports: {} } };

  vm.runInNewContext(`${functions}
    module.exports = { parseToolArgs };
  `, sandbox);

  const parseToolArgs = sandbox.module.exports.parseToolArgs;

  assert.deepEqual(Object.assign({}, parseToolArgs('{"path":"/tmp/a"}')), { path: '/tmp/a' });
  assert.deepEqual(Object.assign({}, parseToolArgs('plain text')), { input: 'plain text' });
  assert.deepEqual(Object.assign({}, parseToolArgs('')), {});
});

test('MCP code block parser does not match incidental mcp text in normal code', () => {
  const functions = [extractFunction(bridgeSource, 'getMCPCodeInfo')].join('\n\n');
  const sandbox = { module: { exports: {} } };

  vm.runInNewContext(`${functions}
    module.exports = { getMCPCodeInfo };
  `, sandbox);

  const getMCPCodeInfo = sandbox.module.exports.getMCPCodeInfo;

  assert.equal(getMCPCodeInfo({
    textContent: 'const value = "mcp:not-a-tool";',
    querySelector: () => null,
    matches: () => false,
  }), null);
  assert.equal(getMCPCodeInfo({
    textContent: 'mcp:execute_command\n{"command":"pwd"}',
    querySelector: () => null,
    matches: () => false,
  }).toolName, 'execute_command');
});

test('MCP chat UI enhancer runs code folding, system folding, and TTS injection together', () => {
  assert.match(bridgeSource, /function enhanceChatUI\(\) \{\s*enhanceMCPCodeBlocks\(\);\s*collapseSystemInstructions\(\);\s*injectTTSButtons\(\);\s*\}/);
});

test('MCP code block actions create default collapse and resend controls', () => {
  assert.match(bridgeSource, /block\.classList\.add\('mcp-code-hidden'\)/);
  assert.match(bridgeSource, /collapseBtn\.textContent = '展开'/);
  assert.match(bridgeSource, /resendBtn\.textContent = '重发'/);
  assert.match(bridgeSource, /executeToolCall\(latest\.toolName, parseToolArgs\(latest\.rawArgs\)\)/);
});

test('system instruction folding skips already folded content', () => {
  assert.match(bridgeSource, /target\.querySelector\?\.\('\.mcp-sys-fold'\)/);
  assert.match(bridgeSource, /root\.querySelector\?\.\('\.mcp-sys-fold'\)/);
});

test('fetch_page cursor serializes pinned as boolean instead of 1/0', async () => {
  const functions = [extractFunction(enhanceSource, 'fetchSessionsPage')].join('\n\n');
  const sandbox = {
    calls: [],
    URLSearchParams,
    module: { exports: {} },
  };
  sandbox.api = (path) => {
    sandbox.calls.push(path);
    return Promise.resolve({ biz_data: {} });
  };

  vm.runInNewContext(`${functions}
    module.exports = { fetchSessionsPage };
  `, sandbox);

  const { fetchSessionsPage } = sandbox.module.exports;
  await fetchSessionsPage({ pinned: true, updated_at: 123 });
  await fetchSessionsPage({ pinned: false, updated_at: 456 });

  assert.match(sandbox.calls[0], /lte_cursor\.pinned=true/);
  assert.match(sandbox.calls[1], /lte_cursor\.pinned=false/);
  assert.doesNotMatch(sandbox.calls.join('\n'), /lte_cursor\.pinned=[01]/);
});

test('session cursor keeps pinned as boolean', () => {
  const functions = [
    extractFunction(enhanceSource, 'getSessionUpdatedAt'),
    extractFunction(enhanceSource, 'buildSessionCursor'),
  ].join('\n\n');
  const sandbox = { module: { exports: {} } };

  vm.runInNewContext(`${functions}
    module.exports = { buildSessionCursor };
  `, sandbox);

  const { buildSessionCursor } = sandbox.module.exports;

  assert.equal(buildSessionCursor({ id: 'a', pinned: true, updated_at: 1 }).pinned, true);
  assert.equal(buildSessionCursor({ id: 'b', pinned: false, updated_at: 2 }).pinned, false);
});

test('export body falls back to message fragments', () => {
  const functions = [extractFunction(enhanceSource, 'messageText')].join('\n\n');
  const sandbox = { module: { exports: {} } };

  vm.runInNewContext(`${functions}
    module.exports = { messageText };
  `, sandbox);

  const { messageText } = sandbox.module.exports;

  assert.equal(messageText({ fragments: [{ type: 'REQUEST', content: 'hi' }] }), 'hi');
  assert.equal(messageText({ content: 'legacy content' }), 'legacy content');

  const answer = messageText({
    fragments: [
      { type: 'THINK', content: 'let me think' },
      { type: 'TOOL_SEARCH', content: 'Found 3 web pages' },
      { type: 'RESPONSE', content: 'final answer' },
    ],
  });

  assert.match(answer, /let me think/);
  assert.match(answer, /final answer/);
  assert.doesNotMatch(answer, /Found 3 web pages/);
  assert.equal(messageText({ fragments: [] }), '');
});
