// ==UserScript==
// @name         DS Enhance
// @namespace    https://github.com/calendar0917/DeepseekWeb-enhance
// @version      3.2.3
// @description  批量删除、Fork 对话、会话分类、搜索、导出、批量重命名、多提示词注入
// @author       ds-enhance
// @homepageURL  https://github.com/calendar0917/DeepseekWeb-enhance
// @icon         https://fe-static.deepseek.com/chat/favicon.svg
// @match        https://chat.deepseek.com/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

(function () {
  'use strict';

  const API = 'https://chat.deepseek.com/api/v0';
  const LS_CATS = 'dse_categories';
  const LS_PROMPT = 'dse_custom_prompt';     // legacy single-prompt key (migration)
  const LS_PROMPTS = 'dse_prompts';           // multi-prompt: [{id, name, content, enabled}]
  const CUSTOM_PROMPT_MARKER = '[自定义提示词]';

  // ═══════════════════════════════════════════════════════════════════
  //  Prompt Injection (runs at document-start, before page scripts)
  // ═══════════════════════════════════════════════════════════════════
  function getEnabledPrompts() {
    try {
      const arr = JSON.parse(localStorage.getItem(LS_PROMPTS) || '[]');
      if (Array.isArray(arr) && arr.length) {
        return arr.filter(p => p.enabled).map(p => p.content).filter(Boolean);
      }
    } catch { /* corrupt */ }
    // legacy fallback
    const single = (localStorage.getItem(LS_PROMPT) || '').trim();
    return single ? [single] : [];
  }

  // ═══════════════════════════════════════════════════════════════════
  //  对话切换监控与指纹记忆机制
  // ═══════════════════════════════════════════════════════════════════
  let lastInjectedSignature = null; // 记录上一次注入的具体内容

  const originalPushState = history.pushState;
  history.pushState = function(...args) {
    const newUrl = args[2];
    if (newUrl) {
      const oldPath = location.pathname;
      const newPath = newUrl.toString().startsWith('http')
          ? new URL(newUrl).pathname
          : new URL(newUrl, location.origin).pathname;

      if (oldPath === '/' && newPath.startsWith('/s/')) {
          // 原地获取房间号，不重置
      } else if (oldPath !== newPath) {
          // 切换了房间，重置指纹
          lastInjectedSignature = null;
      }
    }
    return originalPushState.apply(this, args);
  };

  window.addEventListener('popstate', () => {
    lastInjectedSignature = null;
  });

  // ═══════════════════════════════════════════════════════════════════
  //  注入与修改请求逻辑
  // ═══════════════════════════════════════════════════════════════════

  function modifyRequest(bodyStr) {
    const enabled = getEnabledPrompts();
    // 生成当前所有开启状态的提示词的“指纹”
    const currentSignature = enabled.join('\n\n');

    // 逻辑分支 1：如果当前关闭了所有提示词，清空指纹记录，直接放行
    if (!currentSignature) {
      lastInjectedSignature = null;
      return bodyStr;
    }

    if (!bodyStr) return bodyStr;
    if (bodyStr.includes(CUSTOM_PROMPT_MARKER)) return bodyStr;

    // 逻辑分支 2：对比指纹。如果当前要发的提示词和上次发的一模一样，直接切断
    if (lastInjectedSignature === currentSignature) {
      return bodyStr;
    }

    // 逻辑分支 3：是全新的提示词，或者是改了字的提示词，执行注入
    try {
      const parsed = JSON.parse(bodyStr);
      const tagged = `${CUSTOM_PROMPT_MARKER}\n${currentSignature}`;
      let injected = false;

      // 后置注入逻辑
      if (parsed.prompt && typeof parsed.prompt === 'string') {
        parsed.prompt = parsed.prompt + '\n\n' + tagged;
        injected = true;
      }
      if (parsed.messages?.length) {
        const lastIdx = parsed.messages.length - 1;
        parsed.messages[lastIdx].content = parsed.messages[lastIdx].content + '\n\n' + tagged;
        injected = true;
      }

      if (injected) {
        // 注入成功后，更新指纹记录为当前提示词
        lastInjectedSignature = currentSignature;
        return JSON.stringify(parsed);
      }
    } catch { /* not JSON */ }
    return bodyStr;
  }

  // Hook XHR
  const XHRProto = XMLHttpRequest.prototype;
  const _origOpen = XHRProto.open;
  const _origSend = XHRProto.send;
  const _xhrMeta = new WeakMap();

  XHRProto.open = function (method, url, ...rest) {
    _xhrMeta.set(this, { url });
    return _origOpen.apply(this, [method, url, ...rest]);
  };

  XHRProto.send = function (body) {
    const meta = _xhrMeta.get(this);
    if (meta && meta.url.includes('completion') && body) {
      body = modifyRequest(body);
    }
    return _origSend.apply(this, [body]);
  };

  // Hook fetch
  const _origFetch = window.fetch;

  window.fetch = async function (...args) {
    const url = (typeof args[0] === 'string') ? args[0] : args[0]?.url;
    if (url && url.includes('completion') && args[1]?.body) {
      args[1].body = modifyRequest(args[1].body);
    }
    return _origFetch.apply(this, args);
  };

  // ═══════════════════════════════════════════════════════════════════
  //  Wait for DOM before initializing UI
  // ═══════════════════════════════════════════════════════════════════
  function waitForDOM() {
    return new Promise(resolve => {
      if (document.body) resolve();
      else new MutationObserver(() => { if (document.body) resolve(); })
        .observe(document.documentElement, { childList: true });
    });
  }

  waitForDOM().then(() => {

  // ═══════════════════════════════════════════════════════════════════
  //  API
  // ═══════════════════════════════════════════════════════════════════
  function getToken() {
    try {
      const raw = localStorage.getItem('userToken');
      if (!raw) return null;
      const p = JSON.parse(raw);
      return typeof p === 'object' ? p.value || p.token || p : p;
    } catch {
      return localStorage.getItem('userToken');
    }
  }

  async function api(path, method = 'GET', body) {
    const token = getToken();
    if (!token) throw new Error('未找到 userToken，请先登录 DeepSeek');
    const opts = { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'X-App-Version': '2025.04.25' } };
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(`${API}${path}`, opts);
    const json = await res.json();
    if (json.code !== 0) throw new Error(json.msg || `API error ${json.code}`);
    return json.data;
  }

  async function fetchSessionsPage(cursor) {
    const params = new URLSearchParams({ count: '50' });
    if (cursor && cursor.updated_at != null) {
      params.set('lte_cursor.pinned', String(cursor.pinned ? 1 : 0));
      params.set('lte_cursor.updated_at', String(cursor.updated_at));
    }
    return api(`/chat_session/fetch_page?${params.toString()}`);
  }

  function getSessionKey(session) {
    return session?.id || session?.chat_session_id || session?.chatSessionId || session?.session_id || '';
  }

  function getSessionUpdatedAt(session) {
    const candidates = [session?.updated_at, session?.updatedAt, session?.update_time, session?.updateTime];
    for (const value of candidates) {
      if (value == null || value === '') continue;
      const n = Number(value);
      if (Number.isFinite(n)) return n;
    }
    return null;
  }

  function normalizeSession(session) {
    const id = getSessionKey(session);
    const updatedAt = getSessionUpdatedAt(session);
    const normalized = { ...session };
    if (id && !normalized.id) normalized.id = id;
    if (updatedAt != null && normalized.updated_at == null) normalized.updated_at = updatedAt;
    return normalized;
  }

  function buildSessionCursor(session) {
    const updatedAt = getSessionUpdatedAt(session);
    if (updatedAt == null) return null;
    return { pinned: session?.pinned ? 1 : 0, updated_at: updatedAt };
  }

  function cursorKey(cursor) {
    return cursor ? `${cursor.pinned ? 1 : 0}:${cursor.updated_at}` : '__first__';
  }

  async function fetchAllSessions() {
    const sessions = [];
    const seenIds = new Set();
    const seenCursors = new Set();
    let cursor = null;

    for (let i = 0; i < 100; i++) {
      const currentCursorKey = cursorKey(cursor);
      if (seenCursors.has(currentCursorKey)) break;
      seenCursors.add(currentCursorKey);

      const data = await fetchSessionsPage(cursor);
      const biz = data?.biz_data;
      const list = Array.isArray(biz?.chat_sessions) ? biz.chat_sessions : [];
      let addedThisPage = 0;
      for (const raw of list) {
        const session = normalizeSession(raw);
        const id = getSessionKey(session);
        if (!id || seenIds.has(id)) continue;
        seenIds.add(id);
        sessions.push(session);
        addedThisPage++;
      }

      if (!biz?.has_more || !list.length) break;
      if (!addedThisPage) break;
      const nextCursor = buildSessionCursor(list[list.length - 1]);
      if (!nextCursor) break;
      const nextCursorKey = cursorKey(nextCursor);
      if (nextCursorKey === currentCursorKey) break;
      cursor = nextCursor;
    }

    return sessions;
  }

  const apiDelete = (id) => api('/chat_session/delete', 'POST', { chat_session_id: id });
  const apiDeleteAll = () => api('/chat_session/delete_all', 'POST');
  const apiRename = (id, title) => api('/chat_session/update_title', 'POST', { chat_session_id: id, title });
  const apiHistory = (id) => api(`/chat/history_messages?chat_session_id=${id}`);
  const apiCreateShare = (sid, mids) => api('/share/create', 'POST', { chat_session_id: sid, message_ids: mids });
  const apiForkShare = (shareId) => api('/share/fork', 'POST', { share_id: shareId });

  // ═══════════════════════════════════════════════════════════════════
  //  Categories (localStorage)
  // ═══════════════════════════════════════════════════════════════════
  function loadCats() {
    try { return JSON.parse(localStorage.getItem(LS_CATS)) || { categories: [], sessionMap: {} }; }
    catch { return { categories: [], sessionMap: {} }; }
  }
  function saveCats(data) { localStorage.setItem(LS_CATS, JSON.stringify(data)); }
  let catData = loadCats();

  function addCategory(name, color) {
    catData.categories.push({ id: 'cat_' + Date.now(), name, color });
    saveCats(catData);
  }
  function removeCategory(catId) {
    catData.categories = catData.categories.filter(c => c.id !== catId);
    for (const sid in catData.sessionMap) {
      catData.sessionMap[sid] = catData.sessionMap[sid].filter(c => c !== catId);
      if (!catData.sessionMap[sid].length) delete catData.sessionMap[sid];
    }
    saveCats(catData);
  }
  function toggleCatSession(sid, catId) {
    if (!catData.sessionMap[sid]) catData.sessionMap[sid] = [];
    const idx = catData.sessionMap[sid].indexOf(catId);
    if (idx >= 0) catData.sessionMap[sid].splice(idx, 1);
    else catData.sessionMap[sid].push(catId);
    if (!catData.sessionMap[sid].length) delete catData.sessionMap[sid];
    saveCats(catData);
  }
  function getSessionCats(sid) { return catData.sessionMap[sid] || []; }
  function filterByCat(sessions, catId) {
    if (!catId) return sessions;
    return sessions.filter(s => (catData.sessionMap[s.id] || []).includes(catId));
  }

  // ═══════════════════════════════════════════════════════════════════
  //  Helpers
  // ═══════════════════════════════════════════════════════════════════
  function esc(t) { const d = document.createElement('div'); d.textContent = t; return d.innerHTML; }
  function getSessionId() { const m = location.pathname.match(/\/s\/([a-f0-9-]+)/); return m ? m[1] : null; }
  function fmtDate(ts) {
    if (!ts) return '';
    const d = new Date(ts * 1000);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }
  function download(name, content, mime) {
    const blob = new Blob([content], { type: mime });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  function toast(msg, type = 'info') {
    const colors = { info: '#2a2a3e', success: '#0d3320', error: '#3d0f0f' };
    const el = document.createElement('div');
    el.style.cssText = `position:fixed;bottom:24px;right:24px;z-index:2000001;background:${colors[type]};color:#eee;padding:12px 22px;border-radius:10px;font-size:14px;box-shadow:0 4px 20px rgba(0,0,0,.5);font-family:system-ui;transition:opacity .3s;`;
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(() => { el.style.opacity = '0'; setTimeout(() => el.remove(), 300); }, 3500);
  }

  // ═══════════════════════════════════════════════════════════════════
  //  CSS
  // ═══════════════════════════════════════════════════════════════════
  const style = document.createElement('style');
  style.textContent = `
    #dse-fab{position:fixed;z-index:999999;width:48px;height:48px;border-radius:50%;background:#2563eb;color:#fff;border:none;font-size:22px;cursor:grab;display:flex;align-items:center;justify-content:center;box-shadow:0 2px 12px rgba(37,99,235,.4);user-select:none;-webkit-user-select:none;touch-action:none}
    #dse-fab:active{cursor:grabbing}
    #dse-fab:hover{transform:scale(1.1);box-shadow:0 4px 20px rgba(37,99,235,.6)}

    #dse-panel{position:fixed;z-index:999998;width:460px;max-height:75vh;background:#16161e;color:#eee;border:1px solid #333;border-radius:14px;box-shadow:0 8px 40px rgba(0,0,0,.6);font-family:system-ui;font-size:14px;display:none;flex-direction:column;overflow:hidden}
    #dse-panel.open{display:flex}
    #dse-panel .hd{padding:14px 18px;border-bottom:1px solid #2a2a3a;display:flex;align-items:center;justify-content:space-between;flex-shrink:0}
    #dse-panel .hd h3{margin:0;font-size:15px;font-weight:600}
    #dse-panel .hd .cls{background:none;border:none;color:#888;font-size:20px;cursor:pointer;padding:0 4px}
    #dse-panel .hd .cls:hover{color:#fff}

    #dse-tabs{display:flex;border-bottom:1px solid #2a2a3a;overflow-x:auto;scrollbar-width:none;flex-shrink:0}
    #dse-tabs::-webkit-scrollbar{display:none}
    #dse-tabs button{flex:0 0 auto;padding:9px 14px;background:none;border:none;color:#888;font-size:12px;cursor:pointer;border-bottom:2px solid transparent;transition:color .15s,border-color .15s;white-space:nowrap}
    #dse-tabs button.active{color:#7aa2f7;border-bottom-color:#7aa2f7}
    #dse-tabs button:hover{color:#ccc}

    .dse-bd{flex:1;overflow-y:auto;padding:12px 14px}
    .dse-section{display:none}.dse-section.active{display:block}

    .dse-actions{display:flex;gap:6px;margin-bottom:10px;flex-wrap:wrap}
    .dse-actions button{padding:6px 12px;border-radius:8px;border:1px solid #444;background:#222;color:#eee;font-size:12px;cursor:pointer;transition:background .15s}
    .dse-actions button:hover{background:#333}
    .dse-actions button.pri{background:#2563eb;border-color:#2563eb;color:#fff}
    .dse-actions button.pri:hover{background:#3b82f6}
    .dse-actions button.dng{background:#7f1d1d;border-color:#991b1b}
    .dse-actions button.dng:hover{background:#991b1b}

    .dse-input{width:100%;padding:8px 12px;border-radius:8px;border:1px solid #444;background:#1a1a28;color:#eee;font-size:13px;box-sizing:border-box;outline:none}
    .dse-input:focus{border-color:#7aa2f7}
    .dse-input::placeholder{color:#555}

    .dse-sel{padding:7px 10px;border:1px solid #444;border-radius:8px;background:#1a1a28;color:#eee;font-size:13px;outline:none}
    .dse-sel option{background:#1a1a28}

    /* session row */
    .dse-row{display:flex;align-items:center;gap:8px;padding:7px 8px;border-radius:8px;transition:background .1s}
    .dse-row:hover{background:#1e1e2e}
    .dse-row input[type=checkbox]{width:15px;height:15px;accent-color:#ef4444;cursor:pointer;flex-shrink:0}
    .dse-row .ttl{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px}
    .dse-row .dt{font-size:11px;color:#555;flex-shrink:0}
    .dse-row .btn-sm{background:none;border:none;color:#7aa2f7;cursor:pointer;font-size:11px;flex-shrink:0;padding:2px 6px;border-radius:4px;opacity:0;transition:opacity .15s}
    .dse-row:hover .btn-sm{opacity:1}
    .dse-row .btn-sm:hover{background:#1a2a4a}

    /* category dots */
    .dse-cats{display:flex;gap:3px;flex-shrink:0}
    .dse-catdot{width:10px;height:10px;border-radius:50%;cursor:pointer;transition:transform .1s}
    .dse-catdot:hover{transform:scale(1.3)}

    /* cat filter bar */
    .dse-catfilter{display:flex;gap:6px;margin-bottom:10px;flex-wrap:wrap;align-items:center}
    .dse-catfilter button{padding:4px 10px;border-radius:12px;border:1px solid #444;background:#222;color:#aaa;font-size:11px;cursor:pointer}
    .dse-catfilter button.active{border-color:#7aa2f7;color:#7aa2f7;background:#1a2a4a}

    /* category management */
    .dse-catmgmt{margin-bottom:12px;padding:10px;background:#1a1a28;border-radius:10px}
    .dse-catmgmt .row{display:flex;gap:6px;margin-bottom:6px;align-items:center}
    .dse-catmgmt .row input[type=color]{width:28px;height:28px;border:none;border-radius:6px;cursor:pointer;background:none}
    .dse-chip{display:inline-flex;align-items:center;gap:4px;padding:3px 10px;border-radius:12px;font-size:11px;cursor:pointer;margin:2px}
    .dse-chip:hover{filter:brightness(1.2)}
    .dse-chip .x{font-size:13px;opacity:.6}.dse-chip .x:hover{opacity:1}

    /* progress */
    .dse-prog{font-size:13px;color:#aaa;padding:8px 0}
    .dse-prog .bar{height:4px;background:#333;border-radius:2px;margin-top:6px;overflow:hidden}
    .dse-prog .bar-i{height:100%;background:#2563eb;border-radius:2px;transition:width .2s}

    /* modal */
    .dse-modal-bg{position:fixed;inset:0;z-index:1000002;background:rgba(0,0,0,.65);display:flex;align-items:center;justify-content:center}
    .dse-modal-box{background:#1a1a28;color:#eee;border-radius:14px;padding:0;min-width:380px;max-width:520px;box-shadow:0 8px 40px rgba(0,0,0,.6);font-family:system-ui;overflow:hidden}
    .dse-modal-box .mhd{padding:16px 20px;border-bottom:1px solid #2a2a3a;font-size:15px;font-weight:600}
    .dse-modal-box .mbd{padding:14px 20px;max-height:360px;overflow-y:auto}
    .dse-modal-box .mft{padding:12px 20px;border-top:1px solid #2a2a3a;display:flex;justify-content:flex-end;gap:8px}
    .dse-modal-box .mft button{padding:8px 20px;border-radius:8px;border:none;cursor:pointer;font-size:13px}
    .dse-modal-box .mft .cancel{background:#333;color:#eee}.dse-modal-box .mft .cancel:hover{background:#444}
    .dse-modal-box .mft .confirm{background:#2563eb;color:#fff;font-weight:600}.dse-modal-box .mft .confirm:hover{background:#3b82f6}
    .dse-msg-row{padding:8px 12px;border-radius:6px;cursor:pointer;display:flex;align-items:flex-start;gap:8px;font-size:13px}
    .dse-msg-row:hover{background:#222238}.dse-msg-row.sel{background:#1a2e50}
    .dse-msg-row .num{color:#7aa2f7;font-weight:600;min-width:30px;font-size:12px}
    .dse-msg-row .preview{color:#aaa;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

    /* rename preview */
    .dse-rename-preview{margin:10px 0;font-size:12px}
    .dse-rename-preview .old{color:#888;text-decoration:line-through}
    .dse-rename-preview .arrow{color:#555;margin:0 6px}
    .dse-rename-preview .new{color:#7aa2f7}

    /* prompt cards */
    .dse-pcard{background:#1a1a28;border:1px solid #333;border-radius:10px;padding:10px 12px;margin-bottom:8px;transition:border-color .15s}
    .dse-pcard.disabled{opacity:.5}
    .dse-pcard-hd{display:flex;align-items:center;gap:8px}
    .dse-pcard-hd .pname{flex:1;font-size:13px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .dse-pcard-hd .pname[contenteditable]{outline:1px solid #7aa2f7;border-radius:4px;padding:0 4px}
    .dse-pcard-hd .btn-pc{background:none;border:none;color:#888;cursor:pointer;font-size:12px;padding:2px 6px;border-radius:4px}
    .dse-pcard-hd .btn-pc:hover{color:#eee;background:#333}
    .dse-pcard-hd .btn-pc.dng:hover{color:#f87171;background:#3b1111}
    .dse-pcard-toggle{position:relative;width:32px;height:18px;flex-shrink:0}
    .dse-pcard-toggle input{opacity:0;width:0;height:0;position:absolute}
    .dse-pcard-toggle .slider{position:absolute;inset:0;background:#444;border-radius:9px;cursor:pointer;transition:background .2s}
    .dse-pcard-toggle .slider::before{content:'';position:absolute;width:14px;height:14px;left:2px;top:2px;background:#fff;border-radius:50%;transition:transform .2s}
    .dse-pcard-toggle input:checked+.slider{background:#2563eb}
    .dse-pcard-toggle input:checked+.slider::before{transform:translateX(14px)}
    .dse-pcard-body{display:none;margin-top:8px}
    .dse-pcard-body.open{display:block}
    .dse-pcard-body textarea{width:100%;padding:8px;border-radius:8px;border:1px solid #444;background:#16161e;color:#eee;font-size:12px;resize:vertical;min-height:60px;box-sizing:border-box;outline:none}
    .dse-pcard-body textarea:focus{border-color:#7aa2f7}
    .dse-pcard-body .pfoot{display:flex;justify-content:flex-end;gap:6px;margin-top:6px}


    /* 独立挂载的弹窗（绝不在输入框内部以防被遮挡） */
    .dse-global-dropdown {
      position: fixed;
      background: #2c2c2e;
      border: rgba(255,255,255,.06);
      border-radius: 8px;
      padding: 4px; /* 压缩选项整体面板上下间隔 */
      display: none;
      flex-direction: column;
      gap: 2px; /* 压缩选项之间的间隔 */
      min-width: 160px;
      max-width: 280px;
      box-shadow: 0 4px 20px rgba(0,0,0,.5);
      z-index: 2147483647;
      max-height: 300px;
      overflow-y: auto;
    }
    .dse-global-dropdown.open { display: flex; }
    .dse-dropdown-item {
      padding: 6px 8px; /* 压缩单个选项的高度 */
      border-radius: 6px;
      cursor: pointer;
      font-size: 13px;
      color: #eee;
      display: flex;
      align-items: center;
      gap: 8px;
      transition: background 0.15s;
    }
    .dse-dropdown-item:hover { background: #2a2a3a; }
    .dse-dropdown-item.active { color: #7aa2f7; background: #1a2a4a; }
  `;
  document.head.appendChild(style);

  // ═══════════════════════════════════════════════════════════════════
  //  FAB (draggable)
  // ═══════════════════════════════════════════════════════════════════
  const fab = document.createElement('button');
  fab.id = 'dse-fab';
  fab.innerHTML = '&#9881;';
  fab.title = 'DeepSeek 增强 (可拖动)';
  document.body.appendChild(fab);

  let fabDragged = false, fabSX, fabSY, fabOX, fabOY;
  const DRAG_TH = 5;

  const panel = document.createElement('div');
  panel.id = 'dse-panel';

  function posPanel() {
    const r = fab.getBoundingClientRect();
    let l = r.left;
    const pw = 460;
    if (l + pw > window.innerWidth - 10) l = window.innerWidth - pw - 10;
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
      if (!fabDragged) { panel.classList.toggle('open'); if (panel.classList.contains('open')) posPanel(); }
      else if (panel.classList.contains('open')) posPanel();
    };
    document.addEventListener('pointermove', mv);
    document.addEventListener('pointerup', up);
    e.preventDefault();
  });

  fab.style.left = '20px';
  fab.style.top = (innerHeight - 68) + 'px';

  // ═══════════════════════════════════════════════════════════════════
  //  Panel HTML
  // ═══════════════════════════════════════════════════════════════════
  panel.innerHTML = `
    <div class="hd"><h3>DeepSeek 增强</h3><button class="cls">&times;</button></div>
    <div id="dse-tabs">
      <button class="active" data-tab="batch">批量删除</button>
      <button data-tab="fork">Fork</button>
      <button data-tab="cats">分类</button>
      <button data-tab="search">搜索</button>
      <button data-tab="export">导出</button>
      <button data-tab="rename">重命名</button>
      <button data-tab="prompt">提示词</button>
    </div>
    <div class="dse-bd">

      <!-- batch delete -->
      <div id="sec-batch" class="dse-section active">
        <div class="dse-actions">
          <button id="batch-load">加载对话列表</button>
          <button id="batch-sel-all">全选</button>
          <button id="batch-desel">取消全选</button>
        </div>
        <div class="dse-actions">
          <button id="batch-del" class="dng">删除选中</button>
          <button id="batch-del-all" class="dng">清空全部</button>
        </div>
        <div id="batch-status" class="dse-prog" style="display:none"></div>
        <div id="batch-list"></div>
      </div>

      <!-- fork -->
      <div id="sec-fork" class="dse-section">
        <div style="margin-bottom:12px">
          <div style="color:#aaa;font-size:13px;margin-bottom:6px">当前对话</div>
          <div id="fork-info" style="font-size:13px;color:#888"></div>
          <div class="dse-actions" style="margin-top:8px">
            <button id="fork-entire">Fork 整个对话</button>
            <button id="fork-pick" class="pri">Fork (选择起点)</button>
          </div>
        </div>
        <hr style="border:none;border-top:1px solid #2a2a3a;margin:12px 0">
        <div style="color:#aaa;font-size:13px;margin-bottom:6px">从历史列表 Fork</div>
        <div class="dse-actions"><button id="fork-load">加载对话列表</button></div>
        <div id="fork-list"></div>
      </div>

      <!-- categories -->
      <div id="sec-cats" class="dse-section">
        <div class="dse-catmgmt">
          <div style="color:#aaa;font-size:12px;margin-bottom:8px">管理分类</div>
          <div class="row">
            <input type="text" id="cat-name" class="dse-input" placeholder="分类名称" style="flex:1">
            <input type="color" id="cat-color" value="#3b82f6" style="width:28px;height:28px;border:none;border-radius:6px;cursor:pointer;background:none">
            <button id="cat-add" class="pri" style="padding:6px 14px">添加</button>
          </div>
          <div id="cat-chips"></div>
          <div class="dse-actions" style="margin-top:8px">
            <button id="cat-export-data">导出分类数据</button>
            <button id="cat-import-data">导入分类数据</button>
          </div>
        </div>
        <div class="dse-actions">
          <button id="cat-load">加载对话列表</button>
        </div>
        <div class="dse-catfilter" id="cat-filter-bar"></div>
        <div id="cat-list"></div>
      </div>

      <!-- search -->
      <div id="sec-search" class="dse-section">
        <div class="dse-actions" style="margin-bottom:8px">
          <button id="search-load">加载对话列表</button>
        </div>
        <input type="text" id="search-input" class="dse-input" placeholder="搜索对话标题..." style="margin-bottom:10px">
        <div id="search-count" style="font-size:12px;color:#666;margin-bottom:8px"></div>
        <div id="search-list"></div>
      </div>

      <!-- export -->
      <div id="sec-export" class="dse-section">
        <div class="dse-actions">
          <button id="exp-load">加载对话列表</button>
          <button id="exp-sel-all">全选</button>
          <button id="exp-desel">取消全选</button>
        </div>
        <div class="dse-actions">
          <select id="exp-format" class="dse-sel">
            <option value="json">JSON</option>
            <option value="md">Markdown</option>
          </select>
          <button id="exp-go" class="pri">导出选中</button>
        </div>
        <div id="exp-status" class="dse-prog" style="display:none"></div>
        <div id="exp-list"></div>
      </div>

      <!-- rename -->
      <div id="sec-rename" class="dse-section">
        <div class="dse-actions">
          <button id="rnm-load">加载对话列表</button>
          <button id="rnm-sel-all">全选</button>
          <button id="rnm-desel">取消全选</button>
        </div>
        <div style="margin-bottom:10px">
          <select id="rnm-mode" class="dse-sel" style="margin-bottom:6px">
            <option value="direct">直接重命名</option>
            <option value="prefix">添加前缀</option>
            <option value="suffix">添加后缀</option>
            <option value="replace">查找替换</option>
            <option value="serial">序号命名</option>
          </select>
          <div id="rnm-params"></div>
        </div>
        <div class="dse-actions">
          <button id="rnm-preview">预览</button>
          <button id="rnm-go" class="pri">执行重命名</button>
        </div>
        <div id="rnm-status" class="dse-prog" style="display:none"></div>
        <div id="rnm-preview-area"></div>
        <div id="rnm-list"></div>
      </div>

      <!-- prompt injection -->
      <div id="sec-prompt" class="dse-section">
        <div style="color:#aaa;font-size:13px;margin-bottom:8px">自定义系统提示词（每次对话自动注入，可保存多条）</div>
        <div style="display:flex;gap:6px;margin-bottom:10px">
          <input type="text" id="prompt-name" class="dse-input" placeholder="提示词名称（如：翻译助手）" style="flex:1">
          <button id="prompt-add" class="pri">添加</button>
        </div>
        <div id="prompt-list"></div>
      </div>

    </div>
  `;
  document.body.appendChild(panel);
  panel.querySelector('.cls').onclick = () => panel.classList.remove('open');

  // ═══════════════════════════════════════════════════════════════════
  //  Shared state
  // ═══════════════════════════════════════════════════════════════════
  let allSessions = []; // cached, shared across tabs
  const selIds = new Set();
  let activeCatFilter = null;

  async function ensureSessions() {
    if (!allSessions.length) {
      allSessions = await fetchAllSessions();
    }
    return allSessions;
  }

  // ═══════════════════════════════════════════════════════════════════
  //  Tab switching
  // ═══════════════════════════════════════════════════════════════════
  panel.querySelectorAll('#dse-tabs button').forEach(btn => {
    btn.onclick = () => {
      panel.querySelectorAll('#dse-tabs button').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const tab = btn.dataset.tab;
      panel.querySelectorAll('.dse-section').forEach(s => s.classList.remove('active'));
      panel.querySelector(`#sec-${tab}`).classList.add('active');
      if (tab === 'fork') updateForkInfo();
      if (tab === 'cats') renderCatChips();
    };
  });

  // ═══════════════════════════════════════════════════════════════════
  //  Session list renderer (shared)
  // ═══════════════════════════════════════════════════════════════════
  function renderList(container, sessions, opts = {}) {
    const { showFork, showCats, onCheck, highlight } = opts;
    container.innerHTML = '';
    if (!sessions.length) { container.innerHTML = '<div style="color:#555;font-size:13px;padding:12px 0">暂无对话</div>'; return; }
    sessions.forEach(s => {
      const row = document.createElement('div');
      row.className = 'dse-row';

      if (onCheck) {
        const cb = document.createElement('input');
        cb.type = 'checkbox'; cb.checked = selIds.has(s.id);
        cb.onchange = () => { if (cb.checked) selIds.add(s.id); else selIds.delete(s.id); };
        row.appendChild(cb);
      }

      if (showCats) {
        const catsDiv = document.createElement('span');
        catsDiv.className = 'dse-cats';
        const sc = getSessionCats(s.id);
        sc.forEach(cid => {
          const cat = catData.categories.find(c => c.id === cid);
          if (!cat) return;
          const dot = document.createElement('span');
          dot.className = 'dse-catdot';
          dot.style.background = cat.color;
          dot.title = cat.name;
          catsDiv.appendChild(dot);
        });
        row.appendChild(catsDiv);
      }

      const ttl = document.createElement('span');
      ttl.className = 'ttl';
      if (highlight) {
        const re = new RegExp(`(${highlight.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
        ttl.innerHTML = esc(s.title || '(无标题)').replace(re, '<mark style="background:#2a3a1a;color:#a0ffa0;border-radius:2px;padding:0 2px">$1</mark>');
      } else {
        ttl.textContent = s.title || '(无标题)';
      }

      const dt = document.createElement('span');
      dt.className = 'dt';
      dt.textContent = fmtDate(s.updated_at);

      row.appendChild(ttl);
      row.appendChild(dt);

      if (showFork) {
        const fb = document.createElement('button');
        fb.className = 'btn-sm'; fb.textContent = 'Fork';
        fb.onclick = (e) => { e.stopPropagation(); forkEntire(s.id); };
        row.appendChild(fb);
      }

      // category tag button
      if (showCats) {
        const tb = document.createElement('button');
        tb.className = 'btn-sm'; tb.textContent = '标签';
        tb.style.color = '#aaa';
        tb.onclick = (e) => { e.stopPropagation(); showCatPicker(s.id); };
        row.appendChild(tb);
      }

      container.appendChild(row);
    });
  }

  // ═══════════════════════════════════════════════════════════════════
  //  Batch Delete
  // ═══════════════════════════════════════════════════════════════════
  const batchListEl = panel.querySelector('#batch-list');
  const batchStatusEl = panel.querySelector('#batch-status');
  function showBatchProg(t, p) { batchStatusEl.style.display = 'block'; batchStatusEl.innerHTML = `<div>${esc(t)}</div><div class="bar"><div class="bar-i" style="width:${p}%"></div></div>`; }
  function hideBatchProg() { batchStatusEl.style.display = 'none'; }

  panel.querySelector('#batch-load').onclick = async () => {
    try { batchListEl.innerHTML = '<div style="color:#888;padding:8px 0">加载中...</div>'; allSessions = await fetchAllSessions(); selIds.clear(); renderList(batchListEl, allSessions, { onCheck: true, showCats: true }); toast(`已加载 ${allSessions.length} 条对话`, 'success'); }
    catch (e) { toast(`加载失败: ${e.message}`, 'error'); batchListEl.innerHTML = ''; }
  };
  panel.querySelector('#batch-sel-all').onclick = () => { allSessions.forEach(s => selIds.add(s.id)); renderList(batchListEl, allSessions, { onCheck: true, showCats: true }); };
  panel.querySelector('#batch-desel').onclick = () => { selIds.clear(); renderList(batchListEl, allSessions, { onCheck: true, showCats: true }); };

  panel.querySelector('#batch-del').onclick = async () => {
    if (!selIds.size) { toast('请先选择', 'error'); return; }
    if (!confirm(`确定删除 ${selIds.size} 条对话？不可撤销。`)) return;
    const ids = [...selIds]; let ok = 0, fail = 0;
    for (let i = 0; i < ids.length; i++) {
      showBatchProg(`删除中 ${i + 1}/${ids.length}`, ((i + 1) / ids.length) * 100);
      try { await apiDelete(ids[i]); ok++; } catch { fail++; }
    }
    hideBatchProg(); toast(`完成: 成功 ${ok}, 失败 ${fail}`, ok ? 'success' : 'error');
    allSessions = await fetchAllSessions(); selIds.clear();
    renderList(batchListEl, allSessions, { onCheck: true, showCats: true });
  };

  panel.querySelector('#batch-del-all').onclick = async () => {
    if (!confirm('⚠️ 删除【所有】对话？不可撤销！')) return;
    if (!confirm('再次确认！')) return;
    try { showBatchProg('清空中...', 50); await apiDeleteAll(); hideBatchProg(); toast('已清空', 'success'); allSessions = []; selIds.clear(); renderList(batchListEl, [], {}); }
    catch (e) { hideBatchProg(); toast(`失败: ${e.message}`, 'error'); }
  };

  // ═══════════════════════════════════════════════════════════════════
  //  Fork
  // ═══════════════════════════════════════════════════════════════════
  const forkListEl = panel.querySelector('#fork-list');

  function updateForkInfo() {
    const sid = getSessionId();
    panel.querySelector('#fork-info').innerHTML = sid
      ? `<code style="color:#7aa2f7;font-size:12px">${sid}</code>`
      : '<span style="color:#888">未打开对话，请先打开一个对话</span>';
  }

  async function forkEntire(sessionId) {
    if (!confirm('Fork 此对话？将创建一份完整副本。')) return;
    try {
      toast('获取消息中...', 'info');
      const hist = await apiHistory(sessionId);
      const msgs = hist?.biz_data?.chat_messages || [];
      if (!msgs.length) { toast('对话为空', 'error'); return; }
      const mids = msgs.map(m => m.message_id);
      toast('创建分享...', 'info');
      const sd = await apiCreateShare(sessionId, mids);
      const shareId = sd?.biz_data?.share_id;
      if (!shareId) throw new Error('创建分享失败');
      toast('Fork 中...', 'info');
      const fd = await apiForkShare(shareId);
      const newId = fd?.biz_data?.chat_session_id;
      if (!newId) throw new Error('Fork 失败');
      toast('Fork 成功！', 'success');
      setTimeout(() => { location.href = `/a/chat/s/${newId}`; }, 800);
    } catch (e) { toast(`Fork 失败: ${e.message}`, 'error'); }
  }

  function showForkPicker(sessionId, messages) {
    const userMsgs = messages.filter(m => m.role === 'USER' && m.status !== 'in_progress');
    if (!userMsgs.length) { toast('没有用户消息', 'error'); return; }
    let sel = userMsgs.length - 1;
    const bg = document.createElement('div'); bg.className = 'dse-modal-bg';
    bg.innerHTML = `<div class="dse-modal-box"><div class="mhd">选择 Fork 起点</div><div class="mbd" id="fp-list"></div><div class="mft"><button class="cancel">取消</button><button class="confirm">确认 Fork</button></div></div>`;
    const listEl = bg.querySelector('#fp-list');
    userMsgs.forEach((m, i) => {
      const r = document.createElement('div'); r.className = `dse-msg-row ${i === sel ? 'sel' : ''}`;
      r.innerHTML = `<span class="num">#${i + 1}</span><span class="preview">${esc((m.content || '').substring(0, 120))}</span>`;
      r.onclick = () => { listEl.querySelectorAll('.dse-msg-row').forEach(e => e.classList.remove('sel')); r.classList.add('sel'); sel = i; };
      listEl.appendChild(r);
    });
    bg.querySelector('.cancel').onclick = () => bg.remove();
    bg.onclick = e => { if (e.target === bg) bg.remove(); };
    bg.querySelector('.confirm').onclick = async () => {
      bg.remove();
      const sm = userMsgs[sel];
      const mm = new Map(messages.map(m => [m.message_id, m]));
      const ids = []; let cur = sm;
      while (cur) { ids.unshift(cur.message_id); cur = cur.parent_id ? mm.get(cur.parent_id) : null; }
      const idx = messages.findIndex(m => m.message_id === sm.message_id);
      if (idx >= 0 && idx + 1 < messages.length) { const n = messages[idx + 1]; if (n.role === 'ASSISTANT' && n.parent_id === sm.message_id) ids.push(n.message_id); }
      try {
        toast('Fork 中...', 'info');
        const sd = await apiCreateShare(sessionId, ids);
        const shareId = sd?.biz_data?.share_id; if (!shareId) throw new Error('创建分享失败');
        const fd = await apiForkShare(shareId);
        const newId = fd?.biz_data?.chat_session_id; if (!newId) throw new Error('Fork 失败');
        toast('Fork 成功！', 'success'); setTimeout(() => { location.href = `/a/chat/s/${newId}`; }, 800);
      } catch (e) { toast(`失败: ${e.message}`, 'error'); }
    };
    document.body.appendChild(bg);
  }

  panel.querySelector('#fork-entire').onclick = () => { const s = getSessionId(); s ? forkEntire(s) : toast('请先打开一个对话', 'error'); };
  panel.querySelector('#fork-pick').onclick = async () => {
    const s = getSessionId();
    if (!s) { toast('请先打开一个对话', 'error'); return; }
    try { toast('加载消息...', 'info'); const h = await apiHistory(s); const m = h?.biz_data?.chat_messages || []; if (!m.length) { toast('对话为空', 'error'); return; } showForkPicker(s, m); }
    catch (e) { toast(`失败: ${e.message}`, 'error'); }
  };
  panel.querySelector('#fork-load').onclick = async () => {
    try { forkListEl.innerHTML = '<div style="color:#888;padding:8px 0">加载中...</div>'; allSessions = await fetchAllSessions(); renderList(forkListEl, allSessions, { showFork: true, showCats: true }); toast(`已加载 ${allSessions.length} 条`, 'success'); }
    catch (e) { toast(`失败: ${e.message}`, 'error'); forkListEl.innerHTML = ''; }
  };

  // ═══════════════════════════════════════════════════════════════════
  //  Categories
  // ═══════════════════════════════════════════════════════════════════
  const catListEl = panel.querySelector('#cat-list');
  const catChipsEl = panel.querySelector('#cat-chips');
  const catFilterBar = panel.querySelector('#cat-filter-bar');

  function renderCatChips() {
    catChipsEl.innerHTML = '';
    catData.categories.forEach(c => {
      const chip = document.createElement('span');
      chip.className = 'dse-chip';
      chip.style.background = c.color + '22';
      chip.style.color = c.color;
      chip.style.border = `1px solid ${c.color}44`;
      chip.innerHTML = `${esc(c.name)} <span class="x">&times;</span>`;
      chip.querySelector('.x').onclick = (e) => { e.stopPropagation(); if (confirm(`删除分类「${c.name}」？`)) { removeCategory(c.id); renderCatChips(); renderCatFilterBar(); } };
      catChipsEl.appendChild(chip);
    });
  }

  function renderCatFilterBar() {
    catFilterBar.innerHTML = '';
    const allBtn = document.createElement('button');
    allBtn.textContent = '全部';
    if (!activeCatFilter) allBtn.classList.add('active');
    allBtn.onclick = () => { activeCatFilter = null; renderCatFilterBar(); renderCatListFiltered(); };
    catFilterBar.appendChild(allBtn);
    catData.categories.forEach(c => {
      const btn = document.createElement('button');
      btn.textContent = c.name;
      btn.style.borderColor = c.color;
      if (activeCatFilter === c.id) { btn.classList.add('active'); btn.style.background = c.color + '33'; }
      btn.onclick = () => { activeCatFilter = activeCatFilter === c.id ? null : c.id; renderCatFilterBar(); renderCatListFiltered(); };
      catFilterBar.appendChild(btn);
    });
  }

  function renderCatListFiltered() {
    const filtered = filterByCat(allSessions, activeCatFilter);
    renderList(catListEl, filtered, { showCats: true });
  }

  function showCatPicker(sid) {
    const bg = document.createElement('div'); bg.className = 'dse-modal-bg';
    const box = document.createElement('div'); box.className = 'dse-modal-box';
    box.innerHTML = `<div class="mhd">为对话分配标签</div><div class="mbd" id="cp-list"></div><div class="mft"><button class="cancel">完成</button></div>`;
    bg.appendChild(box); document.body.appendChild(bg);

    const cpList = box.querySelector('#cp-list');
    const sc = getSessionCats(sid);
    catData.categories.forEach(c => {
      const r = document.createElement('div'); r.className = 'dse-msg-row';
      const has = sc.includes(c.id);
      r.innerHTML = `<span style="width:14px;height:14px;border-radius:50%;background:${c.color};flex-shrink:0"></span><span style="flex:1">${esc(c.name)}</span><span style="color:${has ? '#7aa2f7' : '#555'}">${has ? '已选' : ''}</span>`;
      r.onclick = () => { toggleCatSession(sid, c.id); showCatPicker(sid); bg.remove(); };
      cpList.appendChild(r);
    });

    box.querySelector('.cancel').onclick = () => bg.remove();
    bg.onclick = e => { if (e.target === bg) bg.remove(); };
  }

  panel.querySelector('#cat-add').onclick = () => {
    const name = panel.querySelector('#cat-name').value.trim();
    const color = panel.querySelector('#cat-color').value;
    if (!name) { toast('请输入分类名称', 'error'); return; }
    addCategory(name, color);
    panel.querySelector('#cat-name').value = '';
    renderCatChips(); renderCatFilterBar();
    toast(`已添加「${name}」`, 'success');
  };

  panel.querySelector('#cat-load').onclick = async () => {
    try { catListEl.innerHTML = '<div style="color:#888;padding:8px 0">加载中...</div>'; allSessions = await fetchAllSessions(); renderCatFilterBar(); renderCatListFiltered(); toast(`已加载 ${allSessions.length} 条`, 'success'); }
    catch (e) { toast(`失败: ${e.message}`, 'error'); }
  };

  // Import/Export category data
  panel.querySelector('#cat-export-data').onclick = () => {
    const json = JSON.stringify(catData, null, 2);
    download('dse-categories.json', json, 'application/json');
    toast('分类数据已导出', 'success');
  };
  panel.querySelector('#cat-import-data').onclick = () => {
    const inp = document.createElement('input'); inp.type = 'file'; inp.accept = '.json';
    inp.onchange = async () => {
      const file = inp.files[0]; if (!file) return;
      try {
        const text = await file.text();
        const data = JSON.parse(text);
        if (!data.categories || !data.sessionMap) throw new Error('格式错误');
        catData = data; saveCats(catData);
        renderCatChips(); renderCatFilterBar();
        toast('分类数据已导入', 'success');
      } catch (e) { toast(`导入失败: ${e.message}`, 'error'); }
    };
    inp.click();
  };

  // ═══════════════════════════════════════════════════════════════════
  //  Search
  // ═══════════════════════════════════════════════════════════════════
  const searchListEl = panel.querySelector('#search-list');
  const searchCountEl = panel.querySelector('#search-count');
  const searchInput = panel.querySelector('#search-input');

  panel.querySelector('#search-load').onclick = async () => {
    try { searchListEl.innerHTML = '<div style="color:#888;padding:8px 0">加载中...</div>'; allSessions = await fetchAllSessions(); doSearch(); toast(`已加载 ${allSessions.length} 条`, 'success'); }
    catch (e) { toast(`失败: ${e.message}`, 'error'); }
  };

  function doSearch() {
    const q = searchInput.value.trim().toLowerCase();
    if (!q) { searchCountEl.textContent = `共 ${allSessions.length} 条`; renderList(searchListEl, allSessions, { showCats: true }); return; }
    const matched = allSessions.filter(s => (s.title || '').toLowerCase().includes(q));
    searchCountEl.textContent = `找到 ${matched.length} 条`;
    renderList(searchListEl, matched, { showCats: true, highlight: searchInput.value.trim() });
  }

  searchInput.addEventListener('input', doSearch);

  // ═══════════════════════════════════════════════════════════════════
  //  Export
  // ═══════════════════════════════════════════════════════════════════
  const expListEl = panel.querySelector('#exp-list');
  const expStatusEl = panel.querySelector('#exp-status');
  function showExpProg(t, p) { expStatusEl.style.display = 'block'; expStatusEl.innerHTML = `<div>${esc(t)}</div><div class="bar"><div class="bar-i" style="width:${p}%"></div></div>`; }
  function hideExpProg() { expStatusEl.style.display = 'none'; }

  panel.querySelector('#exp-load').onclick = async () => {
    try { expListEl.innerHTML = '<div style="color:#888;padding:8px 0">加载中...</div>'; allSessions = await fetchAllSessions(); selIds.clear(); renderList(expListEl, allSessions, { onCheck: true, showCats: true }); toast(`已加载 ${allSessions.length} 条`, 'success'); }
    catch (e) { toast(`失败: ${e.message}`, 'error'); }
  };
  panel.querySelector('#exp-sel-all').onclick = () => { allSessions.forEach(s => selIds.add(s.id)); renderList(expListEl, allSessions, { onCheck: true, showCats: true }); };
  panel.querySelector('#exp-desel').onclick = () => { selIds.clear(); renderList(expListEl, allSessions, { onCheck: true, showCats: true }); };

  panel.querySelector('#exp-go').onclick = async () => {
    if (!selIds.size) { toast('请先选择', 'error'); return; }
    const fmt = panel.querySelector('#exp-format').value;
    const ids = [...selIds];
    const results = [];

    for (let i = 0; i < ids.length; i++) {
      showExpProg(`导出中 ${i + 1}/${ids.length}`, ((i + 1) / ids.length) * 100);
      const s = allSessions.find(x => x.id === ids[i]);
      try {
        const h = await apiHistory(ids[i]);
        const msgs = h?.biz_data?.chat_messages || [];
        results.push({ session: s, messages: msgs });
      } catch (e) {
        results.push({ session: s, messages: [], error: e.message });
      }
    }
    hideExpProg();

    const date = new Date().toISOString().slice(0, 10);
    if (fmt === 'json') {
      const json = JSON.stringify(results, null, 2);
      download(`dse-export-${date}.json`, json, 'application/json');
    } else {
      let md = '';
      results.forEach(r => {
        md += `# ${r.session?.title || '(无标题)'}\n\n`;
        md += `- 日期: ${fmtDate(r.session?.updated_at)}\n`;
        md += `- ID: ${r.session?.id}\n\n`;
        if (r.error) { md += `> 导出失败: ${r.error}\n\n`; return; }
        // Sort messages: follow tree structure, just list in order
        r.messages.forEach(m => {
          const role = m.role === 'USER' ? '**用户**' : '**助手**';
          md += `### ${role}\n\n${m.content || ''}\n\n---\n\n`;
        });
        md += '\n';
      });
      download(`dse-export-${date}.md`, md, 'text/markdown');
    }
    toast(`已导出 ${results.length} 个对话`, 'success');
  };

  // ═══════════════════════════════════════════════════════════════════
  //  Rename
  // ═══════════════════════════════════════════════════════════════════
  const rnmListEl = panel.querySelector('#rnm-list');
  const rnmStatusEl = panel.querySelector('#rnm-status');
  const rnmPreviewEl = panel.querySelector('#rnm-preview-area');
  const rnmMode = panel.querySelector('#rnm-mode');
  const rnmParams = panel.querySelector('#rnm-params');
  function showRnmProg(t, p) { rnmStatusEl.style.display = 'block'; rnmStatusEl.innerHTML = `<div>${esc(t)}</div><div class="bar"><div class="bar-i" style="width:${p}%"></div></div>`; }
  function hideRnmProg() { rnmStatusEl.style.display = 'none'; }

  function renderRenameParams() {
    const mode = rnmMode.value;
    if (mode === 'direct') rnmParams.innerHTML = '<div style="margin-top:4px;font-size:12px;color:#888">选中对话后点击下方「加载选中」，每条会显示一个输入框可直接编辑标题</div>';
    else if (mode === 'prefix') rnmParams.innerHTML = '<input type="text" id="rnm-prefix" class="dse-input" placeholder="输入前缀..." style="margin-top:4px">';
    else if (mode === 'suffix') rnmParams.innerHTML = '<input type="text" id="rnm-suffix" class="dse-input" placeholder="输入后缀..." style="margin-top:4px">';
    else if (mode === 'replace') rnmParams.innerHTML = '<div style="display:flex;gap:6px;margin-top:4px"><input type="text" id="rnm-find" class="dse-input" placeholder="查找"><input type="text" id="rnm-repl" class="dse-input" placeholder="替换为"></div>';
    else if (mode === 'serial') rnmParams.innerHTML = '<div style="display:flex;gap:6px;margin-top:4px;align-items:center"><input type="text" id="rnm-fmt" class="dse-input" placeholder="格式: {n} {title}" value="{n}. {title}" style="flex:1"><span style="font-size:11px;color:#666">可用: {n} {name}</span></div>';
  }
  rnmMode.onchange = () => { renderRenameParams(); rnmPreviewEl.innerHTML = ''; };
  renderRenameParams();

  function getNewTitle(s, idx, mode) {
    const t = s.title || '(无标题)';
    if (mode === 'prefix') { const p = rnmParams.querySelector('#rnm-prefix')?.value || ''; return p + t; }
    if (mode === 'suffix') { const p = rnmParams.querySelector('#rnm-suffix')?.value || ''; return t + p; }
    if (mode === 'replace') {
      const find = rnmParams.querySelector('#rnm-find')?.value || '';
      const repl = rnmParams.querySelector('#rnm-repl')?.value || '';
      if (!find) return t;
      return t.split(find).join(repl);
    }
    if (mode === 'serial') {
      const fmt = rnmParams.querySelector('#rnm-fmt')?.value || '{n}. {title}';
      const n = String(idx + 1).padStart(3, '0');
      return fmt.replace(/\{n\}/g, n).replace(/\{title\}/g, t).replace(/\{name\}/g, t);
    }
    return t;
  }

  function renderDirectRenameList(sessions) {
    rnmListEl.innerHTML = '';
    if (!sessions.length) { rnmListEl.innerHTML = '<div style="color:#555;font-size:13px;padding:12px 0">暂无对话</div>'; return; }
    sessions.forEach(s => {
      const row = document.createElement('div');
      row.className = 'dse-row';
      row.style.cursor = 'default';
      const dt = document.createElement('span');
      dt.className = 'dt';
      dt.textContent = fmtDate(s.updated_at);
      dt.style.marginRight = '6px';
      const inp = document.createElement('input');
      inp.type = 'text';
      inp.className = 'dse-input';
      inp.value = s.title || '';
      inp.style.flex = '1';
      inp.dataset.sid = s.id;
      row.appendChild(dt);
      row.appendChild(inp);
      rnmListEl.appendChild(row);
    });
  }

  panel.querySelector('#rnm-load').onclick = async () => {
    try {
      rnmListEl.innerHTML = '<div style="color:#888;padding:8px 0">加载中...</div>';
      allSessions = await fetchAllSessions();
      selIds.clear();
      if (rnmMode.value === 'direct') {
        renderDirectRenameList(allSessions);
      } else {
        renderList(rnmListEl, allSessions, { onCheck: true, showCats: true });
      }
      rnmPreviewEl.innerHTML = '';
      toast(`已加载 ${allSessions.length} 条`, 'success');
    }
    catch (e) { toast(`失败: ${e.message}`, 'error'); }
  };
  panel.querySelector('#rnm-sel-all').onclick = () => {
    if (rnmMode.value === 'direct') return;
    allSessions.forEach(s => selIds.add(s.id)); renderList(rnmListEl, allSessions, { onCheck: true, showCats: true });
  };
  panel.querySelector('#rnm-desel').onclick = () => {
    if (rnmMode.value === 'direct') return;
    selIds.clear(); renderList(rnmListEl, allSessions, { onCheck: true, showCats: true });
  };

  panel.querySelector('#rnm-preview').onclick = () => {
    if (rnmMode.value === 'direct') { toast('直接重命名模式无需预览，直接编辑输入框即可', 'info'); return; }
    if (!selIds.size) { toast('请先选择', 'error'); return; }
    const mode = rnmMode.value;
    const selected = allSessions.filter(s => selIds.has(s.id));
    let html = '';
    selected.forEach((s, i) => {
      const oldT = s.title || '(无标题)';
      const newT = getNewTitle(s, i, mode);
      html += `<div class="dse-rename-preview"><span class="old">${esc(oldT)}</span><span class="arrow">→</span><span class="new">${esc(newT)}</span></div>`;
    });
    rnmPreviewEl.innerHTML = html;
  };

  panel.querySelector('#rnm-go').onclick = async () => {
    const mode = rnmMode.value;

    // Direct rename mode: read from inline inputs
    if (mode === 'direct') {
      const inputs = rnmListEl.querySelectorAll('input[data-sid]');
      if (!inputs.length) { toast('请先点击「加载对话列表」', 'error'); return; }
      const renames = [];
      inputs.forEach(inp => {
        const sid = inp.dataset.sid;
        const newTitle = inp.value.trim();
        const old = allSessions.find(s => s.id === sid);
        if (old && newTitle && newTitle !== (old.title || '')) {
          renames.push({ id: sid, title: newTitle });
        }
      });
      if (!renames.length) { toast('没有需要修改的标题', 'info'); return; }
      if (!confirm(`确定重命名 ${renames.length} 条对话？`)) return;
      let ok = 0, fail = 0;
      for (let i = 0; i < renames.length; i++) {
        showRnmProg(`重命名中 ${i + 1}/${renames.length}`, ((i + 1) / renames.length) * 100);
        try { await apiRename(renames[i].id, renames[i].title); ok++; } catch { fail++; }
      }
      hideRnmProg();
      toast(`完成: 成功 ${ok}, 失败 ${fail}`, ok ? 'success' : 'error');
      allSessions = await fetchAllSessions();
      renderDirectRenameList(allSessions);
      return;
    }

    // Batch modes
    if (!selIds.size) { toast('请先选择', 'error'); return; }
    const selected = allSessions.filter(s => selIds.has(s.id));
    if (!confirm(`确定重命名 ${selected.length} 条对话？`)) return;

    let ok = 0, fail = 0;
    for (let i = 0; i < selected.length; i++) {
      showRnmProg(`重命名中 ${i + 1}/${selected.length}`, ((i + 1) / selected.length) * 100);
      const newT = getNewTitle(selected[i], i, mode);
      try { await apiRename(selected[i].id, newT); ok++; } catch { fail++; }
    }
    hideRnmProg();
    toast(`完成: 成功 ${ok}, 失败 ${fail}`, ok ? 'success' : 'error');
    allSessions = await fetchAllSessions(); selIds.clear();
    renderList(rnmListEl, allSessions, { onCheck: true, showCats: true });
    rnmPreviewEl.innerHTML = '';
  };

  // ═══════════════════════════════════════════════════════════════════
  //  Keyboard shortcut & init
  // ═══════════════════════════════════════════════════════════════════
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.shiftKey && e.key === 'D') {
      e.preventDefault();
      panel.classList.toggle('open');
      if (panel.classList.contains('open')) posPanel();
    }
  });

  // ═══════════════════════════════════════════════════════════════════
  //  Prompt Tab (multi-prompt)
  // ═══════════════════════════════════════════════════════════════════
  const promptListEl = panel.querySelector('#prompt-list');
  const promptNameInput = panel.querySelector('#prompt-name');

  function loadPrompts() {
    let arr;
    try { arr = JSON.parse(localStorage.getItem(LS_PROMPTS) || 'null'); } catch { arr = null; }
    if (!Array.isArray(arr)) {
      // migrate legacy single prompt
      const single = (localStorage.getItem(LS_PROMPT) || '').trim();
      arr = single ? [{ id: Date.now(), name: '默认提示词', content: single, enabled: true }] : [];
      localStorage.setItem(LS_PROMPTS, JSON.stringify(arr));
    }
    return arr;
  }

  function savePrompts(arr) {
    localStorage.setItem(LS_PROMPTS, JSON.stringify(arr));
  }

  function renderPromptCards() {
    const prompts = loadPrompts();
    if (!prompts.length) {
      promptListEl.innerHTML = '<div style="color:#555;font-size:13px;text-align:center;padding:20px 0">暂无提示词，输入名称后点击"添加"</div>';
      return;
    }
    promptListEl.innerHTML = prompts.map(p => `
      <div class="dse-pcard${p.enabled ? '' : ' disabled'}" data-id="${p.id}">
        <div class="dse-pcard-hd">
          <label class="dse-pcard-toggle"><input type="checkbox" class="p-toggle" ${p.enabled ? 'checked' : ''}><span class="slider"></span></label>
          <span class="pname">${esc(p.name)}</span>
          <button class="btn-pc p-edit" title="编辑">编辑</button>
          <button class="btn-pc p-rename" title="重命名">重命名</button>
          <button class="btn-pc dng p-del" title="删除">删除</button>
        </div>
        <div class="dse-pcard-body">
          <textarea class="p-content" rows="4">${esc(p.content)}</textarea>
          <div class="pfoot"><button class="pri p-save-content">保存内容</button></div>
        </div>
      </div>
    `).join('');

    // event delegation
    promptListEl.querySelectorAll('.dse-pcard').forEach(card => {
      const id = Number(card.dataset.id);

      card.querySelector('.p-toggle').onchange = (e) => {
        const pList = loadPrompts();
        const p = pList.find(x => x.id === id);
        if (p) { p.enabled = e.target.checked; savePrompts(pList); }
        card.classList.toggle('disabled', !e.target.checked);
        InlinePromptUI.update();
      };

      card.querySelector('.p-edit').onclick = () => {
        card.querySelector('.dse-pcard-body').classList.toggle('open');
      };

      card.querySelector('.p-rename').onclick = () => {
        const nameEl = card.querySelector('.pname');
        nameEl.contentEditable = 'true';
        nameEl.focus();
        const done = () => {
          nameEl.contentEditable = 'false';
          const newName = nameEl.textContent.trim() || '未命名';
          nameEl.textContent = newName;
          const pList = loadPrompts();
          const p = pList.find(x => x.id === id);
          if (p) { p.name = newName; savePrompts(pList); InlinePromptUI.update(); }
        };
        nameEl.onblur = done;
        nameEl.onkeydown = (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); nameEl.blur(); } };
      };

      card.querySelector('.p-del').onclick = () => {
        if (!confirm('确定删除该提示词？')) return;
        savePrompts(loadPrompts().filter(x => x.id !== id));
        renderPromptCards();
        InlinePromptUI.update();
        toast('提示词已删除', 'info');
      };

      card.querySelector('.p-save-content').onclick = () => {
        const val = card.querySelector('.p-content').value.trim();
        const pList = loadPrompts();
        const p = pList.find(x => x.id === id);
        if (p) { p.content = val; savePrompts(pList); }
        toast('内容已保存', 'success');
        card.querySelector('.dse-pcard-body').classList.remove('open');
      };
    });
  }

  panel.querySelector('#prompt-add').onclick = () => {
    const name = promptNameInput.value.trim();
    if (!name) { toast('请输入提示词名称', 'info'); return; }
    const prompts = loadPrompts();
    prompts.push({ id: Date.now(), name, content: '', enabled: true });
    savePrompts(prompts);
    promptNameInput.value = '';
    renderPromptCards();
    toast('提示词已添加', 'success');
    // auto-expand the new card for editing
    const lastCard = promptListEl.lastElementChild;
    if (lastCard) {
      lastCard.querySelector('.dse-pcard-body').classList.add('open');
      lastCard.querySelector('.p-content').focus();
    }
  };

  renderPromptCards();

  // ═══════════════════════════════════════════════════════════════════
  //  内嵌原生风格自定义提示词切换按钮
  // ═══════════════════════════════════════════════════════════════════
  const InlinePromptUI = {
    btnId: 'dse-inline-btn',
    dropdownId: 'dse-global-dropdown',

    // 初始化全局无遮挡下拉菜单
    init() {
      if (!document.getElementById(this.dropdownId)) {
        const dp = document.createElement('div');
        dp.id = this.dropdownId;
        dp.className = 'dse-global-dropdown';
        document.body.appendChild(dp);

        document.addEventListener('click', (e) => {
          const btn = document.getElementById(this.btnId);
          if (dp.classList.contains('open') && !dp.contains(e.target) && (!btn || !btn.contains(e.target))) {
            dp.classList.remove('open');
          }
        });
      }
    },

    // 寻找原生按钮并动态挂载/矫正位置
    mount() {
      const buttons = Array.from(document.querySelectorAll('.ds-toggle-button, [class*="ds-toggle-button"]'))
        .filter(b => b.id !== this.btnId && typeof b.textContent === 'string');
      const anchorBtn = buttons.find(b =>
        b.textContent.includes('智能搜索') ||
        b.textContent.includes('深度思考') ||
        b.textContent.includes('联网搜索') ||
        b.textContent.includes('DeepThink')
      );
      if (!anchorBtn) return;

      const container = anchorBtn.parentElement;
      let btn = document.getElementById(this.btnId);

      if (!btn) {
        btn = document.createElement('div');
        btn.id = this.btnId;
        // 动态获取当前页面原生按钮的类名，并过滤掉可能存在的“已选中”状态类
        const sourceBtn = container.querySelector('.ds-toggle-button:not([id="dse-inline-btn"])') || anchorBtn;
        btn.className = sourceBtn ? sourceBtn.className.replace(/\b(ds-toggle-button--selected|active)\b/g, '').trim() : 'ds-toggle-button ds-toggle-button--m';
        btn.setAttribute('role', 'button');
        btn.setAttribute('tabindex', '0');
        btn.innerHTML = `
          <div class="ds-icon ds-atom-button__icon" style="font-size: 14px; width: 14px; height: 14px; margin-right: 0px;">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16z"></path>
            </svg>
          </div>
          <span><span class="_6dbc175 dse-btn-text" style="color: inherit;">指令选择</span></span>
          <div class="ds-focus-ring"></div>
        `;

        btn.onclick = (e) => {
          e.preventDefault();
          e.stopPropagation();
          this.toggleDropdown(btn);
        };
      }

      // 动态位置矫正：保证我们的按钮永远在所有原生 Toggle 按钮的最后面
      const nativeToggles = Array.from(container.children).filter(c => c.classList.contains('ds-toggle-button') && c.id !== this.btnId);
      const lastNative = nativeToggles[nativeToggles.length - 1];

      if (lastNative && lastNative.nextSibling !== btn) {
        container.insertBefore(btn, lastNative.nextSibling);
      } else if (!lastNative && !container.contains(btn)) {
        container.appendChild(btn);
      }

      this.update();
    },

    // 仅用于更新按钮的文案与激活状态
    update() {
      const btn = document.getElementById(this.btnId);
      if (!btn) return;

      const textEl = btn.querySelector('.dse-btn-text');

      const prompts = loadPrompts();
      const enabled = prompts.filter(p => p.enabled);

      if (enabled.length === 0) {
        if (btn.classList.contains('ds-toggle-button--selected')) {
          btn.classList.remove('ds-toggle-button--selected');
        }
        if (textEl.textContent !== '指令选择') {
          textEl.textContent = '指令选择';
        }
      } else {
        if (!btn.classList.contains('ds-toggle-button--selected')) {
          btn.classList.add('ds-toggle-button--selected');
        }
        const newText = enabled.length === 1 ? enabled[0].name : `${enabled[0].name}等(${enabled.length})`;
        if (textEl.textContent !== newText) {
          textEl.textContent = newText;
        }
      }
    },

    // 展开/收起绝对定位的全局菜单
    toggleDropdown(btnEl) {
      const dp = document.getElementById(this.dropdownId);
      if (!dp) return;

      if (dp.classList.contains('open')) {
        dp.classList.remove('open');
        return;
      }

      this.renderDropdownContent(dp);
      const rect = btnEl.getBoundingClientRect();
      dp.style.left = `${rect.left}px`;
      dp.style.bottom = `${window.innerHeight - rect.top + 8}px`; // 动态定位在按钮正上方
      dp.classList.add('open');
    },

    // 渲染菜单内容
    renderDropdownContent(dp) {
      const prompts = loadPrompts();
      dp.innerHTML = '';
      if (!prompts.length) {
        dp.innerHTML = '<div style="padding:8px 12px;color:#888;font-size:13px;text-align:center;">暂无提示词</div>';
      } else {
        prompts.forEach(p => {
          const item = document.createElement('div');
          item.className = `dse-dropdown-item ${p.enabled ? 'active' : ''}`;
          item.innerHTML = `
            <div style="width:14px;height:14px;border-radius:4px;border:1px solid ${p.enabled ? '#7aa2f7' : '#555'};background:${p.enabled ? '#7aa2f7' : 'transparent'};display:flex;align-items:center;justify-content:center;flex-shrink:0;">
              ${p.enabled ? '<svg width="10" height="10" viewBox="0 0 12 12" fill="none"><path d="M2 6L5 9L10 3" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>' : ''}
            </div>
            <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(p.content)}">${esc(p.name)}</span>
          `;
          item.onclick = (e) => {
            e.stopPropagation();
            p.enabled = !p.enabled;
            savePrompts(prompts);
            renderPromptCards();
            this.renderDropdownContent(dp); // 重新渲染下拉列表
            this.update(); // 更新输入框按钮文字与颜色状态
          };
          dp.appendChild(item);
        });
      }

      const div = document.createElement('div');
      div.style.cssText = 'height:1px;background:#333;margin:4px 0;';
      dp.appendChild(div);

      const setBtn = document.createElement('div');
      setBtn.className = 'dse-dropdown-item';
      setBtn.innerHTML = `<span style="text-align:center;width:100%;color:#aaa;">⚙️ 管理提示词</span>`;
      setBtn.onclick = (e) => {
        e.stopPropagation();
        dp.classList.remove('open');
        document.getElementById('dse-panel').classList.add('open');
        posPanel();
      };
      dp.appendChild(setBtn);
    }
  };

  // 初始化与监听器
  InlinePromptUI.init();
  InlinePromptUI.mount();
  setTimeout(() => InlinePromptUI.mount(), 1000);

  // 添加防抖的 MutationObserver，监控并自动矫正节点位置
  let mountTimer = null;
  const domObserver = new MutationObserver(() => {
    if (mountTimer) clearTimeout(mountTimer);
    mountTimer = setTimeout(() => {
      InlinePromptUI.mount();
    }, 50);
  });
  domObserver.observe(document.body, { childList: true, subtree: true });

  console.log('[DSE] DeepSeek Chat Enhance v3.2.3 loaded');

  }); // end waitForDOM
})();
