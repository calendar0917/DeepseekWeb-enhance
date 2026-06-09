// ==UserScript==
// @name         DS MCP Bridge
// @namespace    https://github.com/calendar0917/DeepseekWeb-enhance
// @version      4.2.1
// @description  DeepSeek Chat 增强 — MCP 工具调用 + TTS 朗读
// @author       ds-enhance
// @homepageURL  https://github.com/calendar0917/DeepseekWeb-enhance
// @supportURL   https://github.com/calendar0917/DeepseekWeb-enhance/issues
// @downloadURL  https://raw.githubusercontent.com/calendar0917/DeepseekWeb-enhance/main/ds-mcp-bridge.user.js
// @updateURL    https://raw.githubusercontent.com/calendar0917/DeepseekWeb-enhance/main/ds-mcp-bridge.user.js
// @license      GPL-3.0
// @icon         https://fe-static.deepseek.com/chat/favicon.svg
// @match        https://chat.deepseek.com/*
// @connect      localhost
// @connect      127.0.0.1
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        unsafeWindow
// @run-at       document-start
// ==/UserScript==

(function () {
  'use strict';

  const { createMountManager } = require('../core/dom-mount');
  const { createGMStorage } = require('../core/storage');
  const { createToast, injectStyle, positionFloatingPanel } = require('../core/ui');
  const { createDeepSeekAdapter } = require('../adapters/deepseek');
  const { createToolPolicy, parseToolArgs } = require('../features/mcp/tool-policy');

  const SCRIPT_PREFIX = '[Bridge]';
  const DEFAULT_MCP_URL = 'http://localhost:8024/mcp';
  const TOOL_CALL_RE = /```mcp:([\w.-]+)\n([\s\S]*?)```/g;
  const SYSTEM_HINT_START = '[系统指令]';
  const SYSTEM_HINT_END = '[系统指令结束]';
  const AUTO_SEND_KEY = 'auto_send';
  const TOOL_WHITELIST_KEY = 'tool_whitelist';
  const TOOL_BLACKLIST_KEY = 'tool_blacklist';
  const CONFIRM_EXEC_KEY = 'confirm_execute_command';
  const TTS_SESSION_AUTOPLAY_PREFIX = 'tts_session_autoplay_';
  const LONG_TOOL_RESULT_LIMIT = 4000;
  const DEFAULT_AUTO_SEND = true;

  // ═══════════════════════════════════════════════════════════════
  //  Module Toggles (top-level so XHR/fetch hooks can access)
  // ═══════════════════════════════════════════════════════════════
  const gmStore = createGMStorage(GM_getValue, GM_setValue);
  const MODULE_DEFAULTS = { mcp: true, tts: true, ttsAutoPlay: false };
  function getModuleEnabled(mod) { return gmStore.get('mod_' + mod, MODULE_DEFAULTS[mod]); }
  function setModuleEnabled(mod, val) { gmStore.set('mod_' + mod, val); }
  function getAutoSendEnabled() { return gmStore.get(AUTO_SEND_KEY, DEFAULT_AUTO_SEND); }
  function getConfirmExecuteEnabled() { return gmStore.get(CONFIRM_EXEC_KEY, true); }
  function getCurrentConversationKey() {
    const match = location.pathname.match(/\/s\/([^/?#]+)/);
    return match ? decodeURIComponent(match[1]) : '';
  }
  function getSessionAutoPlayEnabled() {
    const key = getCurrentConversationKey();
    return !!(key && gmStore.get(TTS_SESSION_AUTOPLAY_PREFIX + key, false));
  }
  function setSessionAutoPlayEnabled(enabled) {
    const key = getCurrentConversationKey();
    if (!key) return false;
    gmStore.set(TTS_SESSION_AUTOPLAY_PREFIX + key, !!enabled);
    return true;
  }
  function shouldAutoPlayTTSForCurrentSession() {
    return getModuleEnabled('ttsAutoPlay') || getSessionAutoPlayEnabled();
  }

  const currentAdapter = createDeepSeekAdapter(document);
  console.log(`${SCRIPT_PREFIX} Adapter: ${currentAdapter.name}`);

  // ═══════════════════════════════════════════════════════════════
  //  File Context (tool results only — native upload handled by DS)
  // ═══════════════════════════════════════════════════════════════
  const _toolFiles = [];

  function addToolFileResult(filename, text, mimeType) {
    _toolFiles.push({ filename, _textContent: text, mime_type: mimeType || 'text/plain' });
  }

  function injectToolFileContext(bodyStr) {
    if (!_toolFiles.length || !bodyStr) return bodyStr;
    try {
      const parsed = JSON.parse(bodyStr);
      let ctx = '\n\n[上传文件内容]\n';
      for (const f of _toolFiles) {
        ctx += `\n--- ${f.filename} ---\n${f._textContent}\n`;
      }
      if (parsed.prompt && typeof parsed.prompt === 'string') {
        parsed.prompt += ctx;
      } else if (parsed.messages?.length) {
        const lastMsg = parsed.messages[parsed.messages.length - 1];
        if (typeof lastMsg.content === 'string') lastMsg.content += ctx;
        else if (Array.isArray(lastMsg.content)) {
          const tp = lastMsg.content.find(p => p.type === 'text');
          if (tp) tp.text += ctx;
        }
      }
      console.log(`${SCRIPT_PREFIX} Injected ${_toolFiles.length} tool file context(s)`);
      _toolFiles.length = 0;
      return JSON.stringify(parsed);
    } catch { return bodyStr; }
  }

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
  //  TTS Client — Text-to-Speech via server API
  // ═══════════════════════════════════════════════════════════════
  class TTSClient {
    constructor() {
      this.audio = null;
      this.playing = false;
      this.currentText = '';
    }

    getBaseUrl() {
      const mcpUrl = gmStore.get('mcp_url', DEFAULT_MCP_URL);
      try { return new URL(mcpUrl).origin; }
      catch { return mcpUrl.replace(/\/[^/]*$/, ''); }
    }

    async synthesize(text) {
      const voice = gmStore.get('tts_voice', 'zh-CN-XiaoxiaoNeural');
      const provider = gmStore.get('tts_provider', 'edge');
      const body = { text, voice, provider };
      if (provider === 'openai') {
        body.api_key = gmStore.get('tts_api_key', '');
        body.base_url = gmStore.get('tts_base_url', 'https://api.openai.com/v1');
        body.model = gmStore.get('tts_model', 'tts-1');
      }
      const url = this.getBaseUrl() + '/api/tts';
      return new Promise((resolve, reject) => {
        GM_xmlhttpRequest({
          method: 'POST', url,
          headers: { 'Content-Type': 'application/json', 'Accept': 'audio/mpeg' },
          data: JSON.stringify(body),
          responseType: 'blob',
          onload: (resp) => {
            if (resp.status !== 200) {
              try { const err = JSON.parse(resp.responseText); reject(new Error(err.error || 'TTS failed')); }
              catch { reject(new Error('TTS HTTP ' + resp.status)); }
              return;
            }
            resolve(URL.createObjectURL(resp.response));
          },
          onerror: () => reject(new Error('TTS 网络错误')),
          ontimeout: () => reject(new Error('TTS 超时')),
          timeout: 60000,
        });
      });
    }

    async play(text) {
      this.stop();
      this.currentText = text;
      try {
        const audioUrl = await this.synthesize(text);
        this.audio = new Audio(audioUrl);
        this.playing = true;
        this.audio.onended = () => { this.playing = false; };
        await this.audio.play();
      } catch (e) {
        console.warn(`${SCRIPT_PREFIX} TTS server failed, falling back to Web Speech:`, e.message);
        return this._fallbackPlay(text);
      }
    }

    _fallbackPlay(text) {
      if (!('speechSynthesis' in window)) {
        this.playing = false;
        throw new Error('TTS 不可用');
      }
      window.speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = 'zh-CN';
      u.rate = 1.0;
      this.playing = true;
      u.onend = () => { this.playing = false; };
      u.onerror = () => { this.playing = false; };
      window.speechSynthesis.speak(u);
    }

    stop() {
      if (this.audio) { this.audio.pause(); this.audio.currentTime = 0; this.audio = null; this.playing = false; }
      if (window.speechSynthesis) { window.speechSynthesis.cancel(); this.playing = false; }
    }
  }

  const ttsClient = new TTSClient();
  const toolHistory = [];
  let renderToolHistory = () => {};

  function toolResultFilename(toolName, args) {
    const raw = args?.path || args?.filename || `${toolName}-result.txt`;
    return String(raw).split('/').pop().split('\\').pop() || `${toolName}-result.txt`;
  }

  function shouldFileResult(toolName, isError, text) {
    if (isError) return false;
    return toolName === 'read_file' || toolName === 'list_directory' || String(text || '').length > LONG_TOOL_RESULT_LIMIT;
  }

  function recordToolHistory(entry) {
    const stored = { id: Date.now() + Math.random(), ...entry };
    toolHistory.unshift(stored);
    if (toolHistory.length > 30) toolHistory.length = 30;
    renderToolHistory();
    return stored;
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      toast('已复制', 'success');
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
      toast('已复制', 'success');
    }
  }

  // ═══════════════════════════════════════════════════════════════
  //  Tool Registry & Hint Builder
  // ═══════════════════════════════════════════════════════════════
  let toolRegistry = [];
  const toolPolicy = createToolPolicy({
    getValue: (key, fallback) => gmStore.get(key, fallback),
    whitelistKey: TOOL_WHITELIST_KEY,
    blacklistKey: TOOL_BLACKLIST_KEY,
    getTools: () => toolRegistry,
    systemHintStart: SYSTEM_HINT_START,
    systemHintEnd: SYSTEM_HINT_END,
  });
  const {
    buildToolHint,
    describeToolPolicyBlock,
    getAllowedTools,
    isToolAllowed,
  } = toolPolicy;

  function modifyRequest(bodyStr) {
    if (!toolRegistry.length || !bodyStr) return bodyStr;
    try {
      const parsed = JSON.parse(bodyStr);
      const hint = buildToolHint();
      if (!hint) return bodyStr;
      if (bodyStr.includes(`${SYSTEM_HINT_START} 你拥有以下 MCP 工具`)) return bodyStr;

      if (parsed.prompt && typeof parsed.prompt === 'string') {
        parsed.prompt = hint + '\n\n' + parsed.prompt;
        return injectToolFileContext(JSON.stringify(parsed));
      }
      if (parsed.messages?.length) {
        const lastMsg = parsed.messages[parsed.messages.length - 1];
        const content = lastMsg?.content;
        if (typeof content === 'string') {
          lastMsg.content = hint + '\n\n' + content;
          return injectToolFileContext(JSON.stringify(parsed));
        }
        if (Array.isArray(content)) {
          const textPart = content.find(p => p.type === 'text');
          if (textPart && !textPart.text.includes('[系统指令]')) {
            textPart.text = hint + '\n\n' + textPart.text;
            return injectToolFileContext(JSON.stringify(parsed));
          }
        }
      }
    } catch { /* not JSON */ }
    return bodyStr;
  }

  // ═══════════════════════════════════════════════════════════════
  //  SSE Parsing — DeepSeek native format
  // ═══════════════════════════════════════════════════════════════
  const executedCalls = new Set();
  let _streamDebounce = null;

  function checkForToolCalls(content) {
    if (!content || !toolRegistry.length) return;

    // Strategy 1: Match ```mcp:tool_name\n{...}\n```
    const re = new RegExp(TOOL_CALL_RE.source, 'g');
    let match;
    while ((match = re.exec(content)) !== null) {
      const toolName = match[1];
      const rawArgs = match[2].trim();
      let args = {};
      try { args = JSON.parse(rawArgs); }
      catch { args = { input: rawArgs }; }

      if (!isToolAllowed(toolName)) {
        toast(`已拦截工具: ${describeToolPolicyBlock(toolName)}`, 'error');
        continue;
      }
      const key = toolName + ':' + JSON.stringify(args);
      if (executedCalls.has(key)) continue;
      executedCalls.add(key);

      console.log(`${SCRIPT_PREFIX} Tool call: ${toolName}`, args);
      executeToolCall(toolName, args);
    }

    // Strategy 2: Match registered tool names directly
    // Handles SSE token boundary truncation
    for (const tool of getAllowedTools()) {
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
      executedCalls.add(key);

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
    if (isCompletion && getModuleEnabled('mcp')) {
      if (body) body = modifyRequest(body);

      let requestContent = '';
      let requestLastParsed = 0;

      this.addEventListener('progress', function () {
        try {
          const rt = this.responseText || '';
          if (rt.length <= requestLastParsed) return;
          const newPart = rt.substring(requestLastParsed);
          // Only parse up to the last complete line to avoid dropping
          // incomplete `data:` lines split across progress events
          const lastNewline = newPart.lastIndexOf('\n');
          if (lastNewline < 0) return; // no complete line yet
          requestLastParsed += lastNewline + 1;
          const completePart = newPart.substring(0, lastNewline + 1);
          const newContent = parseSSEChunk(completePart);
          if (newContent) requestContent += newContent;

          if (_streamDebounce) clearTimeout(_streamDebounce);
          _streamDebounce = setTimeout(() => {
            if (requestContent) checkForToolCalls(requestContent);
          }, 1000);
        } catch { /* ignore */ }
      });

      this.addEventListener('load', function () {
        try {
          const rt = this.responseText || '';
          if (rt.length > requestLastParsed) {
            const newPart = rt.substring(requestLastParsed);
            const finalContent = parseSSEChunk(newPart);
            if (finalContent) requestContent += finalContent;
          }
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

    if (url && url.includes('completion') && getModuleEnabled('mcp')) {
      if (args[1]?.body) {
        args[1].body = modifyRequest(args[1].body);
      }

      const response = await origFetch.apply(this, args);
      const contentType = response.headers?.get('content-type') || '';

      const clone = response.clone();
      clone.text().then(text => {
        const content = parseSSEChunk(text);
        if (content) checkForToolCalls(content);
      }).catch(() => { });

      return response;
    }

    return origFetch.apply(this, args);
  };

  // ═══════════════════════════════════════════════════════════════
  //  Tool Execution & Result Injection
  // ═══════════════════════════════════════════════════════════════
  function getDangerousCommandWarning(command) {
    const text = String(command || '').trim();
    if (!text) return '';
    const patterns = [
      /\brm\s+(-[^\s]*r[^\s]*f|-[^\s]*f[^\s]*r)\s+(\/|~|\$HOME|\*)/i,
      /\bsudo\b/i,
      /\bdd\b[\s\S]*\bof=/i,
      /\bmkfs(\.|\\s|$)/i,
      /\b(shutdown|reboot|halt|poweroff)\b/i,
      /\b(chmod|chown)\s+(-R\s+)?777\b/i,
      />\s*\/(etc|usr|bin|sbin|boot)\//i,
    ];
    return patterns.some(re => re.test(text))
      ? '⚠️ 检测到高风险命令片段。请确认命令来源可信，并确认它不会删除、覆盖或修改关键文件。'
      : '';
  }

  async function executeToolCall(toolName, args) {
    const startedAt = Date.now();
    if (!isToolAllowed(toolName)) {
      const reason = describeToolPolicyBlock(toolName);
      toast(`已拦截工具: ${reason}`, 'error');
      injectResultToChat(`Error: 工具调用被安全策略拦截：${reason}`);
      const blocked = { toolName, args, resultText: `Error: ${reason}`, isError: true, durationMs: 0, executedAt: new Date(), filed: false };
      return recordToolHistory(blocked);
    }
    if (toolName === 'execute_command' && getConfirmExecuteEnabled()) {
      const command = args?.command || args?.cmd || args?.input || '';
      const dangerWarning = getDangerousCommandWarning(command);
      const warningText = dangerWarning ? `\n\n${dangerWarning}` : '';
      if (!confirm(`确认执行本地命令？${warningText}\n\n${command || '(未提供 command 参数)'}`)) {
        toast('已取消 execute_command', 'info');
        injectResultToChat('Error: 用户取消了 execute_command 调用。');
        const cancelled = { toolName, args, resultText: 'Error: 用户取消了 execute_command 调用。', isError: true, durationMs: 0, executedAt: new Date(), filed: false };
        return recordToolHistory(cancelled);
      }
    }
    const mcpUrl = gmStore.get('mcp_url', DEFAULT_MCP_URL);
    const client = new MCPClient(mcpUrl);

    try {
      toast(`调用工具: ${toolName}...`, 'info');
      const result = await client.callTool(toolName, args);
      const resultText = result?.content?.[0]?.text || '(no result)';
      const isError = result?.isError;
      const durationMs = Date.now() - startedAt;
      const filed = shouldFileResult(toolName, isError, resultText);

      toast(isError ? `${toolName} 失败` : `${toolName} 完成`, isError ? 'error' : 'success');

      if (filed) {
        const filename = toolResultFilename(toolName, args);
        addToolFileResult(filename, resultText, 'text/plain');
        toast(`📁 ${filename} 已添加到文件列表`, 'success');
        injectResultToChat(`[工具 ${toolName} 的结果已作为文件添加，共 ${resultText.length} 字符。发送下条消息时会自动附带文件内容。]`);
      } else {
        injectResultToChat(isError ? `Error: ${resultText}` : resultText);
      }
      const entry = { toolName, args, resultText, isError, durationMs, executedAt: new Date(), filed };
      return recordToolHistory(entry);
    } catch (e) {
      const durationMs = Date.now() - startedAt;
      toast(`工具调用失败: ${e.message}`, 'error');
      console.error(`${SCRIPT_PREFIX} Tool error:`, e);
      injectResultToChat(`Error: ${e.message}`);
      const entry = { toolName, args, resultText: `Error: ${e.message}`, isError: true, durationMs, executedAt: new Date(), filed: false };
      return recordToolHistory(entry);
    }
  }

  function injectResultToChat(resultText) {
    setTimeout(async () => {
      const wrappedText = `<tool_result>\n${resultText}\n</tool_result>`;

      const input = findInputElement();
      if (!input) {
        toast('找不到聊天输入框', 'error');
        return;
      }

      input.focus();
      await sleep(200);
      setInputValue(input, wrappedText);
      await sleep(500);

      if (!getAutoSendEnabled()) {
        toast('工具结果已填入输入框', 'info');
        return;
      }

      simulateEnter(input);
      await sleep(300);
      const sendBtn = findSendButton();
      if (sendBtn) sendBtn.click();

      toast('工具结果已发送', 'success');
    }, 1500);
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
  const showToast = createToast(document, { colors: { info: '#2a2a3e', success: '#0d3320', error: '#3d0f0f' } });
  function toast(msg, type = 'info') {
    if (!document.body) return;
    return showToast(msg, type);
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

    #mcp-panel{position:fixed;z-index:999998;width:460px;max-height:min(75vh, calc(100vh - 20px));background:#16161e;color:#eee;border:1px solid #333;border-radius:14px;box-shadow:0 8px 40px rgba(0,0,0,.6);font-family:system-ui;font-size:14px;display:none;flex-direction:column;overflow:hidden}
    #mcp-panel.open{display:flex}
    #mcp-panel .hd{padding:14px 18px;border-bottom:1px solid #2a2a3a;display:flex;align-items:center;justify-content:space-between;flex-shrink:0}
    #mcp-panel .hd h3{margin:0;font-size:15px;font-weight:600}
    #mcp-panel .hd .ver{font-size:11px;color:#666;margin-left:8px}
    #mcp-panel .hd .cls{background:none;border:none;color:#888;font-size:20px;cursor:pointer;padding:0 4px}
    #mcp-panel .hd .cls:hover{color:#fff}

    #mcp-tabs{display:flex;border-bottom:1px solid #2a2a3a;overflow-x:auto;scrollbar-width:none;flex-shrink:0}
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
    .mcp-history-card{margin-top:8px;padding:8px;border:1px solid #333;border-radius:8px;background:#1a1a28;font-size:12px}
    .mcp-history-hd{display:flex;align-items:center;justify-content:space-between;gap:8px;cursor:pointer;color:#ddd}
    .mcp-history-meta{color:#777;font-size:11px;margin-top:3px}
    .mcp-history-actions{display:flex;gap:4px;margin-top:8px}
    .mcp-history-body{display:none;margin-top:8px;white-space:pre-wrap;word-break:break-all;color:#aaa;max-height:220px;overflow:auto;font-family:monospace}
    .mcp-history-card.open .mcp-history-body{display:block}
    .mcp-label{font-size:12px;color:#888;margin-bottom:4px;display:block}
    .mcp-label-row{display:flex;align-items:center;gap:8px;margin-bottom:6px}
    .mcp-status{font-size:13px;padding:8px 0}
    .mcp-status .ok{color:#4ade80}
    .mcp-status .err{color:#f87171}

    .ext-card{padding:10px 12px;border:1px solid #333;border-radius:10px;margin-bottom:8px;background:#1a1a28}
    .ext-card-hd{display:flex;align-items:center;justify-content:space-between;gap:8px}
    .ext-card-name{font-weight:600;color:#7aa2f7;font-size:14px}
    .ext-card-transport{font-size:11px;color:#666;background:#222;padding:2px 6px;border-radius:4px}
    .ext-card-status{font-size:12px;display:flex;align-items:center;gap:4px}
    .ext-card-status .dot{width:7px;height:7px;border-radius:50%;display:inline-block}
    .ext-card-status .dot-green{background:#4ade80}.ext-card-status .dot-red{background:#f87171}.ext-card-status .dot-gray{background:#666}
    .ext-card-tools{font-size:11px;color:#888;margin-top:6px}
    .ext-card-actions{display:flex;gap:6px;margin-top:8px}
    .ext-card-actions .mcp-btn{font-size:11px;padding:4px 10px}
    .ext-empty{padding:10px;border:1px dashed #333;border-radius:8px;color:#777;font-size:12px;background:#171722}
    .ext-summary{display:grid;grid-template-columns:repeat(3,1fr);gap:6px;margin-bottom:10px}
    .ext-summary-item{padding:8px;border:1px solid #303044;border-radius:8px;background:#1a1a28}
    .ext-summary-num{font-size:16px;font-weight:600;color:#ddd}
    .ext-summary-label{font-size:10px;color:#777;margin-top:2px}
    .ext-alert{padding:8px 10px;border-radius:8px;background:#3a1c1c;border:1px solid #713333;color:#fecaca;font-size:12px;margin-bottom:10px;white-space:pre-wrap;word-break:break-word}
    .ext-card-error{margin-top:6px;padding:6px 8px;border-radius:6px;background:#321717;color:#fecaca;font-size:11px;white-space:pre-wrap;word-break:break-word}
    .ext-tool-badge{display:inline-block;margin:2px 4px 0 0;padding:2px 6px;border-radius:999px;border:1px solid #333;color:#aaa;background:#202032;font-size:10px}
    .ext-form-row{margin-bottom:8px}
    .ext-form-row label{font-size:11px;color:#888;display:block;margin-bottom:3px}
    .ext-form-row input{font-size:12px}
    .ext-add-toggle{font-size:12px;color:#7aa2f7;cursor:pointer;border:none;background:none;padding:0;margin-top:6px}
    .ext-add-toggle:hover{text-decoration:underline}
    .ext-section{margin-top:10px;padding-top:10px;border-top:1px solid #2a2a3a}

    /* TTS Button */
    .mcp-tts-btn {
      display:inline-flex;align-items:center;gap:4px;
      padding:4px 8px;border-radius:6px;border:1px solid transparent;
      background:transparent;color:#999;font-size:12px;cursor:pointer;
      transition:background .15s,color .15s,border-color .15s;user-select:none;
      white-space:nowrap;line-height:1;height:28px;box-sizing:border-box;
    }
    .mcp-tts-btn:hover { background:#2a2a3e;color:#e0e0e0;border-color:#555; }
    .mcp-tts-btn.playing { color:#4ade80;background:#1a3a28;border-color:#16a34a; }
    .mcp-tts-btn.paused { color:#fbbf24;background:#3a2a18;border-color:#d97706; }
    #mcp-inline-btn{display:inline-flex;align-items:center;gap:4px;padding:5px 10px;border:1px solid rgba(22,163,74,.4);border-radius:999px;background:rgba(22,163,74,.12);color:#b7f7c8;font-size:12px;line-height:1.2;cursor:pointer;font-family:system-ui;white-space:nowrap}
    #mcp-inline-btn:hover{background:rgba(22,163,74,.2);border-color:rgba(22,163,74,.65)}

    /* Module toggles */
    .mcp-toggle-row { display:flex;align-items:center;justify-content:space-between;padding:8px 0;border-bottom:1px solid #2a2a3a; }
    .mcp-toggle-label { font-size:13px;color:#ccc; }
    .mcp-toggle-desc { font-size:11px;color:#666;margin-top:2px; }
    .mcp-switch { position:relative;width:36px;height:20px;flex-shrink:0; }
    .mcp-switch input { opacity:0;width:0;height:0; }
    .mcp-switch .slider { position:absolute;cursor:pointer;top:0;left:0;right:0;bottom:0;background:#333;border-radius:10px;transition:.2s; }
    .mcp-switch .slider:before { position:absolute;content:"";height:16px;width:16px;left:2px;bottom:2px;background:#888;border-radius:50%;transition:.2s; }
    .mcp-switch input:checked + .slider { background:#16a34a; }
    .mcp-switch input:checked + .slider:before { transform:translateX(16px);background:#fff; }

    .mcp-code-action {
      display:inline-flex;align-items:center;justify-content:center;
      height:24px;padding:0 8px;margin-left:4px;border-radius:5px;
      border:1px solid #444;background:#222;color:#ddd;font-size:12px;
      line-height:1;cursor:pointer;white-space:nowrap;box-sizing:border-box;
    }
    .mcp-code-action:hover { background:#333;color:#fff;border-color:#666; }
    .mcp-code-action.resend { background:#14351f;border-color:#16a34a;color:#8df0ad; }
    .mcp-code-action.resend:hover { background:#166534;color:#fff; }
    pre.mcp-code-hidden, code.mcp-code-hidden, .mcp-code-hidden pre, .mcp-code-hidden code { display:none !important; }
    .mcp-sys-fold {
      margin:8px 0;padding:8px 10px;border:1px solid #333;border-radius:8px;
      background:#15151f;color:#ccc;font-size:13px;line-height:1.55;
    }
    .mcp-sys-fold-hd { display:flex;align-items:center;justify-content:space-between;gap:8px;cursor:pointer;user-select:none; }
    .mcp-sys-fold-title { color:#7aa2f7;font-weight:600; }
    .mcp-sys-fold-toggle { color:#999;font-size:12px; }
    .mcp-sys-fold-body { display:none;margin-top:8px;white-space:pre-wrap;color:#999;font-size:12px; }
    .mcp-sys-fold.open .mcp-sys-fold-body { display:block; }

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
    injectStyle(document, PANEL_CSS);

    // FAB
    const fab = document.createElement('button');
    fab.id = 'mcp-fab';
    fab.innerHTML = '&#9881;';
    fab.title = 'DS MCP Bridge (可拖动)';
    document.body.appendChild(fab);

    // Panel
    const panel = document.createElement('div');
    panel.id = 'mcp-panel';
    panel.innerHTML = `
      <div class="hd">
        <h3>DS MCP Bridge <span class="ver">v4.2.0</span></h3>
        <button class="cls">&times;</button>
      </div>
      <div id="mcp-tabs">
        <button class="active" data-tab="status">状态</button>
        <button data-tab="test">测试</button>
        <button data-tab="ext">MCP 服务器</button>
        <button data-tab="settings">设置</button>
      </div>
      <div class="mcp-bd">
        <div class="mcp-sec active" id="mcp-sec-status"></div>
        <div class="mcp-sec" id="mcp-sec-test"></div>
        <div class="mcp-sec" id="mcp-sec-ext"></div>
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
      positionFloatingPanel({
        windowRef: window,
        fab,
        panel,
        width: 460,
        align: 'right',
        gap: 10,
        margin: 10,
        topMargin: 50,
        maxHeightRatio: 0.75,
        minSpaceAbove: 200,
      });
    }

    function openMCPPanel() {
      panel.classList.add('open');
      posPanel();
      refreshStatus();
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
        if (!fabDragged) { panel.classList.toggle('open'); if (panel.classList.contains('open')) { posPanel(); refreshStatus(); } }
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

    const InlineMCPUI = {
      btnId: 'mcp-inline-btn',
      mount() {
        const container = currentAdapter.findComposerToolbar();
        if (!container) return;
        let btn = document.getElementById(this.btnId);
        if (!btn) {
          btn = document.createElement('button');
          btn.id = this.btnId;
          btn.type = 'button';
          btn.textContent = 'MCP';
          btn.title = '打开 DS MCP Bridge';
          btn.onclick = (e) => {
            e.preventDefault();
            e.stopPropagation();
            openMCPPanel();
          };
        }
        if (container.contains(btn)) return;
        const nativeToggles = Array.from(container.children).filter(c => c.classList?.contains('ds-toggle-button'));
        const lastNative = nativeToggles[nativeToggles.length - 1];
        if (lastNative) container.insertBefore(btn, lastNative.nextSibling);
        else container.appendChild(btn);
      }
    };

    const nativeMountManager = createMountManager(250);
    nativeMountManager.register('composer-mcp-entry', () => InlineMCPUI.mount());
    nativeMountManager.observe(document.body);
    setTimeout(() => nativeMountManager.schedule(), 1000);

    // ═══════════════════════════════════════════════════════════════
    //  Tab: Status
    // ═══════════════════════════════════════════════════════════════
    const secStatus = panel.querySelector('#mcp-sec-status');

    async function refreshStatus() {
      const mcpUrl = gmStore.get('mcp_url', DEFAULT_MCP_URL);
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

      // Fetch health info for external server status
      let healthInfo = null;
      try {
        const resp = await new Promise((resolve, reject) => {
          GM_xmlhttpRequest({
            method: 'GET', url: mcpUrl.replace('/mcp', '/health'),
            onload: (r) => resolve(JSON.parse(r.responseText)),
            onerror: (e) => reject(e), timeout: 5000,
          });
        });
        healthInfo = resp;
      } catch { }

      const tools = await client.listTools();
      toolRegistry = tools;
      fab.classList.remove('disconnected');

      // Separate builtin vs external tools
      const extServers = healthInfo?.external_servers || [];
      const extToolNames = new Set();
      extServers.forEach(s => s.tools?.forEach(t => extToolNames.add(t)));

      let toolList = '';
      tools.forEach(t => {
        const desc = t.description || '';
        const req = t.inputSchema?.required;
        const params = req?.length ? ` (${req.join(', ')})` : '';
        const badge = extToolNames.has(t.name)
          ? '<span style="font-size:10px;color:#f0ad4e;margin-left:4px">ext</span>' : '';
        toolList += `<div class="mcp-tool"><span class="name">${esc(t.name)}${esc(params)}${badge}</span><span class="desc">${esc(desc)}</span></div>`;
      });

      // External servers info
      let extInfo = '';
      if (extServers.length > 0) {
        extInfo = '<div style="margin-top:12px;padding-top:10px;border-top:1px solid #2a2a3a">';
        extInfo += '<div style="font-size:12px;color:#888;margin-bottom:6px">外部 MCP 服务器</div>';
        extServers.forEach(s => {
          const icon = s.connected ? '&#10003;' : '&#10007;';
          const color = s.connected ? '#4ade80' : '#f87171';
          extInfo += `<div style="font-size:12px;color:#aaa;margin-bottom:4px"><span style="color:${color}">${icon}</span> <strong>${esc(s.name)}</strong> (${s.transport}) — ${s.tools?.length || 0} tools</div>`;
        });
        extInfo += '</div>';
      }

      const builtinCount = tools.length - extToolNames.size;
      const summary = extServers.length > 0
        ? `${tools.length} 个工具 (${builtinCount} 内置 + ${extToolNames.size} 外部)`
        : `${tools.length} 个工具`;

      secStatus.innerHTML = `
        <div class="mcp-status"><span class="ok">已连接</span> — ${summary}</div>
        ${extInfo}
        <div style="margin-top:8px">${toolList || '<div style="color:#665">无可用工具</div>'}</div>
        <div style="margin-top:12px">
          <button class="mcp-btn pri" id="mcp-refresh">刷新</button>
        </div>
      `;
      secStatus.querySelector('#mcp-refresh').onclick = refreshStatus;
      console.log(`${SCRIPT_PREFIX} ready — ${tools.length} tools (${extToolNames.size} external)`);
    }

    // ═══════════════════════════════════════════════════════════════
    //  Health Check — 自动轮询 + 断线提示 + 自动重连
    // ═══════════════════════════════════════════════════════════════
    let _healthConnected = null; // null = unknown, true/false = last known state

    async function checkConnection() {
      const mcpUrl = gmStore.get('mcp_url', DEFAULT_MCP_URL);
      try {
        const resp = await new Promise((resolve, reject) => {
          GM_xmlhttpRequest({
            method: 'GET',
            url: mcpUrl.replace('/mcp', '/health'),
            onload: (r) => {
              try { resolve(JSON.parse(r.responseText)); }
              catch { reject(new Error('invalid response')); }
            },
            onerror: () => reject(new Error('network error')),
            timeout: 5000,
          });
        });

        const nowOk = resp.status === 'ok';
        if (_healthConnected === false && nowOk) {
          // 刚恢复连接 — 自动重新加载工具列表
          toast('服务器已恢复连接，正在重新加载...', 'success');
          refreshStatus();
        } else if (_healthConnected === null && nowOk) {
          // 首次检测到已连接
        }
        _healthConnected = nowOk;
        fab.classList.toggle('disconnected', !nowOk);
      } catch {
        if (_healthConnected !== false) {
          _healthConnected = false;
          fab.classList.add('disconnected');
          toolRegistry = [];
          toast('服务器连接断开，请检查 MCP 服务器是否运行中', 'error');
        }
      }
    }

    // 首次检测 + 每 30 秒轮询
    checkConnection();
    setInterval(checkConnection, 30000);

    // ═══════════════════════════════════════════════════════════════
    //  Tab: Test
    // ═══════════════════════════════════════════════════════════════
    const secTest = panel.querySelector('#mcp-sec-test');

    function renderToolResultCard(entry) {
      const time = entry.executedAt instanceof Date ? entry.executedAt.toLocaleTimeString() : '';
      const status = entry.isError ? '失败' : (entry.filed ? '已文件化' : '完成');
      return `
        <div class="mcp-history-card" data-id="${entry.id || ''}">
          <div class="mcp-history-hd"><span>${esc(entry.toolName)} · ${status}</span><span>${entry.durationMs || 0}ms</span></div>
          <div class="mcp-history-meta">${esc(time)} · 参数 ${esc(JSON.stringify(entry.args || {}))}</div>
          <div class="mcp-history-actions">
            <button class="mcp-btn copy-result" style="font-size:11px;padding:4px 8px">复制结果</button>
            <button class="mcp-btn copy-args" style="font-size:11px;padding:4px 8px">复制参数</button>
            <button class="mcp-btn resend-result" style="font-size:11px;padding:4px 8px">重发</button>
          </div>
          <div class="mcp-history-body${entry.isError ? ' error' : ''}">${esc(entry.resultText || '')}</div>
        </div>
      `;
    }

    function bindToolResultCards(root) {
      root.querySelectorAll('.mcp-history-card').forEach(card => {
        const entry = toolHistory.find(h => String(h.id) === card.dataset.id) || toolHistory[0];
        card.querySelector('.mcp-history-hd').onclick = () => card.classList.toggle('open');
        card.querySelector('.copy-result').onclick = (e) => { e.stopPropagation(); copyText(entry?.resultText || ''); };
        card.querySelector('.copy-args').onclick = (e) => { e.stopPropagation(); copyText(JSON.stringify(entry?.args || {}, null, 2)); };
        card.querySelector('.resend-result').onclick = (e) => { e.stopPropagation(); if (entry) executeToolCall(entry.toolName, entry.args); };
      });
    }

    renderToolHistory = () => {
      const host = secTest.querySelector('#mcp-history-list');
      if (!host) return;
      host.innerHTML = toolHistory.length
        ? toolHistory.map(renderToolResultCard).join('')
        : '<div style="color:#666;font-size:12px">暂无工具调用记录</div>';
      bindToolResultCards(host);
    };

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
        <div style="margin-top:14px;border-top:1px solid #2a2a3a;padding-top:10px">
          <div style="font-size:12px;color:#888;margin-bottom:6px">工具结果历史</div>
          <div id="mcp-history-list"></div>
        </div>
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
        try {
          const entry = await executeToolCall(toolName, args);
          resultDiv.innerHTML = entry ? renderToolResultCard(entry) : '';
          bindToolResultCards(resultDiv);
        } catch (e) {
          resultDiv.innerHTML = `<div class="mcp-result error">Error: ${esc(e.message)}</div>`;
        }
      };
      renderToolHistory();
    }

    // Watch for tab switch to render test tab
    panel.querySelectorAll('#mcp-tabs button').forEach(btn => {
      btn.addEventListener('click', () => {
        if (btn.dataset.tab === 'test') renderTestTab();
        if (btn.dataset.tab === 'ext') renderExtTab();
      });
    });

    // ═══════════════════════════════════════════════════════════════
    //  Tab: External MCP Servers
    // ═══════════════════════════════════════════════════════════════
    const secExt = panel.querySelector('#mcp-sec-ext');

    function getExtBaseUrl() {
      const mcpUrl = gmStore.get('mcp_url', DEFAULT_MCP_URL);
      try { return new URL(mcpUrl).origin; }
      catch { return mcpUrl.replace(/\/[^/]*$/, ''); }
    }

    function getBaseUrl() {
      const mcpUrl = gmStore.get('mcp_url', DEFAULT_MCP_URL);
      // Extract origin from any MCP URL: http://host:port/mcp → http://host:port
      try {
        const u = new URL(mcpUrl);
        return u.origin;
      } catch {
        // Fallback: strip last path segment
        return mcpUrl.replace(/\/[^/]*$/, '');
      }
    }

    function extApiUrl(path) {
      return getBaseUrl() + path;
    }

    async function extApiCall(path, method = 'GET', body) {
      const url = extApiUrl(path);
      return new Promise((resolve, reject) => {
        const opts = {
          method, url, timeout: 15000,
          headers: { 'Content-Type': 'application/json' },
          onload: (r) => {
            try { resolve(JSON.parse(r.responseText)); }
            catch { reject(new Error('Invalid JSON')); }
          },
          onerror: (e) => reject(new Error(e.error || 'Network error')),
          ontimeout: () => reject(new Error('Timeout')),
        };
        if (body) opts.data = JSON.stringify(body);
        GM_xmlhttpRequest(opts);
      });
    }

    let extFormOpen = false;

    let presetParamForm = null; // {presetId, preset} when param form is open
    let lastExtAction = null;

    function setExtAction(type, message) {
      lastExtAction = message ? { type, message, time: new Date().toLocaleTimeString() } : null;
    }

    function serverErrorSummary(server) {
      const err = server?.error || server?.last_error || server?.stderr || server?.message || '';
      return String(err || '').trim().slice(0, 500);
    }

    function renderServerToolBadges(server) {
      const tools = Array.isArray(server?.tools) ? server.tools : [];
      if (!tools.length) return '<span style="color:#666">无外部工具</span>';
      return tools.map(tool => `<span class="ext-tool-badge">外部 · ${esc(tool)}</span>`).join('');
    }

    async function runExtServerAction(name, action, label) {
      try {
        const result = await extApiCall(`/api/external-servers/${name}/${action}`, 'POST');
        if (result.ok) {
          setExtAction('success', `${name} ${label}`);
          toast(`${name} ${label}`, 'success');
        } else {
          const msg = result.error || `${label}失败`;
          setExtAction('error', `${name}: ${msg}`);
          toast(msg, 'error');
        }
      } catch (e) {
        setExtAction('error', `${name}: ${e.message}`);
        toast(e.message, 'error');
      }
      renderExtTab();
      refreshStatus();
    }

    async function renderExtTab() {
      secExt.innerHTML = '<div style="color:#888;font-size:13px">加载中...</div>';

      // Fetch presets and servers in parallel
      let presets = [], servers = [];
      try {
        const [presetData, serverData] = await Promise.all([
          extApiCall('/api/presets'),
          extApiCall('/api/external-servers'),
        ]);
        presets = presetData.presets || [];
        servers = serverData.servers || [];
      } catch (e) {
        secExt.innerHTML = `<div style="color:#f87171;font-size:13px">连接失败: ${esc(e.message)}</div>`;
        return;
      }

      const installedIds = new Set(servers.map(s => s.name));
      let html = '';
      const runningCount = servers.filter(s => s.status === 'running').length;
      const failedServers = servers.filter(s => s.status && s.status !== 'running' && s.status !== 'stopped');
      const extToolCount = servers.reduce((sum, s) => sum + (Array.isArray(s.tools) ? s.tools.length : 0), 0);

      html += `
        <div class="ext-summary">
          <div class="ext-summary-item"><div class="ext-summary-num">${servers.length}</div><div class="ext-summary-label">外部服务器</div></div>
          <div class="ext-summary-item"><div class="ext-summary-num">${runningCount}</div><div class="ext-summary-label">运行中</div></div>
          <div class="ext-summary-item"><div class="ext-summary-num">${extToolCount}</div><div class="ext-summary-label">外部工具</div></div>
        </div>
      `;
      if (lastExtAction) {
        html += `<div class="ext-alert" style="${lastExtAction.type === 'success' ? 'background:#10281a;border-color:#245c39;color:#bbf7d0' : ''}">${esc(lastExtAction.time)} · ${esc(lastExtAction.message)}</div>`;
      }
      if (failedServers.length) {
        const failures = failedServers.map(s => `${s.name}: ${serverErrorSummary(s) || s.status || '启动失败'}`).join('\n');
        html += `<div class="ext-alert">启动失败摘要\n${esc(failures)}</div>`;
      }

      // ═══ Preset Marketplace ═══
      html += '<div style="font-size:12px;font-weight:600;color:#ccc;margin-bottom:8px">工具预设</div>';

      // Group by category
      const categories = {};
      presets.forEach(p => {
        const cat = p.category || '其他';
        if (!categories[cat]) categories[cat] = [];
        categories[cat].push(p);
      });

      for (const [cat, items] of Object.entries(categories)) {
        html += `<div style="font-size:10px;color:#666;margin:6px 0 3px">${esc(cat)}</div>`;
        html += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:5px;margin-bottom:6px">';
        items.forEach(p => {
          const installed = installedIds.has(p.id);
          const hasParams = p.params?.length > 0;
          const btnText = installed ? (hasParams ? '重新配置' : '已启用') : (hasParams ? '配置' : '启用');
          const btnClass = 'ext-preset-install';
          const btnStyle = installed
            ? (hasParams
              ? 'background:#222;color:#7aa2f7;border-color:#7aa2f7'
              : 'background:#1a3a2a;color:#4ade80;border-color:#4ade80;pointer-events:none')
            : 'background:#222;color:#7aa2f7;border-color:#7aa2f7';
          html += `
            <div class="ext-preset-card ext-preset-install" data-preset-id="${esc(p.id)}" style="padding:6px 8px;border:1px solid ${installed ? '#2a4a3a' : '#333'};border-radius:6px;background:${installed ? '#1a2a22' : '#1a1a28'}">
              <div style="display:flex;justify-content:space-between;align-items:center">
                <span style="font-size:12px;font-weight:500;color:#ccc">${esc(p.name)}</span>
                <button class="${btnClass} mcp-btn" data-preset-id="${esc(p.id)}" style="${btnStyle};font-size:10px;padding:1px 7px">${btnText}</button>
              </div>
              <div style="font-size:10px;color:#888;margin-top:2px">${esc(p.description)}</div>
              <div style="font-size:10px;color:#666;margin-top:4px">来源: 外部 MCP 服务器</div>
            </div>
          `;
        });
        html += '</div>';
      }

      // ═══ Param form (shown when configuring a preset) ═══
      if (presetParamForm) {
        const p = presetParamForm;
        html += `
          <div class="ext-section" id="ext-param-form">
            <div style="font-size:13px;font-weight:600;color:#ccc;margin-bottom:8px">配置: ${esc(p.name)}</div>
        `;
        p.params.forEach(param => {
          const req = param.required ? ' *' : '';
          const inputType = param.secret ? 'password' : 'text';
          html += `
            <div style="margin-bottom:6px">
              <label style="font-size:11px;color:#888;display:block;margin-bottom:2px">${esc(param.label)}${req}</label>
              <input class="mcp-input ext-param-input" data-key="${esc(param.key)}" type="${inputType}"
                     placeholder="${esc(param.placeholder || '')}" style="font-size:12px" />
            </div>
          `;
        });
        html += `
            <div style="margin-top:8px;display:flex;gap:6px">
              <button class="mcp-btn pri" id="ext-param-submit">安装</button>
              <button class="mcp-btn" id="ext-param-cancel">取消</button>
            </div>
          </div>
        `;
      }

      // ═══ Installed Servers ═══
      if (servers.length > 0) {
        html += '<div class="ext-section">';
        html += '<div style="font-size:12px;font-weight:600;color:#ccc;margin-bottom:6px">已安装</div>';
        servers.forEach(s => {
          const dotClass = s.status === 'running' ? 'dot-green' : s.status === 'stopped' ? 'dot-gray' : 'dot-red';
          const statusText = s.status === 'running' ? '运行中' : s.status === 'stopped' ? '已停止' : '异常';
          const statusColor = s.status === 'running' ? '#4ade80' : s.status === 'stopped' ? '#888' : '#f87171';
          const errText = serverErrorSummary(s);

          let actions = '';
          if (s.status === 'running') {
            actions = `<button class="mcp-btn ext-stop" data-name="${esc(s.name)}" style="font-size:11px;padding:3px 8px">停止</button>`;
          } else {
            actions = `<button class="mcp-btn pri ext-start" data-name="${esc(s.name)}" style="font-size:11px;padding:3px 8px">启动</button>`;
          }
          actions += `<button class="mcp-btn ext-remove" data-name="${esc(s.name)}" style="color:#f87171;border-color:#f87171;font-size:11px;padding:3px 8px">删除</button>`;

          html += `
            <div class="ext-card" style="padding:8px 10px;margin-bottom:6px">
              <div class="ext-card-hd">
                <div style="display:flex;align-items:center;gap:8px">
                  <span class="ext-card-name" style="font-size:13px">${esc(s.name)}</span>
                  <span class="ext-card-transport">${s.transport}</span>
                </div>
                <span class="ext-card-status"><span class="dot ${dotClass}"></span><span style="color:${statusColor}">${statusText}</span></span>
              </div>
              <div class="ext-card-tools" style="font-size:10px">工具: ${renderServerToolBadges(s)}</div>
              ${errText ? `<div class="ext-card-error">${esc(errText)}</div>` : ''}
              <div class="ext-card-actions" style="margin-top:6px">${actions}</div>
            </div>
          `;
        });
        html += '</div>';
      } else {
        html += '<div class="ext-empty">还没有安装外部 MCP 服务器。可以从预设启用，或导入 mcpServers JSON 配置。</div>';
      }

      // Add form — JSON import
      const defaultJson = JSON.stringify({
        "mcpServers": {
          "context7": { "command": "npx", "args": ["-y", "@upstash/context7-mcp"] },
          "fetch": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-fetch"] }
        }
      }, null, 2);

      html += `<div style="margin-top:10px"><button class="ext-add-toggle" id="ext-add-btn">+ 导入 JSON 配置</button></div>`;
      html += `<div id="ext-add-form" style="display:${extFormOpen ? 'block' : 'none'};margin-top:6px">`;
      html += `
        <div style="font-size:10px;color:#888;margin-bottom:4px">
          支持粘贴任意格式的 MCP 配置 JSON，可同时导入多个
        </div>
        <textarea id="ext-f-json" style="width:100%;height:120px;padding:6px;border-radius:6px;border:1px solid #444;background:#0d0d18;color:#a0a0c0;font-size:10px;font-family:monospace;resize:vertical;box-sizing:border-box;outline:none;line-height:1.4" spellcheck="false">${esc(defaultJson)}</textarea>
        <div style="margin-top:6px;display:flex;gap:6px">
          <button class="mcp-btn pri" id="ext-add-submit" style="font-size:11px;padding:4px 10px">导入并启动</button>
          <button class="mcp-btn" id="ext-add-cancel" style="font-size:11px;padding:4px 10px">取消</button>
        </div>
      </div>`;

      html += `<div style="margin-top:8px"><button class="mcp-btn" id="ext-refresh" style="font-size:11px">刷新</button></div>`;

      secExt.innerHTML = html;

      // ── Preset install/configure buttons ──
      secExt.querySelectorAll('.ext-preset-install').forEach(btn => {
        btn.onclick = async (e) => {
          e.stopPropagation();
          const presetId = btn.dataset.presetId;
          const preset = presets.find(p => p.id === presetId);
          if (!preset) return;

          if (preset.params?.length > 0) {
            // Show param form (works for both new install and re-configure)
            presetParamForm = preset;
            renderExtTab();
          } else if (!installedIds.has(presetId)) {
            // One-click install (only for no-params presets that aren't installed)
            try {
              const result = await extApiCall(`/api/presets/${presetId}/install`, 'POST', {});
              if (result.ok) {
                setExtAction('success', `${preset.name} 已安装，${result.tools?.length || 0} 个工具`);
                toast(`${preset.name} 已安装，${result.tools?.length || 0} 个工具`, 'success');
                renderExtTab();
                refreshStatus();
              } else {
                setExtAction('error', `${preset.name}: ${result.error || '安装失败'}`);
                toast(result.error || '安装失败', 'error');
              }
            } catch (e) { setExtAction('error', `${preset.name}: ${e.message}`); toast(e.message, 'error'); }
          }
        };
      });

      // ── Param form submit ──
      const paramSubmit = secExt.querySelector('#ext-param-submit');
      if (paramSubmit) {
        paramSubmit.onclick = async () => {
          const params = {};
          secExt.querySelectorAll('.ext-param-input').forEach(inp => {
            params[inp.dataset.key] = inp.value.trim();
          });
          try {
            const result = await extApiCall(`/api/presets/${presetParamForm.id}/install`, 'POST', { params });
            if (result.ok) {
              setExtAction('success', `${presetParamForm.name} 已安装，${result.tools?.length || 0} 个工具`);
              toast(`${presetParamForm.name} 已安装，${result.tools?.length || 0} 个工具`, 'success');
              presetParamForm = null;
              renderExtTab();
              refreshStatus();
            } else {
              setExtAction('error', `${presetParamForm.name}: ${result.error || '安装失败'}`);
              toast(result.error || '安装失败', 'error');
            }
          } catch (e) { setExtAction('error', `${presetParamForm.name}: ${e.message}`); toast(e.message, 'error'); }
        };
      }
      const paramCancel = secExt.querySelector('#ext-param-cancel');
      if (paramCancel) {
        paramCancel.onclick = () => { presetParamForm = null; renderExtTab(); };
      }

      // ── Existing server management bindings ──

      // Add form toggle
      secExt.querySelector('#ext-add-btn')?.addEventListener('click', () => {
        extFormOpen = !extFormOpen;
        secExt.querySelector('#ext-add-form').style.display = extFormOpen ? 'block' : 'none';
      });

      // Cancel
      secExt.querySelector('#ext-add-cancel')?.addEventListener('click', () => {
        extFormOpen = false;
        secExt.querySelector('#ext-add-form').style.display = 'none';
      });

      // Submit JSON import
      secExt.querySelector('#ext-add-submit')?.addEventListener('click', async () => {
        const raw = secExt.querySelector('#ext-f-json').value.trim();
        if (!raw) { toast('请粘贴 JSON 配置', 'error'); return; }

        let parsed;
        try { parsed = JSON.parse(raw); }
        catch (e) { toast(`JSON 解析失败: ${e.message}`, 'error'); return; }

        // Auto-unwrap common wrappers
        if (parsed.mcpServers && typeof parsed.mcpServers === 'object') parsed = parsed.mcpServers;
        else if (parsed.servers && typeof parsed.servers === 'object') parsed = parsed.servers;

        let entries;
        if (parsed.name && typeof parsed.name === 'string') {
          const { name, ...cfg } = parsed;
          entries = { [name]: cfg };
        } else if (parsed.command || parsed.url) {
          toast('缺少 name 字段', 'error'); return;
        } else {
          entries = parsed;
        }

        try {
          const result = await extApiCall('/api/external-servers', 'POST', { mcpServers: entries });
          let added = 0, errors = [];
          for (const r of (result.results || [])) {
            if (r.ok) added++;
            else errors.push(`${r.name}: ${r.error || '未知错误'}`);
          }
          if (added > 0) {
            setExtAction('success', `已添加 ${added} 个服务器`);
            toast(`已添加 ${added} 个服务器`, 'success');
            extFormOpen = false;
            renderExtTab();
            refreshStatus();
          }
          if (errors.length) setExtAction('error', errors.join('\n'));
          errors.forEach(e => toast(e, 'error'));
        } catch (e) {
          setExtAction('error', `请求失败: ${e.message || '网络错误'}`);
          toast(`请求失败: ${e.message || '网络错误'}`, 'error');
        }
      });

      // Start/Stop/Remove
      secExt.querySelectorAll('.ext-start').forEach(btn => {
        btn.onclick = async () => {
          const name = btn.dataset.name;
          runExtServerAction(name, 'start', '已启动');
        };
      });

      secExt.querySelectorAll('.ext-stop').forEach(btn => {
        btn.onclick = async () => {
          const name = btn.dataset.name;
          runExtServerAction(name, 'stop', '已停止');
        };
      });

      secExt.querySelectorAll('.ext-remove').forEach(btn => {
        btn.onclick = async () => {
          const name = btn.dataset.name;
          if (!confirm(`确定删除 ${name}？`)) return;
          try {
            const result = await extApiCall(`/api/external-servers/${name}`, 'DELETE');
            setExtAction(result.ok ? 'success' : 'error', result.ok ? `${name} 已删除` : `${name}: ${result.error || '删除失败'}`);
            toast(result.ok ? `${name} 已删除` : result.error, result.ok ? 'success' : 'error');
            renderExtTab(); refreshStatus();
          } catch (e) { setExtAction('error', `${name}: ${e.message}`); toast(e.message, 'error'); }
        };
      });

      // Refresh
      secExt.querySelector('#ext-refresh')?.addEventListener('click', renderExtTab);
    }

    // ═══════════════════════════════════════════════════════════════
    //  Tab: Settings
    // ═══════════════════════════════════════════════════════════════
    const secSettings = panel.querySelector('#mcp-sec-settings');
    secSettings.innerHTML = `
      <div>
        <label class="mcp-label">MCP 服务器地址</label>
        <input class="mcp-input" id="mcp-cfg-url" value="${gmStore.get('mcp_url', DEFAULT_MCP_URL)}" />
      </div>
      <div style="margin-top:16px">
        <label class="mcp-label">模块开关</label>
        <div class="mcp-toggle-row">
          <div><div class="mcp-toggle-label">🔧 MCP 工具调用</div><div class="mcp-toggle-desc">拦截 AI 回复并执行本地工具</div></div>
          <label class="mcp-switch"><input type="checkbox" id="mod-toggle-mcp" ${getModuleEnabled('mcp') ? 'checked' : ''} /><span class="slider"></span></label>
        </div>
        <div class="mcp-toggle-row">
          <div><div class="mcp-toggle-label">📨 工具结果自动发送</div><div class="mcp-toggle-desc">工具结果填入输入框后自动提交</div></div>
          <label class="mcp-switch"><input type="checkbox" id="mcp-cfg-autosend" ${getAutoSendEnabled() ? 'checked' : ''} /><span class="slider"></span></label>
        </div>
        <div class="mcp-toggle-row">
          <div><div class="mcp-toggle-label">⚠️ execute_command 二次确认</div><div class="mcp-toggle-desc">执行本地 Shell 命令前弹出确认</div></div>
          <label class="mcp-switch"><input type="checkbox" id="mcp-cfg-confirm-exec" ${getConfirmExecuteEnabled() ? 'checked' : ''} /><span class="slider"></span></label>
        </div>
        <div class="mcp-toggle-row">
          <div><div class="mcp-toggle-label">🔊 TTS 朗读</div><div class="mcp-toggle-desc">AI 回复旁显示朗读按钮</div></div>
          <label class="mcp-switch"><input type="checkbox" id="mod-toggle-tts" ${getModuleEnabled('tts') ? 'checked' : ''} /><span class="slider"></span></label>
        </div>
        <div class="mcp-toggle-row">
          <div><div class="mcp-toggle-label">🔊 自动朗读</div><div class="mcp-toggle-desc">AI 回复完成后自动 TTS 播放</div></div>
          <label class="mcp-switch"><input type="checkbox" id="mod-toggle-ttsAutoPlay" ${getModuleEnabled('ttsAutoPlay') ? 'checked' : ''} /><span class="slider"></span></label>
        </div>
        <div class="mcp-toggle-row">
          <div><div class="mcp-toggle-label">🔊 当前会话自动朗读</div><div class="mcp-toggle-desc">${getCurrentConversationKey() ? '只对当前会话开启自动 TTS 播放' : '进入具体会话后可单独开启'}</div></div>
          <label class="mcp-switch"><input type="checkbox" id="mcp-cfg-session-autoplay" ${getSessionAutoPlayEnabled() ? 'checked' : ''} ${getCurrentConversationKey() ? '' : 'disabled'} /><span class="slider"></span></label>
        </div>
      </div>
      <div style="margin-top:16px">
        <label class="mcp-label">工具安全</label>
        <div style="font-size:11px;color:#666;margin-bottom:8px">每行或逗号分隔一个工具名。白名单为空表示允许所有未被黑名单拦截的工具。</div>
        <div style="margin-bottom:8px">
          <label class="mcp-label">白名单</label>
          <textarea class="mcp-input" id="mcp-cfg-whitelist" rows="3" placeholder="execute_command, read_file" style="resize:vertical;font-size:12px">${esc(gmStore.get(TOOL_WHITELIST_KEY, ''))}</textarea>
        </div>
        <div>
          <label class="mcp-label">黑名单</label>
          <textarea class="mcp-input" id="mcp-cfg-blacklist" rows="3" placeholder="write_file" style="resize:vertical;font-size:12px">${esc(gmStore.get(TOOL_BLACKLIST_KEY, ''))}</textarea>
        </div>
      </div>
      <div style="margin-top:16px">
        <label class="mcp-label">TTS 设置</label>
        <div class="mcp-toggle-row">
          <div><div class="mcp-toggle-label">引擎</div><div class="mcp-toggle-desc">TTS 提供者</div></div>
          <select class="mcp-sel" id="mcp-tts-provider" style="width:auto">
            <option value="edge" ${gmStore.get('tts_provider', 'edge') === 'edge' ? 'selected' : ''}>Edge TTS (免费)</option>
            <option value="openai" ${gmStore.get('tts_provider', 'edge') === 'openai' ? 'selected' : ''}>OpenAI 兼容</option>
          </select>
        </div>
        <div style="margin-top:8px">
          <label class="mcp-label">语音</label>
          <div style="display:flex;gap:6px;margin-bottom:6px">
            <select class="mcp-sel" id="mcp-tts-voice-filter-locale" style="width:auto;font-size:11px">
              <option value="">全部语言</option>
              <option value="zh-">中文</option>
              <option value="en-">英语</option>
              <option value="ja-">日语</option>
              <option value="ko-">韩语</option>
            </select>
            <select class="mcp-sel" id="mcp-tts-voice-filter-gender" style="width:auto;font-size:11px">
              <option value="">全部性别</option>
              <option value="Female">女声</option>
              <option value="Male">男声</option>
            </select>
          </div>
          <select class="mcp-sel" id="mcp-tts-voice" style="width:100%">
            <option value="${gmStore.get('tts_voice', 'zh-CN-XiaoxiaoNeural')}">加载中...</option>
          </select>
          <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:6px">
            <div id="mcp-tts-voice-status" style="font-size:10px;color:#666"></div>
            <button class="mcp-btn" id="mcp-tts-preview" style="font-size:11px;padding:4px 9px">预览</button>
          </div>
        </div>
        <div id="mcp-tts-adv" style="display:${gmStore.get('tts_provider', 'edge') !== 'edge' ? 'block' : 'none'};margin-top:8px;padding:8px;background:#1a1a28;border-radius:8px;border:1px solid #333">
          <div style="font-size:11px;color:#888;margin-bottom:6px">OpenAI 兼容配置</div>
          <div style="margin-bottom:6px"><label class="mcp-label">API Key</label><input class="mcp-input" id="mcp-tts-apikey" type="password" value="${gmStore.get('tts_api_key', '')}" placeholder="sk-..." style="font-size:12px" /></div>
          <div style="margin-bottom:6px"><label class="mcp-label">Base URL</label><input class="mcp-input" id="mcp-tts-baseurl" value="${gmStore.get('tts_base_url', 'https://api.openai.com/v1')}" style="font-size:12px" /></div>
          <div><label class="mcp-label">模型</label><input class="mcp-input" id="mcp-tts-model" value="${gmStore.get('tts_model', 'tts-1')}" placeholder="tts-1 / tts-1-hd" style="font-size:12px" /></div>
        </div>
      </div>
      <div style="margin-top:8px;font-size:11px;color:#555">适配器: ${currentAdapter ? currentAdapter.name : '无'}</div>
      <div style="margin-top:12px"><button class="mcp-btn pri" id="mcp-cfg-save">保存</button></div>
    `;

    secSettings.querySelector('#mcp-cfg-save').onclick = () => {
      const url = secSettings.querySelector('#mcp-cfg-url').value.trim();
      if (!url) { toast('地址不能为空', 'error'); return; }
      gmStore.set('mcp_url', url);
      ['mcp', 'tts', 'ttsAutoPlay'].forEach(mod => {
        const toggle = secSettings.querySelector('#mod-toggle-' + mod);
        if (toggle) setModuleEnabled(mod, toggle.checked);
      });
      const autoSendToggle = secSettings.querySelector('#mcp-cfg-autosend');
      if (autoSendToggle) gmStore.set(AUTO_SEND_KEY, autoSendToggle.checked);
      const confirmExecToggle = secSettings.querySelector('#mcp-cfg-confirm-exec');
      if (confirmExecToggle) gmStore.set(CONFIRM_EXEC_KEY, confirmExecToggle.checked);
      const sessionAutoToggle = secSettings.querySelector('#mcp-cfg-session-autoplay');
      if (sessionAutoToggle && !sessionAutoToggle.disabled) setSessionAutoPlayEnabled(sessionAutoToggle.checked);
      const whitelistInput = secSettings.querySelector('#mcp-cfg-whitelist');
      if (whitelistInput) gmStore.set(TOOL_WHITELIST_KEY, whitelistInput.value.trim());
      const blacklistInput = secSettings.querySelector('#mcp-cfg-blacklist');
      if (blacklistInput) gmStore.set(TOOL_BLACKLIST_KEY, blacklistInput.value.trim());
      const providerSel = secSettings.querySelector('#mcp-tts-provider');
      if (providerSel) gmStore.set('tts_provider', providerSel.value);
      const voiceInput = secSettings.querySelector('#mcp-tts-voice');
      if (voiceInput) gmStore.set('tts_voice', voiceInput.value.trim());
      const apiKeyInput = secSettings.querySelector('#mcp-tts-apikey');
      if (apiKeyInput) gmStore.set('tts_api_key', apiKeyInput.value.trim());
      const baseUrlInput = secSettings.querySelector('#mcp-tts-baseurl');
      if (baseUrlInput) gmStore.set('tts_base_url', baseUrlInput.value.trim());
      const modelInput = secSettings.querySelector('#mcp-tts-model');
      if (modelInput) gmStore.set('tts_model', modelInput.value.trim());
      toast('已保存', 'success');
      refreshStatus();
    };

    secSettings.querySelector('#mcp-tts-provider')?.addEventListener('change', (e) => {
      const adv = secSettings.querySelector('#mcp-tts-adv');
      if (adv) adv.style.display = e.target.value !== 'edge' ? 'block' : 'none';
    });

    secSettings.querySelector('#mcp-tts-preview')?.addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      const voiceSel = secSettings.querySelector('#mcp-tts-voice');
      const status = secSettings.querySelector('#mcp-tts-voice-status');
      const voice = voiceSel?.value?.trim();
      if (!voice) { toast('请先选择语音', 'error'); return; }
      gmStore.set('tts_voice', voice);
      const oldText = btn.textContent;
      btn.disabled = true;
      btn.textContent = '预览中...';
      if (status) status.textContent = `正在预览 ${voice}`;
      try {
        await ttsClient.play('你好，这是当前语音预览。');
        if (status) status.textContent = `已预览 ${voice}`;
      } catch (err) {
        if (status) status.textContent = `预览失败: ${err.message}`;
        toast('语音预览失败: ' + err.message, 'error');
      } finally {
        btn.disabled = false;
        btn.textContent = oldText;
      }
    });

    // Load Edge TTS voices — with built-in fallback list
    (function loadVoices() {
      const voiceSel = secSettings.querySelector('#mcp-tts-voice');
      const localeFilter = secSettings.querySelector('#mcp-tts-voice-filter-locale');
      const genderFilter = secSettings.querySelector('#mcp-tts-voice-filter-gender');
      const status = secSettings.querySelector('#mcp-tts-voice-status');
      if (!voiceSel) return;

      // Built-in Chinese voices (works without server)
      const BUILTIN_VOICES = [
        { id: 'zh-CN-XiaoxiaoNeural', gender: 'Female', locale: 'zh-CN' },
        { id: 'zh-CN-XiaoyiNeural', gender: 'Female', locale: 'zh-CN' },
        { id: 'zh-CN-YunjianNeural', gender: 'Male', locale: 'zh-CN' },
        { id: 'zh-CN-YunxiNeural', gender: 'Male', locale: 'zh-CN' },
        { id: 'zh-CN-YunxiaNeural', gender: 'Male', locale: 'zh-CN' },
        { id: 'zh-CN-YunyangNeural', gender: 'Male', locale: 'zh-CN' },
        { id: 'zh-CN-liaoning-XiaobeiNeural', gender: 'Female', locale: 'zh-CN-liaoning' },
        { id: 'zh-CN-shaanxi-XiaoniNeural', gender: 'Female', locale: 'zh-CN-shaanxi' },
        { id: 'zh-HK-HiuGaaiNeural', gender: 'Female', locale: 'zh-HK' },
        { id: 'zh-HK-HiuMaanNeural', gender: 'Female', locale: 'zh-HK' },
        { id: 'zh-HK-WanLungNeural', gender: 'Male', locale: 'zh-HK' },
        { id: 'zh-TW-HsiaoChenNeural', gender: 'Female', locale: 'zh-TW' },
        { id: 'zh-TW-YunJheNeural', gender: 'Male', locale: 'zh-TW' },
        { id: 'zh-TW-HsiaoYuNeural', gender: 'Female', locale: 'zh-TW' },
        { id: 'en-US-JennyNeural', gender: 'Female', locale: 'en-US' },
        { id: 'en-US-GuyNeural', gender: 'Male', locale: 'en-US' },
        { id: 'en-US-AriaNeural', gender: 'Female', locale: 'en-US' },
        { id: 'ja-JP-NanamiNeural', gender: 'Female', locale: 'ja-JP' },
        { id: 'ja-JP-KeitaNeural', gender: 'Male', locale: 'ja-JP' },
        { id: 'ko-KR-SunHiNeural', gender: 'Female', locale: 'ko-KR' },
        { id: 'ko-KR-InJoonNeural', gender: 'Male', locale: 'ko-KR' },
      ];

      let allVoices = BUILTIN_VOICES;
      const currentVoice = gmStore.get('tts_voice', 'zh-CN-XiaoxiaoNeural');

      function renderVoices() {
        const locale = localeFilter?.value || '';
        const gender = genderFilter?.value || '';
        const filtered = allVoices.filter(v =>
          (!locale || v.id.includes(locale) || v.id.startsWith(locale)) &&
          (!gender || v.gender === gender)
        );
        voiceSel.innerHTML = '';
        if (!filtered.length) {
          voiceSel.innerHTML = '<option value="">无匹配语音</option>';
          if (status) status.textContent = '无匹配语音';
          return;
        }
        for (const v of filtered) {
          const opt = document.createElement('option');
          opt.value = v.id;
          const g = v.gender === 'Female' ? '♀' : '♂';
          opt.textContent = g + ' ' + v.id;
          if (v.id === currentVoice) opt.selected = true;
          voiceSel.appendChild(opt);
        }
        if (status) status.textContent = filtered.length + ' / ' + allVoices.length + ' 个语音' + (allVoices.length > BUILTIN_VOICES.length ? '' : ' (内置列表)');
      }

      // Render builtin list immediately
      renderVoices();

      // Try loading full list from server in background
      const url = getExtBaseUrl() + '/api/tts/voices';
      GM_xmlhttpRequest({
        method: 'GET', url, timeout: 10000,
        onload: (resp) => {
          try {
            const data = JSON.parse(resp.responseText);
            if (data.voices?.length) {
              allVoices = data.voices;
              renderVoices();
            } else if (status) {
              status.textContent = status.textContent || '使用内置语音列表';
            }
          } catch { }
        },
        onerror: () => { if (status) status.textContent = `${status.textContent || '内置语音列表'}，server 语音列表加载失败`; },
        ontimeout: () => { if (status) status.textContent = `${status.textContent || '内置语音列表'}，server 语音列表超时`; },
      });

      localeFilter?.addEventListener('change', renderVoices);
      genderFilter?.addEventListener('change', renderVoices);
    })();


    // ═══════════════════════════════════════════════════════════════
    //  MCP Code Block Actions + System Instruction Folding
    // ═══════════════════════════════════════════════════════════════
    function getMCPCodeInfo(block) {
      const banner = currentAdapter.findCodeBanner(block);
      const blockText = block.textContent || '';
      const langText = banner?.textContent || '';
      let match = langText.match(/(?:^|\s)mcp:([\w.-]+)(?:\s|$)/);
      if (!match) match = blockText.match(/```mcp:([\w.-]+)\s*([\s\S]*?)```/);
      if (!match) match = blockText.match(/^\s*mcp:([\w.-]+)(?:\s|$)/);
      if (!match) return null;

      const toolName = match[1];
      let rawArgs = '';
      if (match[2]) rawArgs = match[2].trim();
      else {
        const pre = currentAdapter.findCodeContentElement(block);
        rawArgs = (pre?.innerText || pre?.textContent || '').trim();
      }
      rawArgs = rawArgs.replace(new RegExp(`^mcp:${toolName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*`, 'i'), '').trim();
      return { toolName, rawArgs };
    }

    function getCodeActionContainer(block) {
      return currentAdapter.findCodeActionContainer(block);
    }

    function enhanceMCPCodeBlocks() {
      currentAdapter.findMCPCodeBlockCandidates().forEach(block => {
        if (!block || block.dataset?.mcpEnhanced === '1') return;
        if (block.closest?.('#mcp-panel')) return;
        const info = getMCPCodeInfo(block);
        if (!info) return;
        const actionContainer = getCodeActionContainer(block);
        if (!actionContainer) return;

        block.dataset.mcpEnhanced = '1';
        block.classList.add('mcp-code-hidden');

        const collapseBtn = document.createElement('button');
        collapseBtn.type = 'button';
        collapseBtn.className = 'mcp-code-action collapse';
        collapseBtn.textContent = '展开';
        collapseBtn.title = '展开或折叠 MCP 指令';
        collapseBtn.onclick = (e) => {
          e.preventDefault();
          e.stopPropagation();
          const hidden = block.classList.toggle('mcp-code-hidden');
          collapseBtn.textContent = hidden ? '展开' : '折叠';
        };

        const resendBtn = document.createElement('button');
        resendBtn.type = 'button';
        resendBtn.className = 'mcp-code-action resend';
        resendBtn.textContent = '重发';
        resendBtn.title = `重新执行 ${info.toolName}`;
        resendBtn.onclick = (e) => {
          e.preventDefault();
          e.stopPropagation();
          const latest = getMCPCodeInfo(block) || info;
          executeToolCall(latest.toolName, parseToolArgs(latest.rawArgs));
          toast(`已重发: ${latest.toolName}`, 'info');
        };

        const copyArgsBtn = document.createElement('button');
        copyArgsBtn.type = 'button';
        copyArgsBtn.className = 'mcp-code-action copy-args';
        copyArgsBtn.textContent = '复制参数';
        copyArgsBtn.title = `复制 ${info.toolName} 的 MCP 参数`;
        copyArgsBtn.onclick = (e) => {
          e.preventDefault();
          e.stopPropagation();
          const latest = getMCPCodeInfo(block) || info;
          copyText(latest.rawArgs || '');
        };

        actionContainer.appendChild(collapseBtn);
        actionContainer.appendChild(copyArgsBtn);
        actionContainer.appendChild(resendBtn);
      });
    }

    function findTightSystemInstructionElement(root) {
      let node = root;
      while (node?.children?.length) {
        const children = Array.from(node.children).filter(child => {
          if (child.closest?.('.mcp-sys-fold')) return false;
          const text = child.textContent || '';
          return text.includes(SYSTEM_HINT_START) && text.includes(SYSTEM_HINT_END);
        });
        if (children.length !== 1) break;
        node = children[0];
      }
      return node;
    }

    function foldSystemInstructionElement(target) {
      if (!target || target.dataset?.mcpSystemFolded === '1') return;
      if (target.querySelector?.('.mcp-sys-fold')) return;
      const text = target.textContent || '';
      const start = text.indexOf(SYSTEM_HINT_START);
      const endStart = text.indexOf(SYSTEM_HINT_END, start);
      if (start < 0 || endStart < 0) return;

      const end = endStart + SYSTEM_HINT_END.length;
      const before = text.slice(0, start).trim();
      const hidden = text.slice(start, end).trim();
      const after = text.slice(end).trim();
      if (hidden.length < 80) return;

      const frag = document.createDocumentFragment();
      const addTextBlock = (content) => {
        if (!content) return;
        const el = document.createElement('div');
        el.style.whiteSpace = 'pre-wrap';
        el.textContent = content;
        frag.appendChild(el);
      };

      addTextBlock(before);

      const fold = document.createElement('div');
      fold.className = 'mcp-sys-fold';
      fold.innerHTML = `
        <div class="mcp-sys-fold-hd"><span class="mcp-sys-fold-title">${SYSTEM_HINT_START}</span><span class="mcp-sys-fold-toggle">展开</span></div>
        <div class="mcp-sys-fold-body"></div>
      `;
      fold.querySelector('.mcp-sys-fold-body').textContent = hidden;
      fold.querySelector('.mcp-sys-fold-hd').onclick = () => {
        const open = fold.classList.toggle('open');
        fold.querySelector('.mcp-sys-fold-toggle').textContent = open ? '折叠' : '展开';
      };
      frag.appendChild(fold);

      addTextBlock(after);
      target.dataset.mcpSystemFolded = '1';
      target.replaceChildren(frag);
    }

    function collapseSystemInstructions() {
      const roots = currentAdapter.findSystemInstructionRoots();
      roots.forEach(root => {
        if (root.closest('#mcp-panel, .mcp-sys-fold')) return;
        if (root.dataset?.mcpSystemFolded === '1' || root.querySelector?.('.mcp-sys-fold')) return;
        const text = root.textContent || '';
        if (!text.includes(SYSTEM_HINT_START) || !text.includes(SYSTEM_HINT_END)) return;
        const target = findTightSystemInstructionElement(root);
        if (!target || target === document.body || target === document.documentElement) return;
        foldSystemInstructionElement(target);
      });
    }

    function enhanceChatUI() {
      enhanceMCPCodeBlocks();
      collapseSystemInstructions();
      injectTTSButtons();
    }


    // ═══════════════════════════════════════════════════════════════
    //  TTS Button Injection — Add 🔊 to assistant messages
    // ═══════════════════════════════════════════════════════════════
    const _ttsSeenMessages = new WeakSet();
    const _ttsAutoPlayContainers = new Set();
    const _ttsAutoPlayTimers = new Map();

    function injectTTSButtons() {
      if (!getModuleEnabled('tts')) return;
      const messages = currentAdapter.findAssistantMessages();
      messages.forEach(msg => {
        const text = msg.textContent?.trim();
        if (!text || text.length < 10) return;
        const isNew = !_ttsSeenMessages.has(msg);
        _ttsSeenMessages.add(msg);
        const container = currentAdapter.findMessageContainer(msg);

        // Check for existing button on the container (not just msg, since we insert into action bar)
        if (container.querySelector('.mcp-tts-btn')) return;

        const btn = document.createElement('button');
        btn.className = 'mcp-tts-btn';
        btn.innerHTML = '🔊 朗读';
        btn.title = '朗读';
        btn.onclick = (e) => {
          e.stopPropagation();
          const freshText = msg.textContent?.trim() || text;
          if (ttsClient.playing && ttsClient.currentText === freshText) {
            ttsClient.stop();
            btn.innerHTML = '🔊 朗读';
            btn.classList.remove('playing', 'paused');
            return;
          }
          btn.innerHTML = '⏳ 合成中...';
          btn.style.minWidth = (btn.offsetWidth || 56) + 'px';
          ttsClient.play(freshText).then(() => {
            btn.innerHTML = '⏸ 暂停';
            btn.classList.add('playing');
            const check = setInterval(() => {
              if (!ttsClient.playing) {
                btn.innerHTML = '🔊 朗读';
                btn.classList.remove('playing', 'paused');
                btn.style.minWidth = '';
                clearInterval(check);
              }
            }, 500);
          }).catch(err => {
            btn.innerHTML = '⚠️ 失败';
            btn.classList.add('failed');
            btn.style.minWidth = '';
            toast('TTS 失败: ' + err.message, 'error');
            setTimeout(() => {
              btn.innerHTML = '🔊 朗读';
              btn.classList.remove('failed');
            }, 1800);
          });
        };

        // Insert into action bar at the bottom of the message
        const actionBar = currentAdapter.findMessageActions(msg);
        if (actionBar) {
          actionBar.appendChild(btn);
        } else {
          container.appendChild(btn);
        }

        // Auto-play: track by container, wait for text to stabilize
        if (isNew && shouldAutoPlayTTSForCurrentSession() && !_ttsAutoPlayContainers.has(container)) {
          _ttsAutoPlayContainers.add(container);
          _watchTextStable(container);
        }
      });
    }

    // Watch a container until its text stops changing, then play TTS
    function _watchTextStable(container) {
      let lastLen = 0;
      let stableCount = 0;
      const check = setInterval(() => {
        const md = currentAdapter.findAssistantMessageInContainer(container);
        if (!md) return;
        const len = md.textContent.length;
        if (len > 0 && len === lastLen) {
          stableCount++;
        } else {
          stableCount = 0;
          lastLen = len;
        }
        if (stableCount >= 2 && lastLen > 10) {
          clearInterval(check);
          _ttsAutoPlayTimers.delete(container);
          ttsClient.play(md.textContent.trim()).catch(err => console.warn('Auto TTS:', err.message));
        }
      }, 1000);
      setTimeout(() => clearInterval(check), 60000);
      _ttsAutoPlayTimers.set(container, check);
    }

    // ═══════════════════════════════════════════════════════════════
    //  MutationObserver — TTS button injection
    // ═══════════════════════════════════════════════════════════════
    let _uiDebounce = null;
    let _isPageVisible = true;

    const uiObserver = new MutationObserver((mutations) => {
      let hasNewNodes = false;
      for (const m of mutations) {
        if (m.addedNodes.length > 0) { hasNewNodes = true; break; }
      }
      if (!hasNewNodes) return;
      if (_uiDebounce) clearTimeout(_uiDebounce);
      _uiDebounce = setTimeout(() => {
        if (!_isPageVisible) return;
        const _run = () => enhanceChatUI();
        if ('requestIdleCallback' in window) {
          requestIdleCallback(_run, { timeout: 2000 });
        } else {
          setTimeout(_run, 200);
        }
      }, 1000);
    });

    function _reconnectObserver() {
      const chatContainer = currentAdapter.findChatContainer();
      uiObserver.observe(chatContainer, { childList: true, subtree: true });
    }

    setTimeout(() => {
      _reconnectObserver();
      enhanceChatUI();
    }, 2000);

    // ── Visibility change: pause/resume to prevent deferred-callback pile-up ──
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        _isPageVisible = false;
        uiObserver.disconnect();
        if (_uiDebounce) { clearTimeout(_uiDebounce); _uiDebounce = null; }
        // Clear all auto-play timers so they don't pile up while hidden
        for (const [container, timer] of _ttsAutoPlayTimers) {
          clearInterval(timer);
        }
        _ttsAutoPlayTimers.clear();
        // Stop any active TTS playback
        if (ttsClient.playing) ttsClient.stop();
      } else {
        _isPageVisible = true;
        _reconnectObserver();
        enhanceChatUI();
      }
    });

    // ── Auto-connect on load ──
    refreshStatus();

    function esc(t) { const d = document.createElement('div'); d.textContent = t; return d.innerHTML; }
  });
})();
