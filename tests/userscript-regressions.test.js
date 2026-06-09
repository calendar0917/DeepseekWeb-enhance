const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
function readBuiltOrRoot(filename) {
  const builtPath = path.join(ROOT, 'dist', filename);
  return fs.readFileSync(fs.existsSync(builtPath) ? builtPath : path.join(ROOT, filename), 'utf8');
}

const enhanceSource = readBuiltOrRoot('ds-enhance.user.js');
const bridgeSource = readBuiltOrRoot('ds-mcp-bridge.user.js');
const enhanceEntrySource = fs.readFileSync(path.join(ROOT, 'src/entries/ds-enhance.entry.js'), 'utf8');
const bridgeEntrySource = fs.readFileSync(path.join(ROOT, 'src/entries/ds-mcp-bridge.entry.js'), 'utf8');
const adapterSource = fs.readFileSync(path.join(ROOT, 'src/adapters/deepseek.js'), 'utf8');
const mountSource = fs.readFileSync(path.join(ROOT, 'src/core/dom-mount.js'), 'utf8');
const enhanceStatic = [enhanceSource, enhanceEntrySource, adapterSource, mountSource].join('\n');
const bridgeStatic = [bridgeSource, bridgeEntrySource, adapterSource, mountSource].join('\n');

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
  assert.match(enhanceStatic, /createDeepSeekAdapter\(document\)/);
  assert.match(enhanceStatic, /composerToggles: '\.ds-toggle-button, \[class\*="ds-toggle-button"\]'/);
  assert.match(enhanceStatic, /DeepSeekAdapter\.findComposerToolbar\(\)/);
  assert.match(enhanceStatic, /btn\.className = 'dse-inline-btn'/);
  assert.doesNotMatch(enhanceStatic, /querySelectorAll\('div\[role="button"\]\.ds-toggle-button'\)/);
});

