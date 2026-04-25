// ==UserScript==
// @name         DS MCP Bridge
// @namespace    https://github.com/calendar0917/ds-enhance
// @version      2.0.0
// @description  让 DeepSeek Chat 调用本地 MCP 工具（Shell、搜索等）
// @author       ds-enhance
// @match        https://chat.deepseek.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        unsafeWindow
// @run-at       document-start
// ==/UserScript==

(function () {
  'use strict';

  const SCRIPT_PREFIX = '[Bridge]';
  const DEFAULT_MCP_URL = 'http://localhost:8024/mcp';
  const TOOL_CALL_RE = /```mcp:(\w+)\n([\s\S]*?)```/g;

  // ═══════════════════════════════════════════════════════════════
  //  MCP Client (GM_xmlhttpRequest to bypass CORS)
  // ═══════════════════════════════════════════════════════════════
  class MCPClient {
    constructor(url) {
      this.url = url;
      this.sessionId = null;
      this._nextId = 1;
      this.connected = false;
    }

    _post(body) {
      return new Promise((resolve, reject) => {
        const headers = {
          'Content-Type': 'application/json',
          'Accept': 'application/json, text/event-stream',
        };
        if (this.sessionId) headers['Mcp-Session-Id'] = this.sessionId;
        GM_xmlhttpRequest({
          method: 'POST', url: this.url, headers,
          data: JSON.stringify(body),
          onload: (resp) => {
            try {
              const text = resp.responseText;
              if (resp.responseHeaders?.includes('text/event-stream')) {
                for (const line of text.split('\n')) {
                  if (line.startsWith('data: ')) { resolve(JSON.parse(line.slice(6))); return; }
                }
                reject(new Error('No data in SSE response'));
              } else {
                resolve(JSON.parse(text));
              }
            } catch (e) { reject(new Error(`Parse error: ${e.message}`)); }
          },
          onerror: (e) => reject(new Error(`Network error: ${e.error || 'connection refused'}`)),
          ontimeout: () => reject(new Error('Request timed out')),
          timeout: 30000,
        });
      });
    }

    async _rpc(method, params = {}) {
      const id = this._nextId++;
      const resp = await this._post({ jsonrpc: '2.0', id, method, params });
      if (resp.error) throw new Error(`MCP error: ${resp.error.message}`);
      return resp.result;
    }

    async initialize() {
      try {
        const result = await this._rpc('initialize', {
          protocolVersion: '2025-03-26', capabilities: {},
          clientInfo: { name: 'ds-mcp-bridge', version: '2.0.0' },
        });
        this.sessionId = result.sessionId;
        this.connected = true;
        await this._post({ jsonrpc: '2.0', method: 'notifications/initialized' });
        console.log(`${SCRIPT_PREFIX} MCP session initialized: ${this.sessionId}`);
        return true;
      } catch (e) { console.error(`${SCRIPT_PREFIX} Init failed:`, e.message); this.connected = false; return false; }
    }

    async listTools() {
      if (!this.connected) await this.initialize();
      const result = await this._rpc('tools/list');
      return result.tools || [];
    }

    async callTool(name, args = {}) {
      if (!this.connected) await this.initialize();
      return this._rpc('tools/call', { name, arguments: args });
    }

    async checkHealth() {
      try {
        const resp = await new Promise((resolve, reject) => {
          GM_xmlhttpRequest({
            method: 'GET', url: this.url.replace('/mcp', '/health'),
            onload: (r) => resolve(JSON.parse(r.responseText)),
            onerror: (e) => reject(e), timeout: 5000,
          });
        });
        return resp.status === 'ok';
      } catch { return false; }
    }
  }

  // ═══════════════════════════════════════════════════════════════
  //  Tool Registry & Hint Builder
  // ═══════════════════════════════════════════════════════════════
  let toolRegistry = [];

  function buildToolHint() {
    if (!toolRegistry.length) return '';
    let hint = '[系统指令] 你拥有以下 MCP 工具。当用户的需求可以用工具完成时，你必须在回复中调用工具。';
    hint += ' 调用格式：用代码块写 ```mcp:工具名``` 后紧跟一个 JSON 代码块写参数。\n\n';
    hint += '示例：\n```mcp:execute_command\n{"command": "ls -la"}\n```\n\n';
    hint += '可用工具列表：\n';
    toolRegistry.forEach(t => {
      hint += `- ${t.name}: ${t.description || ''}`;
      const req = t.inputSchema?.required;
      if (req?.length) hint += ` (参数: ${req.join(', ')})`;
      hint += '\n';
    });
    hint += '\n如果不需要工具就正常回答。需要工具时一定要调用。';
    return hint;
  }

  function injectHint(bodyStr) {
    if (!toolRegistry.length || !bodyStr) return bodyStr;
    try {
      const parsed = JSON.parse(bodyStr);
      const hint = buildToolHint();
      let injected = false;

      if (parsed.prompt && typeof parsed.prompt === 'string' && !parsed.prompt.includes('[系统指令] 你拥有以下 MCP 工具')) {
        parsed.prompt = hint + '\n\n' + parsed.prompt;
        injected = true;
      }
      if (!injected && parsed.messages?.length) {
        const lastMsg = parsed.messages[parsed.messages.length - 1];
        const content = lastMsg?.content;
        if (typeof content === 'string' && !content.includes('[系统指令] 你拥有以下 MCP 工具')) {
          lastMsg.content = hint + '\n\n' + content;
          injected = true;
        } else if (Array.isArray(content)) {
          const textPart = content.find(p => p.type === 'text');
          if (textPart && !textPart.text.includes('[系统指令]')) {
            textPart.text = hint + '\n\n' + textPart.text;
            injected = true;
          }
        }
      }

      if (injected) { console.log(`${SCRIPT_PREFIX} ✅ Tool hint injected`); return JSON.stringify(parsed); }
    } catch { /* not JSON */ }
    return bodyStr;
  }

  // ═══════════════════════════════════════════════════════════════
  //  XHR Hook — SSE stream reading via progress events
  //  Key insight from mcp-bridge: XHR 'progress' event fires during
  //  SSE streaming and responseText IS accessible at that point.
  //  (Unlike load/readystatechange which fire after stream ends.)
  // ═══════════════════════════════════════════════════════════════
  const callHistory = [];
  const executedCalls = new Set();
  let _streamContent = ''; // accumulates content across progress events
  let _streamDebounce = null;

  function checkForToolCalls(content) {
    if (!content) return;
    const re = new RegExp(TOOL_CALL_RE.source, 'g');
    let match;
    while ((match = re.exec(content)) !== null) {
      const toolName = match[1];
      const rawArgs = match[2].trim();
      let args = {};
      try { args = JSON.parse(rawArgs); }
      catch { args = { input: rawArgs }; }

      const key = toolName + ':' + JSON.stringify(args);
      if (executedCalls.has(key)) continue;
      executedCalls.add(key);

      console.log(`${SCRIPT_PREFIX} 🔧 Tool call detected: ${toolName}`, args);
      executeToolCall(toolName, args);
    }
  }

  function parseSSEChunk(rawText) {
    let content = '';
    const lines = rawText.split('\n');
    for (const line of lines) {
      if (line.startsWith('data: ')) {
        const data = line.slice(6).trim();
        if (data === '[DONE]') continue;
        try {
          const chunk = JSON.parse(data);
          const c = chunk?.choices?.[0]?.delta?.content;
          if (c) content += c;
        } catch { /* skip */ }
      }
    }
    return content;
  }

  // ── Hook XHR ──
  const XHRProto = unsafeWindow.XMLHttpRequest.prototype;
  const origOpen = XHRProto.open;
  const origSend = XHRProto.send;
  const xhrMeta = new WeakMap();

  XHRProto.open = function (method, url, ...rest) {
    xhrMeta.set(this, { url, method });
    return origOpen.apply(this, [method, url, ...rest]);
  };

  XHRProto.send = function (body) {
    const meta = xhrMeta.get(this);
    if (!meta) return origSend.apply(this, [body]);

    const isCompletion = meta.url.includes('completion');
    if (isCompletion) {
      console.log(`${SCRIPT_PREFIX} [XHR] send → ${meta.url.substring(0, 80)}`);

      if (body && toolRegistry.length) body = injectHint(body);

      let requestContent = '';
      let requestLastLen = 0;

      this.addEventListener('progress', function () {
        console.log(`${SCRIPT_PREFIX} [XHR] progress fired!`);
        try {
          const rt = this.responseText || '';
          if (rt.length <= requestLastLen) return;
          requestLastLen = rt.length;
          requestContent = parseSSEChunk(rt);
          console.log(`${SCRIPT_PREFIX} [XHR] progress content len=${requestContent.length}`);

          if (_streamDebounce) clearTimeout(_streamDebounce);
          _streamDebounce = setTimeout(() => {
            if (requestContent) checkForToolCalls(requestContent);
          }, 1000);
        } catch (e) { console.log(`${SCRIPT_PREFIX} [XHR] progress error: ${e.message}`); }
      });

      this.addEventListener('load', function () {
        console.log(`${SCRIPT_PREFIX} [XHR] load fired`);
        try {
          const rt = this.responseText || '';
          console.log(`${SCRIPT_PREFIX} [XHR] load responseText len=${rt.length}`);
          if (rt) {
            requestContent = parseSSEChunk(rt);
            console.log(`${SCRIPT_PREFIX} [XHR] load parsed content len=${requestContent.length}`);
          }
        } catch (e) { console.log(`${SCRIPT_PREFIX} [XHR] load error: ${e.message}`); }
        if (_streamDebounce) clearTimeout(_streamDebounce);
        checkForToolCalls(requestContent);
      });
    }

    return origSend.apply(this, [body]);
  };

  // ── Hook fetch (backup) ──
  const origFetch = unsafeWindow.fetch;

  unsafeWindow.fetch = async function (...args) {
    const url = (typeof args[0] === 'string') ? args[0] : args[0]?.url;

    if (url && url.includes('completion')) {
      console.log(`${SCRIPT_PREFIX} [fetch] → ${url.substring(0, 80)}`);

      // Inject tool hint
      if (args[1]?.body && toolRegistry.length) {
        args[1].body = injectHint(args[1].body);
      }

      const response = await origFetch.apply(this, args);
      const contentType = response.headers?.get('content-type') || '';
      console.log(`${SCRIPT_PREFIX} [fetch] response content-type: ${contentType}`);

      // Check if this is a streaming response
      if (contentType.includes('stream') || contentType.includes('event-stream')) {
        console.log(`${SCRIPT_PREFIX} [fetch] SSE streaming response detected, reading via clone()`);
        const clone = response.clone();

        clone.text().then(text => {
          console.log(`${SCRIPT_PREFIX} [fetch] clone text len=${text.length}`);
          const content = parseSSEChunk(text);
          console.log(`${SCRIPT_PREFIX} [fetch] parsed content len=${content.length}`);
          if (content) checkForToolCalls(content);
        }).catch(e => console.error(`${SCRIPT_PREFIX} [fetch] clone read error:`, e));
      } else {
        // Non-streaming, try to read directly
        const clone = response.clone();
        clone.text().then(text => {
          console.log(`${SCRIPT_PREFIX} [fetch] non-stream response len=${text.length}`);
          try {
            const data = JSON.parse(text);
            console.log(`${SCRIPT_PREFIX} [fetch] JSON keys:`, Object.keys(data));
          } catch {}
        }).catch(() => {});
      }

      return response;
    }

    return origFetch.apply(this, args);
  };

  // ═══════════════════════════════════════════════════════════════
  //  Tool Execution
  // ═══════════════════════════════════════════════════════════════
  let autoExecute = false;

  async function executeToolCall(toolName, args) {
    const mcpUrl = GM_getValue('mcp_url', DEFAULT_MCP_URL);
    const client = new MCPClient(mcpUrl);

    const record = { time: Date.now(), tool: toolName, args, status: 'running', result: null };
    callHistory.unshift(record);
    if (callHistory.length > 50) callHistory.pop();
    unsafeWindow.dispatchEvent(new CustomEvent('dse-mcp-toolcall', { detail: record }));

    if (!autoExecute) {
      toast(`检测到工具调用: ${toolName}，请在面板中开启自动执行`, 'info');
      console.log(`${SCRIPT_PREFIX} Tool call (auto-exec off): ${toolName}`, args);
      return;
    }

    try {
      toast(`调用工具: ${toolName}...`, 'info');
      const result = await client.callTool(toolName, args);
      const resultText = result?.content?.[0]?.text || '(no result)';
      const isError = result?.isError;

      record.status = isError ? 'error' : 'success';
      record.result = resultText;

      toast(`${isError ? '失败' : '成功'}: ${toolName}`, isError ? 'error' : 'success');
      console.log(`${SCRIPT_PREFIX} Tool result (${toolName}):`, resultText.substring(0, 500));

      // Inject result back into chat
      if (!isError) {
        injectResultToChat(toolName, resultText);
      } else {
        injectResultToChat(toolName, `Error: ${resultText}`);
      }

    } catch (e) {
      record.status = 'error';
      record.result = e.message;
      toast(`工具调用失败: ${e.message}`, 'error');
      console.error(`${SCRIPT_PREFIX} Tool error:`, e);
      injectResultToChat(toolName, `Error: ${e.message}`);
    }
  }

  // ═══════════════════════════════════════════════════════════════
  //  Result Injection — based on mcp-bridge's input_injector.js
  //
  //  Wraps result in <tool_result> tags, injects into the chat
  //  textarea/contenteditable, and simulates Enter to send.
  //  The system prompt tells the AI to understand these tags.
  // ═══════════════════════════════════════════════════════════════
  function injectResultToChat(toolName, resultText) {
    setTimeout(async () => {
      const wrappedText = `<tool_result>\n${resultText}\n</tool_result>`;

      // Find input element
      const input = findInputElement();
      if (!input) {
        console.log(`${SCRIPT_PREFIX} ⚠️ Could not find chat input element`);
        toast('找不到聊天输入框', 'error');
        return;
      }

      console.log(`${SCRIPT_PREFIX} Found input: ${input.tagName} (contentEditable=${input.contentEditable})`);

      // Focus
      input.focus();
      await sleep(200);

      // Set value (handles both textarea and contenteditable)
      setInputValue(input, wrappedText);
      await sleep(500);

      // Simulate Enter key to send
      simulateEnter(input);
      console.log(`${SCRIPT_PREFIX} ✅ Result injected and Enter sent`);

      toast(`工具结果已发送给 DeepSeek`, 'success');
    }, 1500);
  }

  function findInputElement() {
    // Try contenteditable first (DeepSeek likely uses this)
    const editables = document.querySelectorAll('[contenteditable="true"]');
    for (const el of editables) {
      if (isVisible(el)) return el;
    }
    // Fallback to textarea
    const textareas = document.querySelectorAll('textarea');
    for (const ta of textareas) {
      if (isVisible(ta)) return ta;
    }
    // Generic fallbacks
    const fallbacks = [
      'textarea[placeholder*="输入"]', 'textarea[placeholder*="问"]',
      'textarea', '[contenteditable="true"]', 'input[type="text"]',
    ];
    for (const sel of fallbacks) {
      const el = document.querySelector(sel);
      if (el && isVisible(el)) return el;
    }
    return null;
  }

  function isVisible(el) {
    return !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
  }

  function setInputValue(element, value) {
    const isCE = element.contentEditable === 'true';

    if (isCE) {
      // contenteditable: use execCommand + InputEvent
      element.focus();
      const sel = unsafeWindow.getSelection();
      const range = document.createRange();
      range.selectNodeContents(element);
      sel.removeAllRanges();
      sel.addRange(range);

      element.dispatchEvent(new InputEvent('beforeinput', {
        bubbles: true, cancelable: true, inputType: 'insertText', data: value,
      }));

      try { document.execCommand('insertText', false, value); }
      catch { element.textContent = value; }

      // Move cursor to end
      range.selectNodeContents(element);
      range.collapse(false);
      sel.removeAllRanges();
      sel.addRange(range);
    } else {
      // textarea: use native setter (React compatibility)
      const setter = Object.getOwnPropertyDescriptor(
        unsafeWindow.HTMLTextAreaElement.prototype, 'value'
      )?.set || Object.getOwnPropertyDescriptor(
        unsafeWindow.HTMLInputElement.prototype, 'value'
      )?.set;

      if (setter) setter.call(element, value);
      else element.value = value;
    }

    // Fire all events
    [
      new InputEvent('input', { bubbles: true, cancelable: true, inputType: 'insertText', data: value }),
      new Event('change', { bubbles: true }),
      new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Unidentified' }),
      new KeyboardEvent('keyup', { bubbles: true, cancelable: true, key: 'Unidentified' }),
    ].forEach(e => element.dispatchEvent(e));
  }

  function simulateEnter(element) {
    const init = {
      key: 'Enter', code: 'Enter', keyCode: 13, which: 13,
      bubbles: true, cancelable: true,
    };
    element.dispatchEvent(new KeyboardEvent('keydown', init));
    element.dispatchEvent(new KeyboardEvent('keypress', init));
    element.dispatchEvent(new KeyboardEvent('keyup', init));
  }

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  // ═══════════════════════════════════════════════════════════════
  //  Toast (lightweight, works before DOM ready)
  // ═══════════════════════════════════════════════════════════════
  function toast(msg, type = 'info') {
    if (!document.body) return;
    const colors = { info: '#2a2a3e', success: '#0d3320', error: '#3d0f0f' };
    const el = document.createElement('div');
    el.style.cssText = `position:fixed;bottom:24px;right:24px;z-index:1000001;background:${colors[type]};color:#eee;padding:12px 22px;border-radius:10px;font-size:14px;box-shadow:0 4px 20px rgba(0,0,0,.5);font-family:system-ui;transition:opacity .3s;`;
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(() => { el.style.opacity = '0'; setTimeout(() => el.remove(), 300); }, 3500);
  }

  // ═══════════════════════════════════════════════════════════════
  //  Load UI after DOM ready
  // ═══════════════════════════════════════════════════════════════
  function waitForDOM() {
    return new Promise(resolve => {
      if (document.body) resolve();
      else new MutationObserver(() => { if (document.body) { resolve(); } })
        .observe(document.documentElement, { childList: true });
    });
  }

  waitForDOM().then(initUI);

  // ═══════════════════════════════════════════════════════════════
  //  UI — Control Panel
  // ═══════════════════════════════════════════════════════════════
  function initUI() {
    autoExecute = GM_getValue('auto_execute', false);
    const mcpUrl = GM_getValue('mcp_url', DEFAULT_MCP_URL);

    // ── CSS ──
    const style = document.createElement('style');
    style.textContent = `
      #dse-fab{position:fixed;z-index:999999;width:48px;height:48px;border-radius:50%;background:#059669;color:#fff;border:none;font-size:22px;cursor:grab;display:flex;align-items:center;justify-content:center;box-shadow:0 2px 12px rgba(5,150,105,.4);user-select:none;-webkit-user-select:none;touch-action:none}
      #dse-fab:active{cursor:grabbing}
      #dse-fab:hover{transform:scale(1.1);box-shadow:0 4px 20px rgba(5,150,105,.6)}
      #dse-fab.connected{background:#059669}
      #dse-fab.disconnected{background:#991b1b}

      #dse-panel{position:fixed;z-index:999998;width:460px;max-height:75vh;background:#16161e;color:#eee;border:1px solid #333;border-radius:14px;box-shadow:0 8px 40px rgba(0,0,0,.6);font-family:system-ui;font-size:14px;display:none;flex-direction:column;overflow:hidden}
      #dse-panel.open{display:flex}
      #dse-panel .hd{padding:14px 18px;border-bottom:1px solid #2a2a3a;display:flex;align-items:center;justify-content:space-between}
      #dse-panel .hd h3{margin:0;font-size:15px;font-weight:600}
      #dse-panel .hd .cls{background:none;border:none;color:#888;font-size:20px;cursor:pointer;padding:0 4px}
      #dse-panel .hd .cls:hover{color:#fff}

      #dse-tabs{display:flex;border-bottom:1px solid #2a2a3a;overflow-x:auto;scrollbar-width:none}
      #dse-tabs::-webkit-scrollbar{display:none}
      #dse-tabs button{flex:0 0 auto;padding:9px 14px;background:none;border:none;color:#888;font-size:12px;cursor:pointer;border-bottom:2px solid transparent;transition:color .15s,border-color .15s;white-space:nowrap}
      #dse-tabs button.active{color:#7aa2f7;border-bottom-color:#7aa2f7}
      #dse-tabs button:hover{color:#ccc}

      .dse-bd{flex:1;overflow-y:auto;padding:12px 14px}
      .dse-section{display:none}.dse-section.active{display:block}

      .dse-actions{display:flex;gap:6px;margin-bottom:10px;flex-wrap:wrap}
      .dse-actions button{padding:6px 12px;border-radius:8px;border:1px solid #444;background:#222;color:#eee;font-size:12px;cursor:pointer;transition:background .15s}
      .dse-actions button:hover{background:#333}
      .dse-actions button.pri{background:#059669;border-color:#059669;color:#fff}
      .dse-actions button.pri:hover{background:#10b981}
      .dse-actions button.dng{background:#7f1d1d;border-color:#991b1b}
      .dse-actions button.dng:hover{background:#991b1b}

      .dse-input{width:100%;padding:8px 12px;border-radius:8px;border:1px solid #444;background:#1a1a28;color:#eee;font-size:13px;box-sizing:border-box;outline:none}
      .dse-input:focus{border-color:#7aa2f7}
      .dse-input::placeholder{color:#555}

      .dse-tool-card{padding:10px 12px;background:#1a1a28;border-radius:10px;margin-bottom:8px;border:1px solid #2a2a3a}
      .dse-tool-card h4{margin:0 0 4px;font-size:13px;color:#7aa2f7}
      .dse-tool-card p{margin:0;font-size:12px;color:#888}

      .dse-log-item{padding:8px 10px;border-radius:8px;margin-bottom:6px;font-size:12px;border:1px solid #2a2a3a}
      .dse-log-item .log-head{display:flex;justify-content:space-between;margin-bottom:4px}
      .dse-log-item .log-tool{color:#7aa2f7;font-weight:600}
      .dse-log-item .log-time{color:#555}
      .dse-log-item .log-status{padding:1px 6px;border-radius:4px;font-size:11px}
      .dse-log-item .log-status.success{background:#0d3320;color:#6ee7b7}
      .dse-log-item .log-status.error{background:#3d0f0f;color:#fca5a5}
      .dse-log-item .log-status.running{background:#1a2a4a;color:#7aa2f7}
      .dse-log-item .log-args{color:#888;font-size:11px;white-space:pre-wrap;word-break:break-all}

      .dse-status-dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px}
      .dse-status-dot.green{background:#10b981}
      .dse-status-dot.red{background:#ef4444}
      .dse-status-dot.yellow{background:#f59e0b}
    `;
    document.head.appendChild(style);

    // ── FAB ──
    const fab = document.createElement('button');
    fab.id = 'dse-fab';
    fab.innerHTML = '&#9881;';
    fab.title = 'DS MCP Bridge (可拖动)';
    fab.className = 'disconnected';
    document.body.appendChild(fab);

    // ── Panel ──
    const panel = document.createElement('div');
    panel.id = 'dse-panel';
    panel.innerHTML = `
      <div class="hd"><h3>DS MCP Bridge</h3><button class="cls">&times;</button></div>
      <div id="dse-tabs">
        <button class="active" data-tab="status">MCP 状态</button>
        <button data-tab="test">手动测试</button>
        <button data-tab="history">调用历史</button>
        <button data-tab="settings">设置</button>
      </div>
      <div class="dse-bd">
        <div id="sec-status" class="dse-section active">
          <div id="mcp-conn-status" style="margin-bottom:12px;font-size:13px">
            <span class="dse-status-dot yellow"></span>检测中...
          </div>
          <div class="dse-actions">
            <button id="mcp-connect" class="pri">连接服务器</button>
            <button id="mcp-refresh">刷新工具列表</button>
          </div>
          <div id="mcp-tools-list"></div>
        </div>
        <div id="sec-test" class="dse-section">
          <div style="color:#aaa;font-size:12px;margin-bottom:8px">手动测试工具调用</div>
          <div style="margin-bottom:8px">
            <label style="font-size:12px;color:#888;display:block;margin-bottom:4px">工具名称</label>
            <select id="test-tool" class="dse-input" style="padding:7px 10px;border-radius:8px;border:1px solid #444;background:#1a1a28;color:#eee;font-size:13px;outline:none"><option value="">请先连接服务器</option></select>
          </div>
          <div style="margin-bottom:8px">
            <label style="font-size:12px;color:#888;display:block;margin-bottom:4px">参数 (JSON)</label>
            <textarea id="test-args" class="dse-input" rows="4" placeholder='{"command": "echo hello"}' style="resize:vertical;font-family:monospace"></textarea>
          </div>
          <div class="dse-actions"><button id="test-run" class="pri">执行</button></div>
          <div id="test-result"></div>
        </div>
        <div id="sec-history" class="dse-section">
          <div class="dse-actions"><button id="hist-clear">清空历史</button></div>
          <div id="hist-list"></div>
        </div>
        <div id="sec-settings" class="dse-section">
          <div style="margin-bottom:12px">
            <label style="font-size:12px;color:#888;display:block;margin-bottom:4px">MCP 服务器地址</label>
            <input type="text" id="cfg-url" class="dse-input" value="${mcpUrl}">
          </div>
          <div style="margin-bottom:12px">
            <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:13px">
              <input type="checkbox" id="cfg-auto" ${autoExecute ? 'checked' : ''} style="width:16px;height:16px">
              自动执行工具调用
            </label>
            <div style="font-size:11px;color:#666;margin-top:4px;margin-left:24px">
              开启后，AI 输出中的工具调用将自动执行，结果会通过聊天输入框发回给 DeepSeek
            </div>
          </div>
          <div class="dse-actions"><button id="cfg-save" class="pri">保存设置</button></div>
        </div>
      </div>
    `;
    document.body.appendChild(panel);

    // ── Drag ──
    let fabDragged = false, fabSX, fabSY, fabOX, fabOY;
    function posPanel() {
      const r = fab.getBoundingClientRect();
      let l = r.left;
      if (l + 460 > innerWidth - 10) l = innerWidth - 470;
      if (l < 10) l = 10;
      panel.style.left = l + 'px';
      panel.style.bottom = (innerHeight - r.top + 10) + 'px';
      panel.style.top = 'auto';
    }
    fab.addEventListener('pointerdown', (e) => {
      if (e.button) return;
      fabDragged = false; fabSX = e.clientX; fabSY = e.clientY;
      const r = fab.getBoundingClientRect();
      fabOX = e.clientX - r.left; fabOY = e.clientY - r.top;
      const mv = (e) => {
        if (!fabDragged && Math.abs(e.clientX - fabSX) + Math.abs(e.clientY - fabSY) < 5) return;
        fabDragged = true;
        fab.style.left = Math.max(0, Math.min(innerWidth - 48, e.clientX - fabOX)) + 'px';
        fab.style.top = Math.max(0, Math.min(innerHeight - 48, e.clientY - fabOY)) + 'px';
        fab.style.bottom = 'auto';
      };
      const up = () => {
        document.removeEventListener('pointermove', mv);
        document.removeEventListener('pointerup', up);
        if (!fabDragged) { panel.classList.toggle('open'); if (panel.classList.contains('open')) posPanel(); }
        else if (panel.classList.contains('open')) posPanel();
      };
      document.addEventListener('pointermove', mv);
      document.addEventListener('pointerup', up);
      e.preventDefault();
    });
    fab.style.left = '80px';
    fab.style.top = (innerHeight - 68) + 'px';
    panel.querySelector('.cls').onclick = () => panel.classList.remove('open');

    // ── Tabs ──
    panel.querySelectorAll('#dse-tabs button').forEach(btn => {
      btn.onclick = () => {
        panel.querySelectorAll('#dse-tabs button').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const tab = btn.dataset.tab;
        panel.querySelectorAll('.dse-section').forEach(s => s.classList.remove('active'));
        panel.querySelector(`#sec-${tab}`).classList.add('active');
        if (tab === 'status') refreshStatus();
        if (tab === 'history') renderHistory();
      };
    });

    // ── Status ──
    const statusEl = panel.querySelector('#mcp-conn-status');
    const toolsListEl = panel.querySelector('#mcp-tools-list');

    async function refreshStatus() {
      const url = panel.querySelector('#cfg-url')?.value || GM_getValue('mcp_url', DEFAULT_MCP_URL);
      const client = new MCPClient(url);
      statusEl.innerHTML = '<span class="dse-status-dot yellow"></span>检测中...';
      toolsListEl.innerHTML = '';
      const healthy = await client.checkHealth();
      if (!healthy) {
        statusEl.innerHTML = '<span class="dse-status-dot red"></span>服务器未连接（请确保 server.py 正在运行）';
        fab.className = 'disconnected'; toolRegistry = []; updateTestSelect(); return;
      }
      try {
        await client.initialize();
        const tools = await client.listTools();
        toolRegistry = tools;
        statusEl.innerHTML = `<span class="dse-status-dot green"></span>已连接 (${tools.length} 个工具)`;
        fab.className = 'connected';
        tools.forEach(t => {
          const card = document.createElement('div');
          card.className = 'dse-tool-card';
          card.innerHTML = `<h4>${t.name}</h4><p>${t.description || ''}</p>`;
          toolsListEl.appendChild(card);
        });
        updateTestSelect();
      } catch (e) {
        statusEl.innerHTML = `<span class="dse-status-dot red"></span>连接失败: ${e.message}`;
        fab.className = 'disconnected'; toolRegistry = []; updateTestSelect();
      }
    }
    panel.querySelector('#mcp-connect').onclick = refreshStatus;
    panel.querySelector('#mcp-refresh').onclick = refreshStatus;

    // ── Test ──
    const testToolSelect = panel.querySelector('#test-tool');
    const testArgsInput = panel.querySelector('#test-args');
    const testResultEl = panel.querySelector('#test-result');

    function updateTestSelect() {
      testToolSelect.innerHTML = '';
      if (!toolRegistry.length) { testToolSelect.innerHTML = '<option value="">请先连接服务器</option>'; return; }
      toolRegistry.forEach(t => {
        const opt = document.createElement('option');
        opt.value = t.name; opt.textContent = `${t.name} — ${t.description || ''}`;
        testToolSelect.appendChild(opt);
      });
    }

    panel.querySelector('#test-run').onclick = async () => {
      const toolName = testToolSelect.value;
      if (!toolName) { toast('请先连接服务器', 'error'); return; }
      let args = {};
      const raw = testArgsInput.value.trim();
      if (raw) { try { args = JSON.parse(raw); } catch (e) { toast(`JSON 错误: ${e.message}`, 'error'); return; } }
      testResultEl.innerHTML = '<div style="color:#888">执行中...</div>';
      try {
        const client = new MCPClient(GM_getValue('mcp_url', DEFAULT_MCP_URL));
        const result = await client.callTool(toolName, args);
        const text = result?.content?.[0]?.text || '(no result)';
        const err = result?.isError;
        testResultEl.innerHTML = `<div style="color:${err ? '#fca5a5' : '#6ee7b7'}">${esc(text)}</div>`;
        toast(err ? '工具返回错误' : '执行成功', err ? 'error' : 'success');
      } catch (e) {
        testResultEl.innerHTML = `<div style="color:#fca5a5">Error: ${esc(e.message)}</div>`;
        toast(`失败: ${e.message}`, 'error');
      }
    };

    // ── History ──
    const histListEl = panel.querySelector('#hist-list');
    function renderHistory() {
      histListEl.innerHTML = '';
      if (!callHistory.length) { histListEl.innerHTML = '<div style="color:#555;font-size:13px;padding:12px 0">暂无记录</div>'; return; }
      callHistory.forEach(r => {
        const item = document.createElement('div'); item.className = 'dse-log-item';
        const t = new Date(r.time);
        const ts = `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}:${String(t.getSeconds()).padStart(2, '0')}`;
        item.innerHTML = `<div class="log-head"><span class="log-tool">${r.tool}</span><span><span class="log-status ${r.status}">${r.status}</span> <span class="log-time">${ts}</span></span></div><div class="log-args">${esc(JSON.stringify(r.args))}</div>${r.result ? `<div class="log-args" style="margin-top:4px;color:#6ee7b7">${esc(r.result.substring(0, 200))}</div>` : ''}`;
        histListEl.appendChild(item);
      });
    }
    panel.querySelector('#hist-clear').onclick = () => { callHistory.length = 0; renderHistory(); };

    // ── Settings ──
    panel.querySelector('#cfg-save').onclick = () => {
      GM_setValue('mcp_url', panel.querySelector('#cfg-url').value.trim());
      GM_setValue('auto_execute', panel.querySelector('#cfg-auto').checked);
      autoExecute = panel.querySelector('#cfg-auto').checked;
      toast('设置已保存', 'success'); refreshStatus();
    };

    // ── Keyboard ──
    document.addEventListener('keydown', (e) => {
      if (e.ctrlKey && e.shiftKey && e.key === 'M') {
        e.preventDefault(); panel.classList.toggle('open');
        if (panel.classList.contains('open')) posPanel();
      }
    });

    setTimeout(refreshStatus, 1000);

    function esc(t) { const d = document.createElement('div'); d.textContent = t; return d.innerHTML; }
    console.log(`${SCRIPT_PREFIX} DS MCP Bridge v2.0.0 loaded — Ctrl+Shift+M or 绿色按钮`);
  }
})();
