const assert = require('node:assert/strict');
const test = require('node:test');

const { createMountManager } = require('../src/core/dom-mount');
const { createGMStorage, createLocalStorage } = require('../src/core/storage');
const { createModal, createToast, injectStyle, positionFloatingPanel } = require('../src/core/ui');
const { createDeepSeekAdapter, splitSelectorList } = require('../src/adapters/deepseek');
const { exportFileName, renderMarkdownMessageTree, safeFilePart } = require('../src/features/export/format');
const { createToolPolicy, parseToolArgs, parseToolList } = require('../src/features/mcp/tool-policy');

function el(props = {}) {
  return {
    id: props.id || '',
    textContent: props.textContent || '',
    parentElement: props.parentElement || null,
    closest: props.closest || (() => null),
    querySelector: props.querySelector || (() => null),
  };
}

test('createMountManager debounces scheduled mounts and supports unregister', () => {
  const timers = new Map();
  let nextId = 0;
  const env = {
    setTimeout(fn) {
      const id = ++nextId;
      timers.set(id, fn);
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
  };
  const calls = [];
  const manager = createMountManager(10, env);

  manager.register('a', () => calls.push('a'));
  manager.register('b', () => calls.push('b'));
  manager.unregister('b');
  manager.schedule();
  manager.schedule();

  assert.deepEqual(calls, ['a', 'b']);
  assert.equal(timers.size, 1);
  Array.from(timers.values())[0]();
  assert.deepEqual(calls, ['a', 'b', 'a']);
  assert.equal(manager.size(), 1);
});

test('createMountManager observes and disconnects MutationObserver roots', () => {
  let observed = false;
  let disconnected = false;
  class FakeMutationObserver {
    constructor(fn) { this.fn = fn; }
    observe(root, opts) {
      observed = root.ok && opts.childList && opts.subtree;
    }
    disconnect() { disconnected = true; }
  }
  const manager = createMountManager(10, { MutationObserver: FakeMutationObserver });

  assert.equal(manager.observe({ ok: true }), true);
  manager.disconnect();
  assert.equal(observed, true);
  assert.equal(disconnected, true);
});

test('storage helpers preserve text json and GM list behavior', () => {
  const values = new Map();
  const local = createLocalStorage({
    getItem: key => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => values.set(key, value),
  });
  local.setText('text', 'hello');
  local.setJson('json', { ok: true });
  assert.equal(local.getText('text'), 'hello');
  assert.deepEqual(local.getJson('json', null), { ok: true });
  assert.deepEqual(local.getJson('bad', { fallback: true }), { fallback: true });

  const gm = createGMStorage((key, fallback) => values.get(key) ?? fallback, (key, value) => values.set(key, value));
  gm.set('tools', 'a, b\nc');
  assert.deepEqual(gm.getList('tools'), ['a', 'b', 'c']);
});

test('ui helpers inject styles position panels and create transient surfaces', () => {
  const appended = [];
  const removed = [];
  const doc = {
    head: { appendChild: node => appended.push(['head', node]) },
    body: { appendChild: node => appended.push(['body', node]) },
    createElement: tag => ({
      tag,
      style: {},
      className: '',
      textContent: '',
      innerHTML: '',
      remove() { removed.push(this); },
      querySelector(selector) {
        if (selector === '.dse-modal-box') return { className: 'dse-modal-box' };
        return null;
      },
    }),
  };

  const style = injectStyle(doc, 'body{color:red}');
  assert.equal(style.textContent, 'body{color:red}');
  assert.equal(appended[0][0], 'head');

  const toast = createToast(doc, { duration: 1 });
  const toastEl = toast('ok', 'success');
  assert.equal(toastEl.textContent, 'ok');
  assert.equal(appended[1][0], 'body');

  const panel = { style: {} };
  positionFloatingPanel({
    windowRef: { innerWidth: 500, innerHeight: 800 },
    fab: { getBoundingClientRect: () => ({ left: 480, right: 528, top: 600 }) },
    panel,
    width: 460,
  });
  assert.equal(panel.style.left, '30px');
  assert.equal(panel.style.top, 'auto');

  const modal = createModal(doc, { html: '<div class="dse-modal-box"></div>' });
  assert.equal(modal.box.className, 'dse-modal-box');
  modal.close();
  assert.equal(removed.length, 1);
});

test('DeepSeek adapter selector helpers keep composer sidebar and message fallbacks', () => {
  assert.deepEqual(splitSelectorList('a, b , c'), ['a', 'b', 'c']);

  const toolbar = el();
  const anchor = el({ textContent: '深度思考', parentElement: toolbar });
  const list = el();
  const side = el();
  const link = el({ closest: selector => selector.includes('list') ? list : side });
  const titleHost = el();
  const row = el();
  const conversationLink = {
    closest: selector => selector.includes('item') ? row : null,
    querySelector: selector => selector.includes('title') ? titleHost : null,
  };
  const action = el();
  const buttonHost = { querySelectorAll: selector => selector === ':scope > button' ? [{}] : [] };
  const messageContainer = {
    querySelector: selector => selector.includes('toolbar') ? action : null,
    querySelectorAll: () => [buttonHost],
  };
  const message = el({
    closest: () => messageContainer,
  });
  const assistant = el();
  const systemRoot = el();
  const chatContainer = el();
  const inserted = [];
  const pre = { parentNode: { insertBefore: (node, before) => inserted.push({ node, before }) } };
  const block = {
    querySelector: selector => selector === 'pre' ? pre : selector.includes('code-header') ? { textContent: 'mcp:read_file' } : null,
    matches: () => false,
  };
  const noBannerBlock = {
    querySelector: selector => selector === 'pre' ? pre : null,
    matches: () => false,
  };
  const codeCandidate = { closest: selector => selector.includes('code-block') ? block : null };
  const doc = {
    body: el(),
    querySelectorAll: selector => {
      if (selector.includes('ds-toggle-button')) return [anchor];
      if (selector.includes('/s/')) return [conversationLink];
      if (selector.includes('markdown') && selector.includes('data-message-author-role')) return [systemRoot];
      if (selector.includes('markdown')) return [assistant];
      if (selector.includes('code-block')) return [codeCandidate];
      return [];
    },
    querySelector: selector => {
      if (selector.includes('/s/')) return link;
      if (selector.includes('message-list')) return chatContainer;
      return null;
    },
    createElement: tag => ({ tag, style: {}, dataset: {} }),
  };

  const adapter = createDeepSeekAdapter(doc);

  assert.equal(adapter.findComposerToolbar(), toolbar);
  assert.equal(adapter.findConversationList(), list);
  assert.deepEqual(adapter.findConversationLinks(), [conversationLink]);
  assert.equal(adapter.findConversationRow(conversationLink), row);
  assert.equal(adapter.findConversationTitleHost(conversationLink), titleHost);
  assert.equal(adapter.findMessageContainer(message), messageContainer);
  assert.equal(adapter.findMessageActions(message), action);
  assert.deepEqual(adapter.findAssistantMessages(), [assistant]);
  assert.equal(adapter.findSystemInstructionRoots()[0], systemRoot);
  assert.equal(adapter.findMCPCodeBlockCandidates()[0], block);
  assert.equal(adapter.findCodeBanner(block).textContent, 'mcp:read_file');
  assert.equal(adapter.findCodeContentElement(block), pre);
  assert.equal(adapter.findCodeActionContainer(noBannerBlock).tag, 'div');
  assert.equal(adapter.findChatContainer(), chatContainer);
  assert.equal(inserted.length, 1);
});

test('DeepSeek adapter falls back to composer form and sidebar root when anchors are absent', () => {
  const form = {
    querySelector: () => null,
  };
  const aside = el();
  const doc = {
    body: el(),
    querySelectorAll: () => [],
    querySelector: selector => {
      if (selector.includes('form')) return form;
      if (selector.includes('aside')) return aside;
      return null;
    },
  };
  const adapter = createDeepSeekAdapter(doc);

  assert.equal(adapter.findComposerToolbar(), form);
  assert.equal(adapter.findSidebarHeader(), aside);
});

test('MCP tool policy builds hints and enforces whitelist blacklist settings', () => {
  const values = {
    tool_whitelist: 'execute_command\nread_file',
    tool_blacklist: 'read_file, write_file',
  };
  const policy = createToolPolicy({
    getValue: (key, fallback) => values[key] ?? fallback,
    whitelistKey: 'tool_whitelist',
    blacklistKey: 'tool_blacklist',
    getTools: () => [
      { name: 'execute_command', description: 'run shell', inputSchema: { required: ['command'] } },
      { name: 'write_file', description: 'write file', inputSchema: { required: ['path'] } },
      { name: 'bing_search', description: 'search web', inputSchema: {} },
    ],
    systemHintStart: '[系统指令]',
    systemHintEnd: '[系统指令结束]',
  });

  assert.deepEqual(parseToolList('a, b\nc'), ['a', 'b', 'c']);
  assert.equal(policy.isToolAllowed('execute_command'), true);
  assert.equal(policy.isToolAllowed('read_file'), false);
  assert.equal(policy.isToolAllowed('bing_search'), false);
  const hint = policy.buildToolHint();
  assert.match(hint, /^\[系统指令\]/);
  assert.match(hint, /execute_command/);
  assert.doesNotMatch(hint, /write_file/);
  assert.match(hint, /\[系统指令结束\]$/);
});

test('MCP tool args parser preserves JSON and wraps plain text', () => {
  assert.deepEqual(Object.assign({}, parseToolArgs('{"path":"/tmp/a"}')), { path: '/tmp/a' });
  assert.deepEqual(Object.assign({}, parseToolArgs('plain text')), { input: 'plain text' });
  assert.deepEqual(Object.assign({}, parseToolArgs('')), {});
});

test('DS Enhance export format creates safe filenames and message trees', () => {
  assert.equal(safeFilePart('bad/name: title'), 'bad-name- title');
  assert.match(exportFileName([{ session: { id: 's1', title: 'A/B', updated_at: 1717200000 } }], 'md'), /^A-B-\d{4}-\d{2}-\d{2}\.md$/);
  assert.match(exportFileName([{ session: { id: 'a' } }, { session: { id: 'b' } }], 'json'), /^dse-export-2-sessions-\d{4}-\d{2}-\d{2}\.json$/);

  const tree = renderMarkdownMessageTree([
    { message_id: '1', role: 'USER', content: 'root' },
    { message_id: '2', parent_id: '1', role: 'ASSISTANT', content: 'child' },
  ]);
  assert.match(tree, /用户 #1/);
  assert.match(tree, /助手 #2 分支层级 1/);
  assert.match(tree, /child/);
});
