// ==UserScript==
// @name         DS MCP Bridge
// @namespace    https://github.com/calendar0917/ds-enhance
// @version      3.0.0
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
  const EXECUTED_CALLS_MAX_SIZE = 100;

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
        console.log(`${SCRIPT_PREFIX} MCP connected: ${this.sessionId}`);
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
    hint += '\n\n当收到用户发送的 <tool_result> 包裹的文本时，这是你之前调用的工具的执行结果。请基于结果继续回答用户的问题。';
    return hint;
  }

  function modifyRequest(bodyStr) {
    if (!toolRegistry.length || !bodyStr) return bodyStr;
    try {
      const parsed = JSON.parse(bodyStr);
      const hint = buildToolHint();
      if (!hint) return bodyStr;
      if (bodyStr.includes('[系统指令] 你拥有以下 MCP 工具')) return bodyStr;

      if (parsed.prompt && typeof parsed.prompt === 'string') {
        parsed.prompt = hint + '\n\n' + parsed.prompt;
        console.log(`${SCRIPT_PREFIX} Tool hint injected`);
        return JSON.stringify(parsed);
      }
      if (parsed.messages?.length) {
        const lastMsg = parsed.messages[parsed.messages.length - 1];
        const content = lastMsg?.content;
        if (typeof content === 'string') {
          lastMsg.content = hint + '\n\n' + content;
          console.log(`${SCRIPT_PREFIX} Tool hint injected`);
          return JSON.stringify(parsed);
        }
        if (Array.isArray(content)) {
          const textPart = content.find(p => p.type === 'text');
          if (textPart && !textPart.text.includes('[系统指令]')) {
            textPart.text = hint + '\n\n' + textPart.text;
            console.log(`${SCRIPT_PREFIX} Tool hint injected`);
            return JSON.stringify(parsed);
          }
        }
      }
    } catch { /* not JSON */ }
    return bodyStr;
  }

  // ═══════════════════════════════════════════════════════════════
  //  SSE Parsing — DeepSeek native format + OpenAI compatible
  // ═══════════════════════════════════════════════════════════════
  const executedCalls = new Set();
  let _streamDebounce = null;
  let _lastSessionId = null;

  function clearExecutedCalls() {
    executedCalls.clear();
    console.log(`${SCRIPT_PREFIX} Cleared executed calls cache`);
  }

  function addExecutedCall(key) {
    if (executedCalls.size >= EXECUTED_CALLS_MAX_SIZE) {
      const firstKey = executedCalls.values().next().value;
      executedCalls.delete(firstKey);
    }
    executedCalls.add(key);
  }

  function detectNewConversation() {
    const sessionId = getSessionId();
    if (sessionId && sessionId !== _lastSessionId) {
      _lastSessionId = sessionId;
      clearExecutedCalls();
    }
  }

  function getSessionId() {
    const m = location.pathname.match(/\/s\/([a-f0-9-]+)/);
    return m ? m[1] : null;
  }

  function checkForToolCalls(content) {
    if (!content || !toolRegistry.length) return;

    detectNewConversation();

    // Strategy 1: Match ```mcp:tool_name\n{...}\n```
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
      addExecutedCall(key);

      console.log(`${SCRIPT_PREFIX} Tool call: ${toolName}`, args);
      executeToolCall(toolName, args);
    }

    // Strategy 2: Match registered tool names directly
    // Handles SSE token boundary truncation
    for (const tool of toolRegistry) {
      const name = tool.name;
      const idx = content.indexOf(name);
      if (idx === -1) continue;

      const afterName = content.substring(idx + name.length);
      const braceStart = afterName.indexOf('{');
      if (braceStart === -1) continue;

      const braceEnd = afterName.indexOf('}', braceStart);
      if (braceEnd === -1) continue;

      const jsonStr = afterName.substring(braceStart, braceEnd + 1);
      let args = {};
      try { args = JSON.parse(jsonStr); }
      catch { args = { input: jsonStr }; }

      const key = name + ':' + JSON.stringify(args);
      if (executedCalls.has(key)) continue;
      addExecutedCall(key);

      console.log(`${SCRIPT_PREFIX} Tool call: ${name}`, args);
      executeToolCall(name, args);
    }
  }

  function parseSSEChunk(rawText) {
    let content = '';
    const lines = rawText.split('\n');

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith('data: ')) continue;

      const jsonStr = trimmed.slice(6).trim();
      if (jsonStr === '[DONE]') continue;

      try {
        const obj = JSON.parse(jsonStr);

        // DeepSeek native: {"p":"response/content","o":"SET","v":"text"}
        const v = obj.v;
        if (typeof v === 'string' && v.length > 0) {
          const p = obj.p || '';
          if (!p.includes('fragments') && !p.includes('status')) {
            content += v;
          }
          continue;
        }

        // OpenAI streaming: choices[0].delta.content
        const c = obj?.choices?.[0]?.delta?.content;
        if (c) { content += c; continue; }

        // OpenAI non-streaming: choices[0].message.content
        const mc = obj?.choices?.[0]?.message?.content;
        if (mc) { content += mc; continue; }

      } catch { /* not JSON, skip */ }
    }

    return content;
  }

  // ═══════════════════════════════════════════════════════════════
  //  XHR Hook — SSE stream reading via progress events
  // ═══════════════════════════════════════════════════════════════
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
      if (body) body = modifyRequest(body);

      let requestContent = '';
      let requestLastLen = 0;

      this.addEventListener('progress', function () {
        try {
          const rt = this.responseText || '';
          if (rt.length <= requestLastLen) return;
          requestLastLen = rt.length;
          requestContent = parseSSEChunk(rt);

          if (_streamDebounce) clearTimeout(_streamDebounce);
          _streamDebounce = setTimeout(() => {
            if (requestContent) checkForToolCalls(requestContent);
          }, 1000);
        } catch { /* ignore */ }
      });

      this.addEventListener('load', function () {
        try {
          const rt = this.responseText || '';
          if (rt) requestContent = parseSSEChunk(rt);
        } catch { /* ignore */ }
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
      if (args[1]?.body) {
        args[1].body = modifyRequest(args[1].body);
      }

      const response = await origFetch.apply(this, args);
      const contentType = response.headers?.get('content-type') || '';

      const clone = response.clone();
      clone.text().then(text => {
        const content = parseSSEChunk(text);
        if (content) checkForToolCalls(content);
      }).catch(() => {});

      return response;
    }

    return origFetch.apply(this, args);
  };

  // ═══════════════════════════════════════════════════════════════
  //  Tool Execution & Result Injection
  // ═══════════════════════════════════════════════════════════════
  async function executeToolCall(toolName, args) {
    const mcpUrl = GM_getValue('mcp_url', DEFAULT_MCP_URL);
    const client = new MCPClient(mcpUrl);

    try {
      toast(`调用工具: ${toolName}...`, 'info');
      const result = await client.callTool(toolName, args);
      const resultText = result?.content?.[0]?.text || '(no result)';
      const isError = result?.isError;

      toast(isError ? `${toolName} 失败` : `${toolName} 完成`, isError ? 'error' : 'success');
      injectResultToChat(isError ? `Error: ${resultText}` : resultText);
    } catch (e) {
      toast(`工具调用失败: ${e.message}`, 'error');
      console.error(`${SCRIPT_PREFIX} Tool error:`, e);
      injectResultToChat(`Error: ${e.message}`);
    }
  }

  function injectResultToChat(resultText) {
    const wrappedText = `<tool_result>\n${resultText}\n</tool_result>`;
    
    const tryInject = (retries = 0) => {
      const input = findInputElement();
      if (!input) {
        if (retries < 5) {
          setTimeout(() => tryInject(retries + 1), 500);
        } else {
          toast('找不到聊天输入框', 'error');
        }
        return;
      }

      input.focus();
      setInputValue(input, wrappedText);
      
      setTimeout(() => {
        const sendBtn = findSendButton();
        if (sendBtn) {
          sendBtn.click();
          toast('工具结果已发送', 'success');
        } else {
          simulateEnter(input);
          toast('工具结果已发送', 'success');
        }
      }, 300);
    };

    setTimeout(() => tryInject(), 800);
  }

  function findInputElement() {
    for (const ta of document.querySelectorAll('textarea')) {
      if (isVisible(ta)) return ta;
    }
    const editables = document.querySelectorAll('[contenteditable="true"]');
    for (const el of editables) {
      if (isVisible(el) && el.getAttribute('placeholder')) return el;
    }
    for (const el of editables) {
      if (isVisible(el)) return el;
    }
    return null;
  }

  function findSendButton() {
    const selectors = [
      'button[aria-label*="send"]', 'button[aria-label*="Send"]',
      'button[aria-label*="发送"]', 'button[aria-label*="Submit"]',
      'button[type="submit"]', 'div[role="button"][aria-label*="send"]',
      'div[role="button"][aria-label*="发送"]',
    ];
    for (const sel of selectors) {
      const btn = document.querySelector(sel);
      if (btn && isVisible(btn)) return btn;
    }
    return null;
  }

  function isVisible(el) {
    return !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
  }

  function setInputValue(element, value) {
    const isCE = element.contentEditable === 'true';

    if (isCE) {
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

      range.selectNodeContents(element);
      range.collapse(false);
      sel.removeAllRanges();
      sel.addRange(range);
    } else {
      const setter = Object.getOwnPropertyDescriptor(
        unsafeWindow.HTMLTextAreaElement.prototype, 'value'
      )?.set || Object.getOwnPropertyDescriptor(
        unsafeWindow.HTMLInputElement.prototype, 'value'
      )?.set;

      if (setter) setter.call(element, value);
      else element.value = value;
    }

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
  //  Toast
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
  //  CSS
  // ═══════════════════════════════════════════════════════════════
  const PANEL_CSS = `
    #mcp-fab{position:fixed;z-index:999999;width:48px;height:48px;border-radius:50%;background:#16a34a;color:#fff;border:none;font-size:22px;cursor:grab;display:flex;align-items:center;justify-content:center;box-shadow:0 2px 12px rgba(22,163,74,.4);user-select:none;-webkit-user-select:none;touch-action:none}
    #mcp-fab:active{cursor:grabbing}
    #mcp-fab:hover{transform:scale(1.1);box-shadow:0 4px 20px rgba(22,163,74,.6)}
    #mcp-fab.disconnected{background:#dc2626;box-shadow:0 2px 12px rgba(220,38,38,.4)}
    #mcp-fab.disconnected:hover{box-shadow:0 4px 20px rgba(220,38,38,.6)}

    #mcp-panel{position:fixed;z-index:999998;width:460px;max-height:75vh;background:#16161e;color:#eee;border:1px solid #333;border-radius:14px;box-shadow:0 8px 40px rgba(0,0,0,.6);font-family:system-ui;font-size:14px;display:none;flex-direction:column;overflow:hidden}
    #mcp-panel.open{display:flex}
    #mcp-panel .hd{padding:14px 18px;border-bottom:1px solid #2a2a3a;display:flex;align-items:center;justify-content:space-between}
    #mcp-panel .hd h3{margin:0;font-size:15px;font-weight:600}
    #mcp-panel .hd .ver{font-size:11px;color:#666;margin-left:8px}
    #mcp-panel .hd .cls{background:none;border:none;color:#888;font-size:20px;cursor:pointer;padding:0 4px}
    #mcp-panel .hd .cls:hover{color:#fff}

    #mcp-tabs{display:flex;border-bottom:1px solid #2a2a3a;overflow-x:auto;scrollbar-width:none}
    #mcp-tabs::-webkit-scrollbar{display:none}
    #mcp-tabs button{flex:0 0 auto;padding:9px 14px;background:none;border:none;color:#888;font-size:12px;cursor:pointer;border-bottom:2px solid transparent;transition:color .15s,border-color .15s;white-space:nowrap}
    #mcp-tabs button.active{color:#7aa2f7;border-bottom-color:#7aa2f7}
    #mcp-tabs button:hover{color:#ccc}

    .mcp-bd{flex:1;overflow-y:auto;padding:12px 14px}
    .mcp-sec{display:none}.mcp-sec.active{display:block}

    .mcp-btn{padding:6px 12px;border-radius:8px;border:1px solid #444;background:#222;color:#eee;font-size:12px;cursor:pointer;transition:background .15s}
    .mcp-btn:hover{background:#333}
    .mcp-btn.pri{background:#16a34a;border-color:#16a34a;color:#fff}
    .mcp-btn.pri:hover{background:#15803d}
    .mcp-input{width:100%;padding:8px 12px;border-radius:8px;border:1px solid #444;background:#1a1a28;color:#eee;font-size:13px;box-sizing:border-box;outline:none}
    .mcp-input:focus{border-color:#7aa2f7}
    .mcp-input::placeholder{color:#555}
    .mcp-sel{width:100%;padding:7px 10px;border:1px solid #444;border-radius:8px;background:#1a1a28;color:#eee;font-size:13px;outline:none}
    .mcp-sel option{background:#1a1a28}

    .mcp-tool{display:flex;align-items:center;gap:8px;padding:7px 8px;border-radius:8px;transition:background .1s;font-size:13px}
    .mcp-tool:hover{background:#1e1e2e}
    .mcp-tool .name{color:#7aa2f7;font-weight:500}
    .mcp-tool .desc{color:#888;font-size:12px;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

    .mcp-result{margin-top:10px;padding:10px;background:#1a1a28;border-radius:8px;font-size:12px;white-space:pre-wrap;word-break:break-all;max-height:300px;overflow-y:auto;color:#aaa;font-family:monospace}
    .mcp-result.error{color:#f87171}
    .mcp-label{font-size:12px;color:#888;margin-bottom:4px;display:block}
    .mcp-label-row{display:flex;align-items:center;gap:8px;margin-bottom:6px}
    .mcp-status{font-size:13px;padding:8px 0}
    .mcp-status .ok{color:#4ade80}
    .mcp-status .err{color:#f87171}
  `;

  // ═══════════════════════════════════════════════════════════════
  //  FAB + Panel
  // ═══════════════════════════════════════════════════════════════
  function waitForDOM() {
    return new Promise(resolve => {
      if (document.body) resolve();
      else new MutationObserver(() => { if (document.body) resolve(); })
        .observe(document.documentElement, { childList: true });
    });
  }

  waitForDOM().then(() => {
    const style = document.createElement('style');
    style.textContent = PANEL_CSS;
    document.head.appendChild(style);

    const fab = document.createElement('button');
    fab.id = 'mcp-fab';
    fab.innerHTML = '&#9881;';
    fab.title = 'DS MCP Bridge (可拖动)';
    fab.setAttribute('aria-label', 'MCP Bridge 工具面板');
    fab.setAttribute('role', 'button');
    fab.setAttribute('aria-expanded', 'false');
    document.body.appendChild(fab);

    // Panel
    const panel = document.createElement('div');
    panel.id = 'mcp-panel';
    panel.innerHTML = `
      <div class="hd">
        <h3>DS MCP Bridge <span class="ver">v3.0.0</span></h3>
        <button class="cls">&times;</button>
      </div>
      <div id="mcp-tabs">
        <button class="active" data-tab="status">状态</button>
        <button data-tab="test">测试</button>
        <button data-tab="settings">设置</button>
      </div>
      <div class="mcp-bd">
        <div class="mcp-sec active" id="mcp-sec-status"></div>
        <div class="mcp-sec" id="mcp-sec-test"></div>
        <div class="mcp-sec" id="mcp-sec-settings"></div>
      </div>
    `;
    document.body.appendChild(panel);

    // Close button
    panel.querySelector('.cls').onclick = () => panel.classList.remove('open');

    // ── Drag ──
    let fabDragged = false, fabSX, fabSY, fabOX, fabOY;
    const DRAG_TH = 5;

    function posPanel() {
      const r = fab.getBoundingClientRect();
      let l = r.right - 460;
      if (l + 460 > window.innerWidth - 10) l = window.innerWidth - 470;
      if (l < 10) l = 10;
      panel.style.left = l + 'px';
      panel.style.bottom = (window.innerHeight - r.top + 10) + 'px';
      panel.style.top = 'auto';
    }

    fab.addEventListener('pointerdown', (e) => {
      if (e.button) return;
      fabDragged = false; fabSX = e.clientX; fabSY = e.clientY;
      const r = fab.getBoundingClientRect();
      fabOX = e.clientX - r.left; fabOY = e.clientY - r.top;
      const mv = (e) => {
        if (!fabDragged && Math.abs(e.clientX - fabSX) + Math.abs(e.clientY - fabSY) < DRAG_TH) return;
        fabDragged = true;
        fab.style.left = Math.max(0, Math.min(innerWidth - 48, e.clientX - fabOX)) + 'px';
        fab.style.top = Math.max(0, Math.min(innerHeight - 48, e.clientY - fabOY)) + 'px';
        fab.style.bottom = 'auto';
      };
      const up = () => {
        document.removeEventListener('pointermove', mv);
        document.removeEventListener('pointerup', up);
        if (!fabDragged) { 
          panel.classList.toggle('open'); 
          const isOpen = panel.classList.contains('open');
          fab.setAttribute('aria-expanded', String(isOpen));
          if (isOpen) { posPanel(); refreshStatus(); } 
        }
        else if (panel.classList.contains('open')) posPanel();
      };
      document.addEventListener('pointermove', mv);
      document.addEventListener('pointerup', up);
      e.preventDefault();
    });

    fab.style.right = '20px';
    fab.style.left = 'auto';
    fab.style.top = (innerHeight - 68) + 'px';

    // ── Tabs ──
    panel.querySelectorAll('#mcp-tabs button').forEach(btn => {
      btn.onclick = () => {
        panel.querySelectorAll('#mcp-tabs button').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const tab = btn.dataset.tab;
        panel.querySelectorAll('.mcp-sec').forEach(s => s.classList.remove('active'));
        panel.querySelector(`#mcp-sec-${tab}`).classList.add('active');
      };
    });

    // ── Shortcut ──
    document.addEventListener('keydown', (e) => {
      if (e.ctrlKey && e.shiftKey && e.key === 'M') {
        e.preventDefault();
        panel.classList.toggle('open');
        if (panel.classList.contains('open')) { posPanel(); refreshStatus(); }
      }
    });

    // ═══════════════════════════════════════════════════════════════
    //  Tab: Status
    // ═══════════════════════════════════════════════════════════════
    const secStatus = panel.querySelector('#mcp-sec-status');

    async function refreshStatus() {
      const mcpUrl = GM_getValue('mcp_url', DEFAULT_MCP_URL);
      secStatus.innerHTML = '<div class="mcp-status">连接中...</div>';
      const client = new MCPClient(mcpUrl);
      const healthy = await client.checkHealth();

      if (!healthy) {
        fab.classList.add('disconnected');
        toolRegistry = [];
        secStatus.innerHTML = `
          <div class="mcp-status"><span class="err">未连接</span> — 服务器未运行</div>
          <div style="font-size:12px;color:#666;margin-top:8px">
            请先启动 MCP 服务器：<br>
            <code style="color:#7aa2f7">cd server && python server.py</code>
          </div>
          <div style="margin-top:12px">
            <button class="mcp-btn pri" id="mcp-retry">重试连接</button>
          </div>
        `;
        secStatus.querySelector('#mcp-retry').onclick = refreshStatus;
        return;
      }

      const tools = await client.listTools();
      toolRegistry = tools;
      fab.classList.remove('disconnected');

      let toolList = '';
      tools.forEach(t => {
        const desc = t.description || '';
        const req = t.inputSchema?.required;
        const params = req?.length ? ` (${req.join(', ')})` : '';
        toolList += `<div class="mcp-tool"><span class="name">${esc(t.name)}${esc(params)}</span><span class="desc">${esc(desc)}</span></div>`;
      });

      secStatus.innerHTML = `
        <div class="mcp-status"><span class="ok">已连接</span> — ${tools.length} 个工具</div>
        <div style="margin-top:8px">${toolList || '<div style="color:#665">无可用工具</div>'}</div>
        <div style="margin-top:12px">
          <button class="mcp-btn pri" id="mcp-refresh">刷新</button>
        </div>
      `;
      secStatus.querySelector('#mcp-refresh').onclick = refreshStatus;
      console.log(`${SCRIPT_PREFIX} v3.0.0 ready — ${tools.length} tools registered`);
    }

    // ═══════════════════════════════════════════════════════════════
    //  Tab: Test
    // ═══════════════════════════════════════════════════════════════
    const secTest = panel.querySelector('#mcp-sec-test');

    function renderTestTab() {
      if (!toolRegistry.length) {
        secTest.innerHTML = '<div style="color:#665;font-size:13px">请先在"状态"页连接服务器</div>';
        return;
      }

      let opts = '<option value="">选择工具...</option>';
      toolRegistry.forEach(t => { opts += `<option value="${t.name}">${t.name}</option>`; });

      secTest.innerHTML = `
        <div class="mcp-label-row">
          <label class="mcp-label" style="margin:0">工具</label>
        </div>
        <select class="mcp-sel" id="mcp-test-sel">${opts}</select>
        <div id="mcp-test-info" style="margin-top:8px;font-size:12px;color:#666"></div>
        <div id="mcp-test-args" style="margin-top:10px"></div>
        <div style="margin-top:10px">
          <button class="mcp-btn pri" id="mcp-test-run">执行</button>
        </div>
        <div id="mcp-test-result"></div>
      `;

      const sel = secTest.querySelector('#mcp-test-sel');
      const info = secTest.querySelector('#mcp-test-info');
      const argsDiv = secTest.querySelector('#mcp-test-args');
      const resultDiv = secTest.querySelector('#mcp-test-result');

      sel.onchange = () => {
        const tool = toolRegistry.find(t => t.name === sel.value);
        if (!tool) { info.textContent = ''; argsDiv.innerHTML = ''; return; }
        info.textContent = tool.description || '';
        const schema = tool.inputSchema || {};
        const props = schema.properties || {};
        const required = schema.required || [];
        let fields = '';
        for (const [key, prop] of Object.entries(props)) {
          const req = required.includes(key) ? ' *' : '';
          const ph = prop.description || prop.type || '';
          fields += `<div style="margin-bottom:6px">
            <label class="mcp-label">${key}${req}</label>
            <input class="mcp-input" data-arg="${key}" placeholder="${ph}" />
          </div>`;
        }
        if (!fields) fields = '<div style="color:#666;font-size:12px">此工具无需参数</div>';
        argsDiv.innerHTML = fields;
      };

      secTest.querySelector('#mcp-test-run').onclick = async () => {
        const toolName = sel.value;
        if (!toolName) { toast('请选择工具', 'error'); return; }
        const args = {};
        argsDiv.querySelectorAll('.mcp-input').forEach(inp => {
          const key = inp.dataset.arg;
          const val = inp.value.trim();
          if (val) {
            try { args[key] = JSON.parse(val); }
            catch { args[key] = val; }
          }
        });

        resultDiv.innerHTML = '<div class="mcp-result">执行中...</div>';
        const mcpUrl = GM_getValue('mcp_url', DEFAULT_MCP_URL);
        const client = new MCPClient(mcpUrl);
        try {
          const result = await client.callTool(toolName, args);
          const text = result?.content?.[0]?.text || '(no result)';
          const isErr = result?.isError;
          resultDiv.innerHTML = `<div class="mcp-result${isErr ? ' error' : ''}">${esc(text)}</div>`;
        } catch (e) {
          resultDiv.innerHTML = `<div class="mcp-result error">Error: ${esc(e.message)}</div>`;
        }
      };
    }

    // Watch for tab switch to render test tab
    panel.querySelectorAll('#mcp-tabs button').forEach(btn => {
      btn.addEventListener('click', () => { if (btn.dataset.tab === 'test') renderTestTab(); });
    });

    // ═══════════════════════════════════════════════════════════════
    //  Tab: Settings
    // ═══════════════════════════════════════════════════════════════
    const secSettings = panel.querySelector('#mcp-sec-settings');
    secSettings.innerHTML = `
      <div>
        <label class="mcp-label">MCP 服务器地址</label>
        <input class="mcp-input" id="mcp-cfg-url" value="${GM_getValue('mcp_url', DEFAULT_MCP_URL)}" />
      </div>
      <div style="margin-top:12px">
        <button class="mcp-btn pri" id="mcp-cfg-save">保存</button>
      </div>
    `;

    secSettings.querySelector('#mcp-cfg-save').onclick = () => {
      const url = secSettings.querySelector('#mcp-cfg-url').value.trim();
      if (!url) { toast('地址不能为空', 'error'); return; }
      GM_setValue('mcp_url', url);
      toast('已保存', 'success');
      refreshStatus();
    };

    // ── Auto-connect on load ──
    refreshStatus();

    function esc(t) { const d = document.createElement('div'); d.textContent = t; return d.innerHTML; }
  });
})();