test('DeepSeek native embedding uses debounced mount manager and sidebar hooks', () => {
  assert.match(enhanceStatic, /function createMountManager\(delay = 180, env = \{\}\)/);
  assert.match(enhanceStatic, /nativeMountManager\.register\('composer-prompts'/);
  assert.match(enhanceStatic, /nativeMountManager\.register\('sidebar-native'/);
  assert.match(enhanceStatic, /nativeMountManager\.register\('message-export'/);
  assert.match(enhanceStatic, /function mountQuickBar\(\)/);
  assert.match(enhanceStatic, /id = 'dse-quickbar'/);
  assert.match(enhanceStatic, /mountSearchEntry\(\)/);
  assert.match(enhanceStatic, /mountBatchEntry\(\)/);
  assert.match(enhanceStatic, /openPanelTab\('batch'\)/);
  assert.match(enhanceStatic, /mountCategoryDots\(\)/);
});

test('DS Enhance search supports date category filters and session jump', () => {
  assert.match(enhanceStatic, /id="search-date-from"/);
  assert.match(enhanceStatic, /id="search-date-to"/);
  assert.match(enhanceStatic, /id="search-cat"/);
  assert.match(enhanceStatic, /function openSession\(session\)/);
  assert.match(enhanceStatic, /onOpen: openSession/);
  assert.match(enhanceStatic, /getSessionCats\(s\.id\)\.includes\(catId\)/);
});

test('DS Enhance categories support bulk assignment and import overwrite confirmation', () => {
  assert.match(enhanceStatic, /id="cat-bulk-cat"/);
  assert.match(enhanceStatic, /id="cat-bulk-add"/);
  assert.match(enhanceStatic, /id="cat-bulk-remove"/);
  assert.match(enhanceStatic, /function applyBulkCategory\(mode\)/);
  assert.match(enhanceStatic, /getVisibleCatSessions\(\)\.forEach\(s => selIds\.add\(s\.id\)\)/);
  assert.match(enhanceStatic, /导入会覆盖当前分类和会话映射/);
});

test('DS Enhance export filenames include title and date to avoid overwrites', () => {
  assert.match(enhanceEntrySource, /require\('\.\.\/features\/export\/format'\)/);
  assert.match(enhanceStatic, /exportFileName\(results, 'json'\)/);
  assert.match(enhanceStatic, /exportFileName\(results, 'md'\)/);
  assert.match(enhanceStatic, /id="exp-fragment"/);
  assert.match(enhanceStatic, /function exportCurrentSelectionFragment\(\)/);
  assert.match(enhanceStatic, /function exportMessageFragment\(messageEl\)/);
  assert.match(enhanceStatic, /className = 'dse-msg-export-btn'/);
  assert.match(enhanceStatic, /DeepSeekAdapter\.findMessageActions\(msg\)/);
  assert.match(enhanceStatic, /window\.getSelection\?\.\(\)\.toString\(\)/);
  assert.match(enhanceStatic, /dse-fragment-\$\{sid\}-\$\{date\}\.md/);
});

test('DS Enhance fork picker previews assistant reply and labels fork range', () => {
  assert.match(enhanceStatic, /const findAssistantReply = \(userMsg\) =>/);
  assert.match(enhanceStatic, /const buildForkMessageIds = \(userMsg\) =>/);
  assert.match(enhanceStatic, /助手预览：/);
  assert.match(enhanceStatic, /将 fork 从对话开头到所选用户消息/);
});

test('DS Enhance markdown export renders message tree by parent id', () => {
  assert.match(enhanceStatic, /function renderMarkdownMessageTree\(messages\)/);
  assert.match(enhanceStatic, /byId = new Map/);
  assert.match(enhanceStatic, /parent_id/);
  assert.match(enhanceStatic, /children\.forEach/);
  assert.match(enhanceStatic, /renderMarkdownMessageTree\(r\.messages\)/);
});

test('DS Enhance batch operations show failed items and retry actions', () => {
  assert.match(enhanceStatic, /function renderBatchFailures\(statusEl, failures, retryLabel, retryFn\)/);
  assert.match(enhanceStatic, /class="dse-retry-failures"/);
  assert.match(enhanceStatic, /function runBatchDelete\(ids\)/);
  assert.match(enhanceStatic, /重试失败删除/);
  assert.match(enhanceStatic, /async function runRenameBatch\(renames, rerender\)/);
  assert.match(enhanceStatic, /重试失败重命名/);
});

test('DS Enhance prompt library supports groups variables and ordering', () => {
  assert.match(enhanceStatic, /const LS_CLIPBOARD_CACHE = 'dse_clipboard_cache'/);
  assert.match(enhanceStatic, /function renderPromptTemplate\(content\)/);
  assert.match(enhanceStatic, /replace\(\/\\\{date\\\}\/g, date\)/);
  assert.match(enhanceStatic, /replace\(\/\\\{selection\\\}\/g, selection\)/);
  assert.match(enhanceStatic, /replace\(\/\\\{clipboard\\\}\/g, clipboard\)/);
  assert.match(enhanceStatic, /id="prompt-group"/);
  assert.match(enhanceStatic, /class="btn-pc p-up"/);
  assert.match(enhanceStatic, /class="btn-pc p-down"/);
  assert.match(enhanceStatic, /group: '默认', \.\.\.p/);
});

test('DS Enhance preserves legacy prompt storage during prompt-library migration', () => {
  assert.match(enhanceStatic, /const LS_PROMPT = 'dse_custom_prompt'/);
  assert.match(enhanceStatic, /const LS_PROMPTS = 'dse_prompts'/);
  assert.match(enhanceStatic, /createLocalStorage\(localStorage\)/);
  assert.match(enhanceStatic, /localStore\.getText\(LS_PROMPT, ''\)/);
  assert.match(enhanceStatic, /默认提示词/);
  assert.match(enhanceStatic, /localStore\.setJson\(LS_PROMPTS, arr\)/);
});

test('MCP bridge exposes native composer entry through adapter and mount manager', () => {
  assert.match(bridgeStatic, /createDeepSeekAdapter\(document\)/);
  assert.match(bridgeStatic, /findComposerToolbar\(\)/);
  assert.match(bridgeStatic, /function createMountManager\(delay = 180, env = \{\}\)/);
  assert.match(bridgeStatic, /nativeMountManager\.register\('composer-mcp-entry'/);
  assert.match(bridgeStatic, /const actionBar = currentAdapter\.findMessageActions\(msg\)/);
  assert.doesNotMatch(bridgeEntrySource, /\[class\*="action"\], \[class\*="toolbar"\], \[class\*="buttons"\], \[class\*="footer"\]/);
});

test('DeepSeek DOM selectors stay centralized in adapter module', () => {
  assert.match(adapterSource, /codeBlockCandidates: '\.md-code-block, \[class\*="code-block"\], pre'/);
  assert.match(adapterSource, /systemInstructionRoots: '\.ds-markdown, \.ds-markdown--block, \[class\*="markdown"\], \[data-message-author-role="user"\]'/);
  assert.match(adapterSource, /chatMessageLists: '\[class\*="chat-message-list"\], \[class\*="message-list"\], main'/);
  assert.match(enhanceEntrySource, /DeepSeekAdapter\.findConversationLinks\(\)/);
  assert.match(enhanceEntrySource, /DeepSeekAdapter\.findConversationRow\(link\)/);
  assert.match(enhanceEntrySource, /DeepSeekAdapter\.findConversationTitleHost\(link\)/);
  assert.match(bridgeEntrySource, /currentAdapter\.findMCPCodeBlockCandidates\(\)/);
  assert.match(bridgeEntrySource, /currentAdapter\.findSystemInstructionRoots\(\)/);
  assert.match(bridgeEntrySource, /currentAdapter\.findChatContainer\(\)/);
  assert.doesNotMatch(enhanceEntrySource, /\[class\*="title"\], \[class\*="name"\]/);
  assert.doesNotMatch(bridgeEntrySource, /\[class\*="chat-message-list"\]|\[class\*="message-list"\]|\.md-code-block, \[class\*="code-block"\]|\.ds-markdown, \.ds-markdown--block/);
});

test('MCP bridge records tool result history with copy resend and long-result filing', () => {
  assert.match(bridgeStatic, /const LONG_TOOL_RESULT_LIMIT = 4000/);
  assert.match(bridgeStatic, /const toolHistory = \[\]/);
  assert.match(bridgeStatic, /function shouldFileResult\(toolName, isError, text\)/);
  assert.match(bridgeStatic, /String\(text \|\| ''\)\.length > LONG_TOOL_RESULT_LIMIT/);
  assert.match(bridgeStatic, /function recordToolHistory\(entry\)/);
  assert.match(bridgeStatic, /function renderToolResultCard\(entry\)/);
  assert.match(bridgeStatic, /class="mcp-history-card"/);
  assert.match(bridgeStatic, /copy-result/);
  assert.match(bridgeStatic, /resend-result/);
});

test('MCP external server management shows persistent status summaries', () => {
  assert.match(bridgeStatic, /let lastExtAction = null/);
  assert.match(bridgeStatic, /function serverErrorSummary\(server\)/);
  assert.match(bridgeStatic, /function renderServerToolBadges\(server\)/);
  assert.match(bridgeStatic, /class="ext-summary"/);
  assert.match(bridgeStatic, /启动失败摘要/);
  assert.match(bridgeStatic, /外部 · \$\{esc\(tool\)\}/);
  assert.match(bridgeStatic, /function runExtServerAction\(name, action, label\)/);
  assert.equal((bridgeStatic.match(/querySelectorAll\('\.ext-start'\)/g) || []).length, 1);
});

test('MCP TTS supports per-session autoplay and voice preview', () => {
  assert.match(bridgeStatic, /const TTS_SESSION_AUTOPLAY_PREFIX = 'tts_session_autoplay_'/);
  assert.match(bridgeStatic, /function getCurrentConversationKey\(\)/);
  assert.match(bridgeStatic, /function getSessionAutoPlayEnabled\(\)/);
  assert.match(bridgeStatic, /function setSessionAutoPlayEnabled\(enabled\)/);
  assert.match(bridgeStatic, /function shouldAutoPlayTTSForCurrentSession\(\)/);
  assert.match(bridgeStatic, /id="mcp-cfg-session-autoplay"/);
  assert.match(bridgeStatic, /id="mcp-tts-preview"/);
  assert.match(bridgeStatic, /正在预览 \$\{voice\}/);
  assert.match(bridgeStatic, /shouldAutoPlayTTSForCurrentSession\(\) && !_ttsAutoPlayContainers/);
});

test('MCP bridge keeps existing GM storage keys and adds conservative defaults', () => {
  assert.match(bridgeStatic, /createGMStorage\(GM_getValue, GM_setValue\)/);
  assert.match(bridgeStatic, /gmStore\.get\('mcp_url', DEFAULT_MCP_URL\)/);
  assert.match(bridgeStatic, /const MODULE_DEFAULTS = \{ mcp: true, tts: true, ttsAutoPlay: false \}/);
  assert.match(bridgeStatic, /const AUTO_SEND_KEY = 'auto_send'/);
  assert.match(bridgeStatic, /const CONFIRM_EXEC_KEY = 'confirm_execute_command'/);
  assert.match(bridgeStatic, /const TOOL_WHITELIST_KEY = 'tool_whitelist'/);
  assert.match(bridgeStatic, /const TOOL_BLACKLIST_KEY = 'tool_blacklist'/);
  assert.match(bridgeStatic, /gmStore\.get\(CONFIRM_EXEC_KEY, true\)/);
  assert.match(bridgeStatic, /gmStore\.get\(TTS_SESSION_AUTOPLAY_PREFIX \+ key, false\)/);
});

test('MCP execute_command confirmation warns on dangerous command patterns', () => {
  const functions = [extractFunction(bridgeSource, 'getDangerousCommandWarning')].join('\n\n');
  const sandbox = { module: { exports: {} } };

  vm.runInNewContext(`${functions}
    module.exports = { getDangerousCommandWarning };
  `, sandbox);

  const warn = sandbox.module.exports.getDangerousCommandWarning;

  assert.match(warn('sudo rm -rf /tmp/demo'), /高风险命令/);
  assert.match(warn('dd if=a.img of=/dev/sda'), /高风险命令/);
  assert.equal(warn('pwd && ls -la'), '');
  assert.match(bridgeStatic, /const dangerWarning = getDangerousCommandWarning\(command\)/);
  assert.match(bridgeStatic, /确认执行本地命令\？\$\{warningText\}/);
});

test('MCP tool-call regex accepts dotted and dashed tool names', () => {
  const match = bridgeStatic.match(/const TOOL_CALL_RE = (\/.*?\/g);/);
  assert.ok(match, 'missing TOOL_CALL_RE');
  const regex = vm.runInNewContext(match[1]);

  const content = '```mcp:server.tool-name\n{"path":"/tmp/a"}\n```';
  const parsed = regex.exec(content);

  assert.ok(parsed);
  assert.equal(parsed[1], 'server.tool-name');
  assert.equal(parsed[2].trim(), '{"path":"/tmp/a"}');
});

test('MCP code block parser does not match incidental mcp text in normal code', () => {
  const functions = [extractFunction(bridgeSource, 'getMCPCodeInfo')].join('\n\n');
  const sandbox = {
    module: { exports: {} },
    currentAdapter: {
      findCodeBanner: block => block.banner || null,
      findCodeContentElement: block => block.code || null,
    },
  };

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
  assert.match(bridgeStatic, /function enhanceChatUI\(\) \{\s*enhanceMCPCodeBlocks\(\);\s*collapseSystemInstructions\(\);\s*injectTTSButtons\(\);\s*\}/);
});

test('MCP code block actions create default collapse and resend controls', () => {
  assert.match(bridgeStatic, /block\.classList\.add\('mcp-code-hidden'\)/);
  assert.match(bridgeStatic, /collapseBtn\.textContent = '展开'/);
  assert.match(bridgeStatic, /copyArgsBtn\.textContent = '复制参数'/);
  assert.match(bridgeStatic, /copyText\(latest\.rawArgs \|\| ''\)/);
  assert.match(bridgeStatic, /resendBtn\.textContent = '重发'/);
  assert.match(bridgeStatic, /executeToolCall\(latest\.toolName, parseToolArgs\(latest\.rawArgs\)\)/);
});

test('system instruction folding skips already folded content', () => {
  assert.match(bridgeStatic, /target\.querySelector\?\.\('\.mcp-sys-fold'\)/);
  assert.match(bridgeStatic, /root\.querySelector\?\.\('\.mcp-sys-fold'\)/);
});
