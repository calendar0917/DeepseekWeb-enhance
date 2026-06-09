// ==UserScript==
// @name         DS Enhance
// @namespace    https://github.com/calendar0917/DeepseekWeb-enhance
// @version      4.2.1
// @description  批量删除、Fork 对话、会话分类、搜索、导出、批量重命名、多提示词注入
// @author       ds-enhance
// @homepageURL  https://github.com/calendar0917/DeepseekWeb-enhance
// @supportURL   https://github.com/calendar0917/DeepseekWeb-enhance/issues
// @downloadURL  https://raw.githubusercontent.com/calendar0917/DeepseekWeb-enhance/main/ds-enhance.user.js
// @updateURL    https://raw.githubusercontent.com/calendar0917/DeepseekWeb-enhance/main/ds-enhance.user.js
// @license      GPL-3.0
// @icon         https://fe-static.deepseek.com/chat/favicon.svg
// @match        https://chat.deepseek.com/*
// @grant        none
// @run-at       document-start
// ==/UserScript==
(() => {
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __commonJS = (cb, mod) => function __require() {
    return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
  };

  // src/core/dom-mount.js
  var require_dom_mount = __commonJS({
    "src/core/dom-mount.js"(exports, module) {
      function createMountManager(delay = 180, env = {}) {
        const mounts = /* @__PURE__ */ new Map();
        const rootEnv = {
          setTimeout: env.setTimeout || globalThis.setTimeout,
          clearTimeout: env.clearTimeout || globalThis.clearTimeout,
          MutationObserver: env.MutationObserver || globalThis.MutationObserver
        };
        let timer = null;
        let observer = null;
        const run = () => {
          timer = null;
          for (const mount of mounts.values()) mount();
        };
        return {
          register(id, mount) {
            mounts.set(id, mount);
            mount();
          },
          unregister(id) {
            mounts.delete(id);
          },
          schedule() {
            if (timer) rootEnv.clearTimeout(timer);
            timer = rootEnv.setTimeout(run, delay);
          },
          observe(root) {
            if (!root || !rootEnv.MutationObserver) return false;
            if (observer) observer.disconnect();
            observer = new rootEnv.MutationObserver(() => this.schedule());
            observer.observe(root, { childList: true, subtree: true });
            return true;
          },
          disconnect() {
            if (timer) rootEnv.clearTimeout(timer);
            timer = null;
            if (observer) observer.disconnect();
            observer = null;
          },
          size() {
            return mounts.size;
          }
        };
      }
      module.exports = { createMountManager };
    }
  });

  // src/core/storage.js
  var require_storage = __commonJS({
    "src/core/storage.js"(exports, module) {
      function createLocalStorage(storage) {
        return {
          getText(key, fallback = "") {
            const value = storage.getItem(key);
            return value == null ? fallback : value;
          },
          setText(key, value) {
            storage.setItem(key, String(value));
          },
          getJson(key, fallback) {
            try {
              const raw = storage.getItem(key);
              return raw == null ? fallback : JSON.parse(raw);
            } catch {
              return fallback;
            }
          },
          setJson(key, value) {
            storage.setItem(key, JSON.stringify(value));
          }
        };
      }
      function createGMStorage(getValue, setValue) {
        return {
          get(key, fallback) {
            return getValue(key, fallback);
          },
          set(key, value) {
            setValue(key, value);
          },
          getList(key) {
            return String(getValue(key, "") || "").split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
          }
        };
      }
      module.exports = { createGMStorage, createLocalStorage };
    }
  });

  // src/core/ui.js
  var require_ui = __commonJS({
    "src/core/ui.js"(exports, module) {
      function injectStyle(documentRef, cssText) {
        const style = documentRef.createElement("style");
        style.textContent = cssText;
        documentRef.head.appendChild(style);
        return style;
      }
      function createToast(documentRef, options = {}) {
        const colors = {
          info: "#2a2a3e",
          success: "#0d3320",
          error: "#3d0f0f",
          ...options.colors || {}
        };
        const duration = options.duration || 3500;
        return function toast(msg, type = "info") {
          const el = documentRef.createElement("div");
          el.style.cssText = `position:fixed;bottom:24px;right:24px;z-index:2000001;background:${colors[type] || colors.info};color:#eee;padding:12px 22px;border-radius:10px;font-size:14px;box-shadow:0 4px 20px rgba(0,0,0,.5);font-family:system-ui;transition:opacity .3s;`;
          el.textContent = msg;
          documentRef.body.appendChild(el);
          setTimeout(() => {
            el.style.opacity = "0";
            setTimeout(() => el.remove(), 300);
          }, duration);
          return el;
        };
      }
      function positionFloatingPanel(options) {
        const view = options.windowRef;
        const { fab, panel } = options;
        const width = options.width || 460;
        const gap = options.gap ?? 10;
        const margin = options.margin ?? 10;
        const rect = fab.getBoundingClientRect();
        let left = options.align === "right" ? rect.right - width : rect.left;
        if (left + width > view.innerWidth - margin) left = view.innerWidth - width - margin;
        if (left < margin) left = margin;
        panel.style.left = left + "px";
        if (typeof options.topMargin === "number") {
          const topMargin = options.topMargin;
          const spaceAbove = rect.top - gap - topMargin;
          const maxHeight = Math.min(view.innerHeight * (options.maxHeightRatio || 0.75), view.innerHeight - 2 * topMargin);
          if (spaceAbove >= (options.minSpaceAbove || 200)) {
            panel.style.bottom = view.innerHeight - rect.top + gap + "px";
            panel.style.top = "auto";
          } else {
            panel.style.top = topMargin + "px";
            panel.style.bottom = "auto";
          }
          panel.style.maxHeight = maxHeight + "px";
          return;
        }
        panel.style.bottom = view.innerHeight - rect.top + gap + "px";
        panel.style.top = "auto";
      }
      function createModal(documentRef, options = {}) {
        const backdrop = documentRef.createElement("div");
        backdrop.className = options.backdropClass || "dse-modal-bg";
        if (options.html) backdrop.innerHTML = options.html;
        const box = options.box || backdrop.querySelector?.(options.boxSelector || ".dse-modal-box") || null;
        const close = () => backdrop.remove();
        if (options.closeOnBackdrop !== false) {
          backdrop.onclick = (event) => {
            if (event.target === backdrop) close();
          };
        }
        documentRef.body.appendChild(backdrop);
        return { backdrop, box, close };
      }
      module.exports = { createModal, createToast, injectStyle, positionFloatingPanel };
    }
  });

  // src/adapters/deepseek.js
  var require_deepseek = __commonJS({
    "src/adapters/deepseek.js"(exports, module) {
      var selectors = {
        assistantMessages: '.ds-markdown--block, [class*="markdown"]',
        assistantMessageContainer: '[class*="message"]',
        inputBox: 'textarea, [contenteditable="true"][placeholder]',
        composerToggles: '.ds-toggle-button, [class*="ds-toggle-button"]',
        composerFallback: 'form, [class*="composer"], [class*="input"], [class*="chat-input"]',
        sidebarRoots: 'aside, nav, [class*="sidebar"], [class*="sider"], [class*="history"]',
        conversationLinks: 'a[href*="/s/"]',
        conversationRows: 'li, [class*="item"], [class*="session"], [class*="conversation"]',
        conversationTitleHosts: '[class*="title"], [class*="name"], span, div',
        messageActions: '[class*="action"], [class*="toolbar"], [class*="buttons"], [class*="footer"]',
        chatMessageLists: '[class*="chat-message-list"], [class*="message-list"], main',
        codeBlockCandidates: '.md-code-block, [class*="code-block"], pre',
        codeBlockContainers: '.md-code-block, [class*="code-block"]',
        codeBlockBanner: '.md-code-block-banner, [class*="code-block-banner"], [class*="code-header"]',
        codeBlockActions: '[class*="action"], [class*="copy"], [class*="toolbar"], .efa13877',
        codeContent: "pre, code",
        systemInstructionRoots: '.ds-markdown, .ds-markdown--block, [class*="markdown"], [data-message-author-role="user"]'
      };
      function splitSelectorList(value) {
        return String(value || "").split(",").map((s) => s.trim()).filter(Boolean);
      }
      function queryAny(root, selectorList) {
        if (!root?.querySelector) return null;
        for (const selector of splitSelectorList(selectorList)) {
          const el = root.querySelector(selector);
          if (el) return el;
        }
        return null;
      }
      function createDeepSeekAdapter(documentRef) {
        const doc = documentRef;
        return {
          id: "deepseek",
          name: "DeepSeek Chat",
          selectors,
          findComposerToolbar() {
            const buttons = Array.from(doc.querySelectorAll(selectors.composerToggles)).filter((b) => b.id !== "dse-inline-btn" && b.id !== "mcp-inline-btn" && typeof b.textContent === "string");
            const anchorBtn = buttons.find(
              (b) => b.textContent.includes("\u667A\u80FD\u641C\u7D22") || b.textContent.includes("\u6DF1\u5EA6\u601D\u8003") || b.textContent.includes("\u8054\u7F51\u641C\u7D22") || b.textContent.includes("DeepThink")
            );
            if (anchorBtn?.parentElement) return anchorBtn.parentElement;
            const fallback = queryAny(doc, selectors.composerFallback);
            return fallback?.querySelector?.(selectors.composerToggles)?.parentElement || fallback || null;
          },
          findSidebarHeader() {
            const list = this.findConversationList();
            if (!list) return queryAny(doc, selectors.sidebarRoots);
            return list.closest(selectors.sidebarRoots) || list.parentElement;
          },
          findConversationList() {
            const link = doc.querySelector(selectors.conversationLinks);
            if (!link) return null;
            return link.closest('[class*="list"], [class*="session"], [class*="conversation"], nav, aside') || link.parentElement;
          },
          findConversationLinks() {
            return Array.from(doc.querySelectorAll(selectors.conversationLinks));
          },
          findConversationRow(link) {
            return link?.closest?.(selectors.conversationRows) || link || null;
          },
          findConversationTitleHost(link) {
            return link?.querySelector?.(selectors.conversationTitleHosts) || link || null;
          },
          findMessageContainer(message) {
            return message?.closest?.(selectors.assistantMessageContainer) || message?.parentElement || message || null;
          },
          findMessageActions(message) {
            const container = this.findMessageContainer(message);
            if (!container?.querySelector) return null;
            const byClass = queryAny(container, selectors.messageActions);
            if (byClass) return byClass;
            const allEls = Array.from(container.querySelectorAll("*") || []);
            for (let i = allEls.length - 1; i >= 0; i--) {
              const el = allEls[i];
              if (el.querySelectorAll(":scope > button").length >= 1) return el;
            }
            return null;
          },
          findAssistantMessages() {
            return Array.from(doc.querySelectorAll(selectors.assistantMessages));
          },
          findAssistantMessageInContainer(container) {
            return queryAny(container, selectors.assistantMessages);
          },
          findMCPCodeBlockCandidates() {
            const candidates = /* @__PURE__ */ new Set();
            doc.querySelectorAll(selectors.codeBlockCandidates).forEach((el) => {
              candidates.add(el.closest?.(selectors.codeBlockContainers) || el);
            });
            return Array.from(candidates);
          },
          findCodeBanner(block) {
            return queryAny(block, selectors.codeBlockBanner);
          },
          findCodeContentElement(block) {
            if (block?.matches?.("pre")) return block;
            return queryAny(block, selectors.codeContent);
          },
          findCodeActionContainer(block) {
            const banner = this.findCodeBanner(block);
            if (banner) return queryAny(banner, selectors.codeBlockActions) || banner;
            const pre = this.findCodeContentElement(block);
            if (!pre?.parentNode) return null;
            const bar = doc.createElement("div");
            bar.style.cssText = "display:flex;justify-content:flex-end;gap:4px;margin:4px 0;";
            pre.parentNode.insertBefore(bar, pre);
            return bar;
          },
          findSystemInstructionRoots() {
            return Array.from(doc.querySelectorAll(selectors.systemInstructionRoots));
          },
          findChatContainer() {
            return queryAny(doc, selectors.chatMessageLists) || doc.body;
          }
        };
      }
      module.exports = { createDeepSeekAdapter, selectors, splitSelectorList };
    }
  });

  // src/features/export/format.js
  var require_format = __commonJS({
    "src/features/export/format.js"(exports, module) {
      function fmtDateOnly(ts) {
        if (!ts) return (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
        const d = new Date(ts * 1e3);
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      }
      function safeFilePart(text, fallback = "untitled") {
        const cleaned = String(text || "").replace(/[\\/:*?"<>|]+/g, "-").replace(/\s+/g, " ").trim().slice(0, 80);
        return cleaned || fallback;
      }
      function exportFileName(results, ext) {
        if (results.length === 1) {
          const session = results[0].session || {};
          return `${safeFilePart(session.title || session.id)}-${fmtDateOnly(session.updated_at)}.${ext}`;
        }
        const date = (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
        return `dse-export-${results.length}-sessions-${date}.${ext}`;
      }
      function messageRoleLabel(role) {
        if (role === "USER") return "\u7528\u6237";
        if (role === "ASSISTANT") return "\u52A9\u624B";
        return role || "\u6D88\u606F";
      }
      function renderMarkdownMessageTree(messages) {
        const nodes = messages.map((message, index) => ({ message, index, children: [] }));
        const byId = new Map(nodes.map((node) => [node.message.message_id, node]));
        const roots = [];
        nodes.forEach((node) => {
          const parent = node.message.parent_id ? byId.get(node.message.parent_id) : null;
          if (parent) parent.children.push(node);
          else roots.push(node);
        });
        const lines = [];
        const walk = (node, depth) => {
          const heading = "#".repeat(Math.min(6, depth + 3));
          const branch = depth ? ` \u5206\u652F\u5C42\u7EA7 ${depth}` : "";
          lines.push(`${heading} ${messageRoleLabel(node.message.role)} #${node.index + 1}${branch}`);
          lines.push("");
          lines.push(node.message.content || "");
          lines.push("");
          node.children.forEach((child) => walk(child, depth + 1));
        };
        roots.forEach((root) => walk(root, 0));
        return lines.join("\n");
      }
      module.exports = {
        exportFileName,
        fmtDateOnly,
        renderMarkdownMessageTree,
        safeFilePart
      };
    }
  });

  // src/entries/ds-enhance.entry.js
  (function() {
    "use strict";
    const { createMountManager } = require_dom_mount();
    const { createLocalStorage } = require_storage();
    const { createModal, createToast, injectStyle, positionFloatingPanel } = require_ui();
    const { createDeepSeekAdapter } = require_deepseek();
    const { exportFileName, renderMarkdownMessageTree } = require_format();
    const API = "https://chat.deepseek.com/api/v0";
    const LS_CATS = "dse_categories";
    const LS_PROMPT = "dse_custom_prompt";
    const LS_PROMPTS = "dse_prompts";
    const LS_CLIPBOARD_CACHE = "dse_clipboard_cache";
    const CUSTOM_PROMPT_MARKER = "[\u81EA\u5B9A\u4E49\u63D0\u793A\u8BCD]";
    const localStore = createLocalStorage(localStorage);
    function getEnabledPrompts() {
      try {
        const arr = localStore.getJson(LS_PROMPTS, []);
        if (Array.isArray(arr) && arr.length) {
          return arr.filter((p) => p.enabled).map((p) => renderPromptTemplate(p.content)).filter(Boolean);
        }
      } catch {
      }
      const single = localStore.getText(LS_PROMPT, "").trim();
      return single ? [single] : [];
    }
    function renderPromptTemplate(content) {
      const date = (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
      const selection = (window.getSelection?.().toString() || "").trim();
      const clipboard = localStore.getText(LS_CLIPBOARD_CACHE, "");
      return String(content || "").replace(/\{date\}/g, date).replace(/\{selection\}/g, selection).replace(/\{clipboard\}/g, clipboard);
    }
    document.addEventListener("copy", () => {
      const selection = (window.getSelection?.().toString() || "").trim();
      if (selection) localStore.setText(LS_CLIPBOARD_CACHE, selection);
    }, true);
    document.addEventListener("paste", (event) => {
      const text = event.clipboardData?.getData("text/plain") || "";
      if (text) localStore.setText(LS_CLIPBOARD_CACHE, text);
    }, true);
    let lastInjectedSignature = null;
    const originalPushState = history.pushState;
    history.pushState = function(...args) {
      const newUrl = args[2];
      if (newUrl) {
        const oldPath = location.pathname;
        const newPath = newUrl.toString().startsWith("http") ? new URL(newUrl).pathname : new URL(newUrl, location.origin).pathname;
        if (oldPath === "/" && newPath.startsWith("/s/")) {
        } else if (oldPath !== newPath) {
          lastInjectedSignature = null;
        }
      }
      return originalPushState.apply(this, args);
    };
    window.addEventListener("popstate", () => {
      lastInjectedSignature = null;
    });
    function modifyRequest(bodyStr) {
      const enabled = getEnabledPrompts();
      const currentSignature = enabled.join("\n\n");
      if (!currentSignature) {
        lastInjectedSignature = null;
        return bodyStr;
      }
      if (!bodyStr) return bodyStr;
      if (bodyStr.includes(CUSTOM_PROMPT_MARKER)) return bodyStr;
      if (lastInjectedSignature === currentSignature) {
        return bodyStr;
      }
      try {
        const parsed = JSON.parse(bodyStr);
        const tagged = `${CUSTOM_PROMPT_MARKER}
${currentSignature}`;
        let injected = false;
        if (parsed.prompt && typeof parsed.prompt === "string") {
          parsed.prompt = parsed.prompt + "\n\n" + tagged;
          injected = true;
        }
        if (parsed.messages?.length) {
          const lastIdx = parsed.messages.length - 1;
          parsed.messages[lastIdx].content = parsed.messages[lastIdx].content + "\n\n" + tagged;
          injected = true;
        }
        if (injected) {
          lastInjectedSignature = currentSignature;
          return JSON.stringify(parsed);
        }
      } catch {
      }
      return bodyStr;
    }
    const XHRProto = XMLHttpRequest.prototype;
    const _origOpen = XHRProto.open;
    const _origSend = XHRProto.send;
    const _xhrMeta = /* @__PURE__ */ new WeakMap();
    XHRProto.open = function(method, url, ...rest) {
      _xhrMeta.set(this, { url });
      return _origOpen.apply(this, [method, url, ...rest]);
    };
    XHRProto.send = function(body) {
      const meta = _xhrMeta.get(this);
      if (meta && meta.url.includes("completion") && body) {
        body = modifyRequest(body);
      }
      return _origSend.apply(this, [body]);
    };
    const _origFetch = window.fetch;
    window.fetch = async function(...args) {
      const url = typeof args[0] === "string" ? args[0] : args[0]?.url;
      if (url && url.includes("completion") && args[1]?.body) {
        args[1].body = modifyRequest(args[1].body);
      }
      return _origFetch.apply(this, args);
    };
    function waitForDOM() {
      return new Promise((resolve) => {
        if (document.body) resolve();
        else new MutationObserver(() => {
          if (document.body) resolve();
        }).observe(document.documentElement, { childList: true });
      });
    }
    waitForDOM().then(() => {
      function getToken() {
        try {
          const raw = localStorage.getItem("userToken");
          if (!raw) return null;
          const p = JSON.parse(raw);
          return typeof p === "object" ? p.value || p.token || p : p;
        } catch {
          return localStorage.getItem("userToken");
        }
      }
      async function api(path, method = "GET", body) {
        const token = getToken();
        if (!token) throw new Error("\u672A\u627E\u5230 userToken\uFF0C\u8BF7\u5148\u767B\u5F55 DeepSeek");
        const opts = { method, headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, "X-App-Version": "2025.04.25" } };
        if (body) opts.body = JSON.stringify(body);
        const res = await fetch(`${API}${path}`, opts);
        const json = await res.json();
        if (json.code !== 0) throw new Error(json.msg || `API error ${json.code}`);
        return json.data;
      }
      async function fetchSessionsPage(cursor) {
        const params = new URLSearchParams({ count: "50" });
        if (cursor && cursor.updated_at != null) {
          params.set("lte_cursor.pinned", String(cursor.pinned ? 1 : 0));
          params.set("lte_cursor.updated_at", String(cursor.updated_at));
        }
        return api(`/chat_session/fetch_page?${params.toString()}`);
      }
      function getSessionKey(session) {
        return session?.id || session?.chat_session_id || session?.chatSessionId || session?.session_id || "";
      }
      function getSessionUpdatedAt(session) {
        const candidates = [session?.updated_at, session?.updatedAt, session?.update_time, session?.updateTime];
        for (const value of candidates) {
          if (value == null || value === "") continue;
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
        return cursor ? `${cursor.pinned ? 1 : 0}:${cursor.updated_at}` : "__first__";
      }
      async function fetchAllSessions() {
        const sessions = [];
        const seenIds = /* @__PURE__ */ new Set();
        const seenCursors = /* @__PURE__ */ new Set();
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
      const apiDelete = (id) => api("/chat_session/delete", "POST", { chat_session_id: id });
      const apiDeleteAll = () => api("/chat_session/delete_all", "POST");
      const apiRename = (id, title) => api("/chat_session/update_title", "POST", { chat_session_id: id, title });
      const apiHistory = (id) => api(`/chat/history_messages?chat_session_id=${id}`);
      const apiCreateShare = (sid, mids) => api("/share/create", "POST", { chat_session_id: sid, message_ids: mids });
      const apiForkShare = (shareId) => api("/share/fork", "POST", { share_id: shareId });
      function loadCats() {
        return localStore.getJson(LS_CATS, { categories: [], sessionMap: {} }) || { categories: [], sessionMap: {} };
      }
      function saveCats(data) {
        localStore.setJson(LS_CATS, data);
      }
      let catData = loadCats();
      function addCategory(name, color) {
        catData.categories.push({ id: "cat_" + Date.now(), name, color });
        saveCats(catData);
      }
      function removeCategory(catId) {
        catData.categories = catData.categories.filter((c) => c.id !== catId);
        for (const sid in catData.sessionMap) {
          catData.sessionMap[sid] = catData.sessionMap[sid].filter((c) => c !== catId);
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
      function getSessionCats(sid) {
        return catData.sessionMap[sid] || [];
      }
      function filterByCat(sessions, catId) {
        if (!catId) return sessions;
        return sessions.filter((s) => (catData.sessionMap[s.id] || []).includes(catId));
      }
      function esc(t) {
        const d = document.createElement("div");
        d.textContent = t;
        return d.innerHTML;
      }
      function getSessionId() {
        const m = location.pathname.match(/\/s\/([a-f0-9-]+)/);
        return m ? m[1] : null;
      }
      function fmtDate(ts) {
        if (!ts) return "";
        const d = new Date(ts * 1e3);
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
      }
      function download(name, content, mime) {
        const blob = new Blob([content], { type: mime });
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = name;
        a.click();
        URL.revokeObjectURL(a.href);
      }
      const toast = createToast(document);
      const DeepSeekAdapter = createDeepSeekAdapter(document);
      injectStyle(document, `
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


    /* \u72EC\u7ACB\u6302\u8F7D\u7684\u5F39\u7A97\uFF08\u7EDD\u4E0D\u5728\u8F93\u5165\u6846\u5185\u90E8\u4EE5\u9632\u88AB\u906E\u6321\uFF09 */
    .dse-global-dropdown {
      position: fixed;
      background: #2c2c2e;
      border: rgba(255,255,255,.06);
      border-radius: 8px;
      padding: 4px; /* \u538B\u7F29\u9009\u9879\u6574\u4F53\u9762\u677F\u4E0A\u4E0B\u95F4\u9694 */
      display: none;
      flex-direction: column;
      gap: 2px; /* \u538B\u7F29\u9009\u9879\u4E4B\u95F4\u7684\u95F4\u9694 */
      min-width: 160px;
      max-width: 280px;
      box-shadow: 0 4px 20px rgba(0,0,0,.5);
      z-index: 2147483647;
      max-height: 300px;
      overflow-y: auto;
    }
    .dse-global-dropdown.open { display: flex; }
    .dse-dropdown-item {
      padding: 6px 8px; /* \u538B\u7F29\u5355\u4E2A\u9009\u9879\u7684\u9AD8\u5EA6 */
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
    #dse-inline-btn,.dse-native-sidebar-btn,.dse-msg-export-btn{display:inline-flex;align-items:center;justify-content:center;gap:4px;padding:5px 10px;border:1px solid rgba(122,162,247,.32);border-radius:999px;background:rgba(122,162,247,.10);color:#cdd6f4;font-size:12px;line-height:1.25;cursor:pointer;font-family:system-ui;white-space:nowrap;box-sizing:border-box}
    #dse-inline-btn:hover,.dse-native-sidebar-btn:hover,.dse-msg-export-btn:hover{background:rgba(122,162,247,.18);border-color:rgba(122,162,247,.55);color:#fff}
    #dse-inline-btn.active{background:rgba(37,99,235,.22);border-color:rgba(122,162,247,.7);color:#fff}
    .dse-native-sidebar-btn{margin:4px 6px}
    .dse-msg-export-btn{height:28px;padding:4px 8px;color:#999;background:transparent;border-color:transparent}
    #dse-quickbar{position:fixed;left:76px;bottom:26px;z-index:999999;display:flex;align-items:center;gap:6px;padding:6px;border:1px solid rgba(122,162,247,.28);border-radius:999px;background:rgba(22,22,30,.92);box-shadow:0 6px 24px rgba(0,0,0,.35);backdrop-filter:blur(8px);font-family:system-ui}
    #dse-quickbar button{height:28px;padding:0 10px;border:1px solid rgba(122,162,247,.25);border-radius:999px;background:rgba(122,162,247,.10);color:#dbe5ff;font-size:12px;line-height:1;cursor:pointer;white-space:nowrap}
    #dse-quickbar button:hover{background:rgba(122,162,247,.20);border-color:rgba(122,162,247,.55);color:#fff}
    .dse-cat-dots{display:inline-flex;align-items:center;gap:3px;margin-right:6px;vertical-align:middle;flex:0 0 auto}
    .dse-cat-dot{width:7px;height:7px;border-radius:50%;display:inline-block;border:1px solid rgba(255,255,255,.35)}
  `);
      const fab = document.createElement("button");
      fab.id = "dse-fab";
      fab.innerHTML = "&#9881;";
      fab.title = "DeepSeek \u589E\u5F3A (\u53EF\u62D6\u52A8)";
      document.body.appendChild(fab);
      let fabDragged = false, fabSX, fabSY, fabOX, fabOY;
      const DRAG_TH = 5;
      const panel = document.createElement("div");
      panel.id = "dse-panel";
      function posPanel() {
        positionFloatingPanel({ windowRef: window, fab, panel, width: 460, gap: 10, margin: 10 });
      }
      fab.addEventListener("pointerdown", (e) => {
        if (e.button) return;
        fabDragged = false;
        fabSX = e.clientX;
        fabSY = e.clientY;
        const r = fab.getBoundingClientRect();
        fabOX = e.clientX - r.left;
        fabOY = e.clientY - r.top;
        const mv = (e2) => {
          if (!fabDragged && Math.abs(e2.clientX - fabSX) + Math.abs(e2.clientY - fabSY) < DRAG_TH) return;
          fabDragged = true;
          fab.style.left = Math.max(0, Math.min(innerWidth - 48, e2.clientX - fabOX)) + "px";
          fab.style.top = Math.max(0, Math.min(innerHeight - 48, e2.clientY - fabOY)) + "px";
          fab.style.bottom = "auto";
        };
        const up = () => {
          document.removeEventListener("pointermove", mv);
          document.removeEventListener("pointerup", up);
          if (!fabDragged) {
            panel.classList.toggle("open");
            if (panel.classList.contains("open")) posPanel();
          } else if (panel.classList.contains("open")) posPanel();
        };
        document.addEventListener("pointermove", mv);
        document.addEventListener("pointerup", up);
        e.preventDefault();
      });
      fab.style.left = "20px";
      fab.style.top = innerHeight - 68 + "px";
      panel.innerHTML = `
    <div class="hd"><h3>DeepSeek \u589E\u5F3A</h3><button class="cls">&times;</button></div>
    <div id="dse-tabs">
      <button class="active" data-tab="batch">\u6279\u91CF\u5220\u9664</button>
      <button data-tab="fork">Fork</button>
      <button data-tab="cats">\u5206\u7C7B</button>
      <button data-tab="search">\u641C\u7D22</button>
      <button data-tab="export">\u5BFC\u51FA</button>
      <button data-tab="rename">\u91CD\u547D\u540D</button>
      <button data-tab="prompt">\u63D0\u793A\u8BCD</button>
    </div>
    <div class="dse-bd">

      <!-- batch delete -->
      <div id="sec-batch" class="dse-section active">
        <div class="dse-actions">
          <button id="batch-load">\u52A0\u8F7D\u5BF9\u8BDD\u5217\u8868</button>
          <button id="batch-sel-all">\u5168\u9009</button>
          <button id="batch-desel">\u53D6\u6D88\u5168\u9009</button>
        </div>
        <div class="dse-actions">
          <button id="batch-del" class="dng">\u5220\u9664\u9009\u4E2D</button>
          <button id="batch-del-all" class="dng">\u6E05\u7A7A\u5168\u90E8</button>
        </div>
        <div id="batch-status" class="dse-prog" style="display:none"></div>
        <div id="batch-list"></div>
      </div>

      <!-- fork -->
      <div id="sec-fork" class="dse-section">
        <div style="margin-bottom:12px">
          <div style="color:#aaa;font-size:13px;margin-bottom:6px">\u5F53\u524D\u5BF9\u8BDD</div>
          <div id="fork-info" style="font-size:13px;color:#888"></div>
          <div class="dse-actions" style="margin-top:8px">
            <button id="fork-entire">Fork \u6574\u4E2A\u5BF9\u8BDD</button>
            <button id="fork-pick" class="pri">Fork (\u9009\u62E9\u8D77\u70B9)</button>
          </div>
        </div>
        <hr style="border:none;border-top:1px solid #2a2a3a;margin:12px 0">
        <div style="color:#aaa;font-size:13px;margin-bottom:6px">\u4ECE\u5386\u53F2\u5217\u8868 Fork</div>
        <div class="dse-actions"><button id="fork-load">\u52A0\u8F7D\u5BF9\u8BDD\u5217\u8868</button></div>
        <div id="fork-list"></div>
      </div>

      <!-- categories -->
      <div id="sec-cats" class="dse-section">
        <div class="dse-catmgmt">
          <div style="color:#aaa;font-size:12px;margin-bottom:8px">\u7BA1\u7406\u5206\u7C7B</div>
          <div class="row">
            <input type="text" id="cat-name" class="dse-input" placeholder="\u5206\u7C7B\u540D\u79F0" style="flex:1">
            <input type="color" id="cat-color" value="#3b82f6" style="width:28px;height:28px;border:none;border-radius:6px;cursor:pointer;background:none">
            <button id="cat-add" class="pri" style="padding:6px 14px">\u6DFB\u52A0</button>
          </div>
          <div id="cat-chips"></div>
          <div class="dse-actions" style="margin-top:8px">
            <button id="cat-export-data">\u5BFC\u51FA\u5206\u7C7B\u6570\u636E</button>
            <button id="cat-import-data">\u5BFC\u5165\u5206\u7C7B\u6570\u636E</button>
          </div>
        </div>
        <div class="dse-actions">
          <button id="cat-load">\u52A0\u8F7D\u5BF9\u8BDD\u5217\u8868</button>
          <button id="cat-sel-all">\u5168\u9009\u5F53\u524D\u5217\u8868</button>
          <button id="cat-desel">\u53D6\u6D88\u5168\u9009</button>
        </div>
        <div class="dse-actions">
          <select id="cat-bulk-cat" class="dse-sel" style="min-width:160px">
            <option value="">\u9009\u62E9\u5206\u7C7B...</option>
          </select>
          <button id="cat-bulk-add" class="pri">\u6279\u91CF\u6DFB\u52A0\u5206\u7C7B</button>
          <button id="cat-bulk-remove">\u6279\u91CF\u79FB\u9664\u5206\u7C7B</button>
        </div>
        <div class="dse-catfilter" id="cat-filter-bar"></div>
        <div id="cat-list"></div>
      </div>

      <!-- search -->
      <div id="sec-search" class="dse-section">
        <div class="dse-actions" style="margin-bottom:8px">
          <button id="search-load">\u52A0\u8F7D\u5BF9\u8BDD\u5217\u8868</button>
        </div>
        <input type="text" id="search-input" class="dse-input" placeholder="\u641C\u7D22\u5BF9\u8BDD\u6807\u9898..." style="margin-bottom:8px">
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:8px">
          <input type="date" id="search-date-from" class="dse-input" title="\u5F00\u59CB\u65E5\u671F">
          <input type="date" id="search-date-to" class="dse-input" title="\u7ED3\u675F\u65E5\u671F">
        </div>
        <select id="search-cat" class="dse-sel" style="width:100%;margin-bottom:10px">
          <option value="">\u5168\u90E8\u5206\u7C7B</option>
        </select>
        <div id="search-count" style="font-size:12px;color:#666;margin-bottom:8px"></div>
        <div id="search-list"></div>
      </div>

      <!-- export -->
      <div id="sec-export" class="dse-section">
        <div class="dse-actions">
          <button id="exp-load">\u52A0\u8F7D\u5BF9\u8BDD\u5217\u8868</button>
          <button id="exp-sel-all">\u5168\u9009</button>
          <button id="exp-desel">\u53D6\u6D88\u5168\u9009</button>
        </div>
        <div class="dse-actions">
          <select id="exp-format" class="dse-sel">
            <option value="json">JSON</option>
            <option value="md">Markdown</option>
          </select>
          <button id="exp-go" class="pri">\u5BFC\u51FA\u9009\u4E2D</button>
          <button id="exp-fragment">\u5BFC\u51FA\u9009\u4E2D\u6587\u672C\u7247\u6BB5</button>
        </div>
        <div id="exp-status" class="dse-prog" style="display:none"></div>
        <div id="exp-list"></div>
      </div>

      <!-- rename -->
      <div id="sec-rename" class="dse-section">
        <div class="dse-actions">
          <button id="rnm-load">\u52A0\u8F7D\u5BF9\u8BDD\u5217\u8868</button>
          <button id="rnm-sel-all">\u5168\u9009</button>
          <button id="rnm-desel">\u53D6\u6D88\u5168\u9009</button>
        </div>
        <div style="margin-bottom:10px">
          <select id="rnm-mode" class="dse-sel" style="margin-bottom:6px">
            <option value="direct">\u76F4\u63A5\u91CD\u547D\u540D</option>
            <option value="prefix">\u6DFB\u52A0\u524D\u7F00</option>
            <option value="suffix">\u6DFB\u52A0\u540E\u7F00</option>
            <option value="replace">\u67E5\u627E\u66FF\u6362</option>
            <option value="serial">\u5E8F\u53F7\u547D\u540D</option>
          </select>
          <div id="rnm-params"></div>
        </div>
        <div class="dse-actions">
          <button id="rnm-preview">\u9884\u89C8</button>
          <button id="rnm-go" class="pri">\u6267\u884C\u91CD\u547D\u540D</button>
        </div>
        <div id="rnm-status" class="dse-prog" style="display:none"></div>
        <div id="rnm-preview-area"></div>
        <div id="rnm-list"></div>
      </div>

      <!-- prompt injection -->
      <div id="sec-prompt" class="dse-section">
        <div style="color:#aaa;font-size:13px;margin-bottom:8px">\u81EA\u5B9A\u4E49\u7CFB\u7EDF\u63D0\u793A\u8BCD\uFF08\u6BCF\u6B21\u5BF9\u8BDD\u81EA\u52A8\u6CE8\u5165\uFF0C\u53EF\u4FDD\u5B58\u591A\u6761\uFF09</div>
        <div style="display:flex;gap:6px;margin-bottom:10px">
          <input type="text" id="prompt-name" class="dse-input" placeholder="\u63D0\u793A\u8BCD\u540D\u79F0\uFF08\u5982\uFF1A\u7FFB\u8BD1\u52A9\u624B\uFF09" style="flex:1">
          <input type="text" id="prompt-group" class="dse-input" placeholder="\u5206\u7EC4" style="width:110px">
          <button id="prompt-add" class="pri">\u6DFB\u52A0</button>
        </div>
        <div style="font-size:11px;color:#666;margin-bottom:8px">\u53D8\u91CF\uFF1A{date}\u3001{selection}\u3001{clipboard}\u3002\u542F\u7528\u63D0\u793A\u8BCD\u6309\u5217\u8868\u987A\u5E8F\u6CE8\u5165\u3002</div>
        <div id="prompt-list"></div>
      </div>

    </div>
  `;
      document.body.appendChild(panel);
      panel.querySelector(".cls").onclick = () => panel.classList.remove("open");
      let allSessions = [];
      const selIds = /* @__PURE__ */ new Set();
      let activeCatFilter = null;
      async function ensureSessions() {
        if (!allSessions.length) {
          allSessions = await fetchAllSessions();
        }
        return allSessions;
      }
      panel.querySelectorAll("#dse-tabs button").forEach((btn) => {
        btn.onclick = () => {
          panel.querySelectorAll("#dse-tabs button").forEach((b) => b.classList.remove("active"));
          btn.classList.add("active");
          const tab = btn.dataset.tab;
          panel.querySelectorAll(".dse-section").forEach((s) => s.classList.remove("active"));
          panel.querySelector(`#sec-${tab}`).classList.add("active");
          if (tab === "fork") updateForkInfo();
          if (tab === "cats") renderCatChips();
        };
      });
      function openPanelTab(tab) {
        const tabBtn = panel.querySelector(`#dse-tabs button[data-tab="${tab}"]`);
        if (tabBtn) tabBtn.click();
        panel.classList.add("open");
        posPanel();
      }
      function renderList(container, sessions, opts = {}) {
        const { showFork, showCats, onCheck, highlight, onOpen } = opts;
        container.innerHTML = "";
        if (!sessions.length) {
          container.innerHTML = '<div style="color:#555;font-size:13px;padding:12px 0">\u6682\u65E0\u5BF9\u8BDD</div>';
          return;
        }
        sessions.forEach((s) => {
          const row = document.createElement("div");
          row.className = "dse-row";
          if (onOpen) {
            row.style.cursor = "pointer";
            row.onclick = () => onOpen(s);
          }
          if (onCheck) {
            const cb = document.createElement("input");
            cb.type = "checkbox";
            cb.checked = selIds.has(s.id);
            cb.onchange = () => {
              if (cb.checked) selIds.add(s.id);
              else selIds.delete(s.id);
            };
            row.appendChild(cb);
          }
          if (showCats) {
            const catsDiv = document.createElement("span");
            catsDiv.className = "dse-cats";
            const sc = getSessionCats(s.id);
            sc.forEach((cid) => {
              const cat = catData.categories.find((c) => c.id === cid);
              if (!cat) return;
              const dot = document.createElement("span");
              dot.className = "dse-catdot";
              dot.style.background = cat.color;
              dot.title = cat.name;
              catsDiv.appendChild(dot);
            });
            row.appendChild(catsDiv);
          }
          const ttl = document.createElement("span");
          ttl.className = "ttl";
          if (highlight) {
            const re = new RegExp(`(${highlight.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "gi");
            ttl.innerHTML = esc(s.title || "(\u65E0\u6807\u9898)").replace(re, '<mark style="background:#2a3a1a;color:#a0ffa0;border-radius:2px;padding:0 2px">$1</mark>');
          } else {
            ttl.textContent = s.title || "(\u65E0\u6807\u9898)";
          }
          const dt = document.createElement("span");
          dt.className = "dt";
          dt.textContent = fmtDate(s.updated_at);
          row.appendChild(ttl);
          row.appendChild(dt);
          if (showFork) {
            const fb = document.createElement("button");
            fb.className = "btn-sm";
            fb.textContent = "Fork";
            fb.onclick = (e) => {
              e.stopPropagation();
              forkEntire(s.id);
            };
            row.appendChild(fb);
          }
          if (showCats) {
            const tb = document.createElement("button");
            tb.className = "btn-sm";
            tb.textContent = "\u6807\u7B7E";
            tb.style.color = "#aaa";
            tb.onclick = (e) => {
              e.stopPropagation();
              showCatPicker(s.id);
            };
            row.appendChild(tb);
          }
          container.appendChild(row);
        });
      }
      const batchListEl = panel.querySelector("#batch-list");
      const batchStatusEl = panel.querySelector("#batch-status");
      function showBatchProg(t, p) {
        batchStatusEl.style.display = "block";
        batchStatusEl.innerHTML = `<div>${esc(t)}</div><div class="bar"><div class="bar-i" style="width:${p}%"></div></div>`;
      }
      function hideBatchProg() {
        batchStatusEl.style.display = "none";
      }
      function renderBatchFailures(statusEl, failures, retryLabel, retryFn) {
        if (!failures.length) {
          statusEl.style.display = "none";
          return;
        }
        statusEl.style.display = "block";
        statusEl.innerHTML = `
      <div style="color:#f87171;margin-bottom:6px">\u5931\u8D25 ${failures.length} \u9879</div>
      <div style="max-height:160px;overflow:auto;margin-bottom:8px">
        ${failures.map((f) => `<div style="padding:4px 0;border-bottom:1px solid #2a2a3a"><div style="color:#ddd">${esc(f.title || f.id)}</div><div style="color:#888;font-size:12px">${esc(f.error || "\u672A\u77E5\u9519\u8BEF")}</div></div>`).join("")}
      </div>
      <button class="dse-retry-failures" style="padding:6px 12px;border-radius:8px;border:1px solid #7f1d1d;background:#3d0f0f;color:#eee;cursor:pointer">${esc(retryLabel)}</button>
    `;
        statusEl.querySelector(".dse-retry-failures").onclick = retryFn;
      }
      async function runBatchDelete(ids) {
        let ok = 0;
        const failures = [];
        for (let i = 0; i < ids.length; i++) {
          showBatchProg(`\u5220\u9664\u4E2D ${i + 1}/${ids.length}`, (i + 1) / ids.length * 100);
          const session = allSessions.find((s) => s.id === ids[i]);
          try {
            await apiDelete(ids[i]);
            ok++;
          } catch (e) {
            failures.push({ id: ids[i], title: session?.title || ids[i], error: e.message });
          }
        }
        toast(`\u5B8C\u6210: \u6210\u529F ${ok}, \u5931\u8D25 ${failures.length}`, ok ? "success" : "error");
        allSessions = await fetchAllSessions();
        selIds.clear();
        renderList(batchListEl, allSessions, { onCheck: true, showCats: true });
        if (failures.length) renderBatchFailures(batchStatusEl, failures, "\u91CD\u8BD5\u5931\u8D25\u5220\u9664", () => runBatchDelete(failures.map((f) => f.id)));
        else hideBatchProg();
      }
      panel.querySelector("#batch-load").onclick = async () => {
        try {
          batchListEl.innerHTML = '<div style="color:#888;padding:8px 0">\u52A0\u8F7D\u4E2D...</div>';
          allSessions = await fetchAllSessions();
          selIds.clear();
          renderList(batchListEl, allSessions, { onCheck: true, showCats: true });
          toast(`\u5DF2\u52A0\u8F7D ${allSessions.length} \u6761\u5BF9\u8BDD`, "success");
        } catch (e) {
          toast(`\u52A0\u8F7D\u5931\u8D25: ${e.message}`, "error");
          batchListEl.innerHTML = "";
        }
      };
      panel.querySelector("#batch-sel-all").onclick = () => {
        allSessions.forEach((s) => selIds.add(s.id));
        renderList(batchListEl, allSessions, { onCheck: true, showCats: true });
      };
      panel.querySelector("#batch-desel").onclick = () => {
        selIds.clear();
        renderList(batchListEl, allSessions, { onCheck: true, showCats: true });
      };
      panel.querySelector("#batch-del").onclick = async () => {
        if (!selIds.size) {
          toast("\u8BF7\u5148\u9009\u62E9", "error");
          return;
        }
        if (!confirm(`\u786E\u5B9A\u5220\u9664 ${selIds.size} \u6761\u5BF9\u8BDD\uFF1F\u4E0D\u53EF\u64A4\u9500\u3002`)) return;
        runBatchDelete([...selIds]);
      };
      panel.querySelector("#batch-del-all").onclick = async () => {
        if (!confirm("\u26A0\uFE0F \u5220\u9664\u3010\u6240\u6709\u3011\u5BF9\u8BDD\uFF1F\u4E0D\u53EF\u64A4\u9500\uFF01")) return;
        if (!confirm("\u518D\u6B21\u786E\u8BA4\uFF01")) return;
        try {
          showBatchProg("\u6E05\u7A7A\u4E2D...", 50);
          await apiDeleteAll();
          hideBatchProg();
          toast("\u5DF2\u6E05\u7A7A", "success");
          allSessions = [];
          selIds.clear();
          renderList(batchListEl, [], {});
        } catch (e) {
          hideBatchProg();
          toast(`\u5931\u8D25: ${e.message}`, "error");
        }
      };
      const forkListEl = panel.querySelector("#fork-list");
      function updateForkInfo() {
        const sid = getSessionId();
        panel.querySelector("#fork-info").innerHTML = sid ? `<code style="color:#7aa2f7;font-size:12px">${sid}</code>` : '<span style="color:#888">\u672A\u6253\u5F00\u5BF9\u8BDD\uFF0C\u8BF7\u5148\u6253\u5F00\u4E00\u4E2A\u5BF9\u8BDD</span>';
      }
      async function forkEntire(sessionId) {
        if (!confirm("Fork \u6B64\u5BF9\u8BDD\uFF1F\u5C06\u521B\u5EFA\u4E00\u4EFD\u5B8C\u6574\u526F\u672C\u3002")) return;
        try {
          toast("\u83B7\u53D6\u6D88\u606F\u4E2D...", "info");
          const hist = await apiHistory(sessionId);
          const msgs = hist?.biz_data?.chat_messages || [];
          if (!msgs.length) {
            toast("\u5BF9\u8BDD\u4E3A\u7A7A", "error");
            return;
          }
          const mids = msgs.map((m) => m.message_id);
          toast("\u521B\u5EFA\u5206\u4EAB...", "info");
          const sd = await apiCreateShare(sessionId, mids);
          const shareId = sd?.biz_data?.share_id;
          if (!shareId) throw new Error("\u521B\u5EFA\u5206\u4EAB\u5931\u8D25");
          toast("Fork \u4E2D...", "info");
          const fd = await apiForkShare(shareId);
          const newId = fd?.biz_data?.chat_session_id;
          if (!newId) throw new Error("Fork \u5931\u8D25");
          toast("Fork \u6210\u529F\uFF01", "success");
          setTimeout(() => {
            location.href = `/a/chat/s/${newId}`;
          }, 800);
        } catch (e) {
          toast(`Fork \u5931\u8D25: ${e.message}`, "error");
        }
      }
      function showForkPicker(sessionId, messages) {
        const userMsgs = messages.filter((m) => m.role === "USER" && m.status !== "in_progress");
        if (!userMsgs.length) {
          toast("\u6CA1\u6709\u7528\u6237\u6D88\u606F", "error");
          return;
        }
        const findAssistantReply = (userMsg) => {
          const idx = messages.findIndex((m) => m.message_id === userMsg.message_id);
          if (idx < 0) return null;
          return messages.slice(idx + 1).find((m) => m.role === "ASSISTANT" && m.parent_id === userMsg.message_id) || null;
        };
        const buildForkMessageIds = (userMsg) => {
          const mm = new Map(messages.map((m) => [m.message_id, m]));
          const ids = [];
          let cur = userMsg;
          while (cur) {
            ids.unshift(cur.message_id);
            cur = cur.parent_id ? mm.get(cur.parent_id) : null;
          }
          const assistant = findAssistantReply(userMsg);
          if (assistant) ids.push(assistant.message_id);
          return ids;
        };
        let sel = userMsgs.length - 1;
        const { backdrop: bg, close } = createModal(document, {
          html: `<div class="dse-modal-box"><div class="mhd">\u9009\u62E9 Fork \u8D77\u70B9</div><div class="mbd"><div id="fp-list"></div><div id="fp-range" style="margin-top:10px;color:#888;font-size:12px"></div></div><div class="mft"><button class="cancel">\u53D6\u6D88</button><button class="confirm">\u786E\u8BA4 Fork</button></div></div>`
        });
        const listEl = bg.querySelector("#fp-list");
        const rangeEl = bg.querySelector("#fp-range");
        const updateRange = () => {
          const ids = buildForkMessageIds(userMsgs[sel]);
          rangeEl.textContent = `\u5C06 fork \u4ECE\u5BF9\u8BDD\u5F00\u5934\u5230\u6240\u9009\u7528\u6237\u6D88\u606F${ids.length > 1 ? "\u53CA\u5176\u52A9\u624B\u56DE\u590D" : ""}\uFF0C\u5171 ${ids.length} \u6761\u6D88\u606F\u3002`;
        };
        userMsgs.forEach((m, i) => {
          const r = document.createElement("div");
          r.className = `dse-msg-row ${i === sel ? "sel" : ""}`;
          const assistant = findAssistantReply(m);
          r.innerHTML = `<span class="num">#${i + 1}</span><span style="flex:1;min-width:0"><span class="preview">${esc((m.content || "").substring(0, 120))}</span><span style="display:block;color:#666;font-size:12px;margin-top:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">\u52A9\u624B\u9884\u89C8\uFF1A${esc((assistant?.content || "\u65E0\u540E\u7EED\u52A9\u624B\u56DE\u590D").substring(0, 120))}</span></span>`;
          r.onclick = () => {
            listEl.querySelectorAll(".dse-msg-row").forEach((e) => e.classList.remove("sel"));
            r.classList.add("sel");
            sel = i;
            updateRange();
          };
          listEl.appendChild(r);
        });
        updateRange();
        bg.querySelector(".cancel").onclick = close;
        bg.querySelector(".confirm").onclick = async () => {
          close();
          const sm = userMsgs[sel];
          const ids = buildForkMessageIds(sm);
          try {
            toast("Fork \u4E2D...", "info");
            const sd = await apiCreateShare(sessionId, ids);
            const shareId = sd?.biz_data?.share_id;
            if (!shareId) throw new Error("\u521B\u5EFA\u5206\u4EAB\u5931\u8D25");
            const fd = await apiForkShare(shareId);
            const newId = fd?.biz_data?.chat_session_id;
            if (!newId) throw new Error("Fork \u5931\u8D25");
            toast("Fork \u6210\u529F\uFF01", "success");
            setTimeout(() => {
              location.href = `/a/chat/s/${newId}`;
            }, 800);
          } catch (e) {
            toast(`\u5931\u8D25: ${e.message}`, "error");
          }
        };
      }
      panel.querySelector("#fork-entire").onclick = () => {
        const s = getSessionId();
        s ? forkEntire(s) : toast("\u8BF7\u5148\u6253\u5F00\u4E00\u4E2A\u5BF9\u8BDD", "error");
      };
      panel.querySelector("#fork-pick").onclick = async () => {
        const s = getSessionId();
        if (!s) {
          toast("\u8BF7\u5148\u6253\u5F00\u4E00\u4E2A\u5BF9\u8BDD", "error");
          return;
        }
        try {
          toast("\u52A0\u8F7D\u6D88\u606F...", "info");
          const h = await apiHistory(s);
          const m = h?.biz_data?.chat_messages || [];
          if (!m.length) {
            toast("\u5BF9\u8BDD\u4E3A\u7A7A", "error");
            return;
          }
          showForkPicker(s, m);
        } catch (e) {
          toast(`\u5931\u8D25: ${e.message}`, "error");
        }
      };
      panel.querySelector("#fork-load").onclick = async () => {
        try {
          forkListEl.innerHTML = '<div style="color:#888;padding:8px 0">\u52A0\u8F7D\u4E2D...</div>';
          allSessions = await fetchAllSessions();
          renderList(forkListEl, allSessions, { showFork: true, showCats: true });
          toast(`\u5DF2\u52A0\u8F7D ${allSessions.length} \u6761`, "success");
        } catch (e) {
          toast(`\u5931\u8D25: ${e.message}`, "error");
          forkListEl.innerHTML = "";
        }
      };
      const catListEl = panel.querySelector("#cat-list");
      const catChipsEl = panel.querySelector("#cat-chips");
      const catFilterBar = panel.querySelector("#cat-filter-bar");
      const catBulkSelect = panel.querySelector("#cat-bulk-cat");
      function renderCatBulkOptions() {
        const current = catBulkSelect.value;
        catBulkSelect.innerHTML = '<option value="">\u9009\u62E9\u5206\u7C7B...</option>';
        catData.categories.forEach((c) => {
          const opt = document.createElement("option");
          opt.value = c.id;
          opt.textContent = c.name;
          catBulkSelect.appendChild(opt);
        });
        if (current && catData.categories.some((c) => c.id === current)) catBulkSelect.value = current;
      }
      function renderCatChips() {
        catChipsEl.innerHTML = "";
        catData.categories.forEach((c) => {
          const chip = document.createElement("span");
          chip.className = "dse-chip";
          chip.style.background = c.color + "22";
          chip.style.color = c.color;
          chip.style.border = `1px solid ${c.color}44`;
          chip.innerHTML = `${esc(c.name)} <span class="x">&times;</span>`;
          chip.querySelector(".x").onclick = (e) => {
            e.stopPropagation();
            if (confirm(`\u5220\u9664\u5206\u7C7B\u300C${c.name}\u300D\uFF1F`)) {
              removeCategory(c.id);
              renderCatChips();
              renderCatFilterBar();
              renderCatBulkOptions();
              renderSearchCatOptions();
              nativeMountManager.schedule();
            }
          };
          catChipsEl.appendChild(chip);
        });
      }
      function renderCatFilterBar() {
        catFilterBar.innerHTML = "";
        const allBtn = document.createElement("button");
        allBtn.textContent = "\u5168\u90E8";
        if (!activeCatFilter) allBtn.classList.add("active");
        allBtn.onclick = () => {
          activeCatFilter = null;
          renderCatFilterBar();
          renderCatListFiltered();
        };
        catFilterBar.appendChild(allBtn);
        catData.categories.forEach((c) => {
          const btn = document.createElement("button");
          btn.textContent = c.name;
          btn.style.borderColor = c.color;
          if (activeCatFilter === c.id) {
            btn.classList.add("active");
            btn.style.background = c.color + "33";
          }
          btn.onclick = () => {
            activeCatFilter = activeCatFilter === c.id ? null : c.id;
            renderCatFilterBar();
            renderCatListFiltered();
          };
          catFilterBar.appendChild(btn);
        });
      }
      function renderCatListFiltered() {
        const filtered = filterByCat(allSessions, activeCatFilter);
        renderList(catListEl, filtered, { showCats: true, onCheck: true });
      }
      function getVisibleCatSessions() {
        return filterByCat(allSessions, activeCatFilter);
      }
      function applyBulkCategory(mode) {
        const catId = catBulkSelect.value;
        if (!catId) {
          toast("\u8BF7\u9009\u62E9\u5206\u7C7B", "error");
          return;
        }
        const visibleIds = new Set(getVisibleCatSessions().map((s) => s.id));
        const ids = [...selIds].filter((id) => visibleIds.has(id));
        if (!ids.length) {
          toast("\u8BF7\u5148\u9009\u62E9\u5F53\u524D\u5217\u8868\u4E2D\u7684\u5BF9\u8BDD", "error");
          return;
        }
        let changed = 0;
        ids.forEach((id) => {
          const list = catData.sessionMap[id] || [];
          const has = list.includes(catId);
          if (mode === "add" && !has) {
            catData.sessionMap[id] = [...list, catId];
            changed++;
          } else if (mode === "remove" && has) {
            const next = list.filter((cid) => cid !== catId);
            if (next.length) catData.sessionMap[id] = next;
            else delete catData.sessionMap[id];
            changed++;
          }
        });
        saveCats(catData);
        renderCatListFiltered();
        doSearch();
        nativeMountManager.schedule();
        toast(`\u5DF2${mode === "add" ? "\u6DFB\u52A0" : "\u79FB\u9664"} ${changed} \u9879`, changed ? "success" : "info");
      }
      function showCatPicker(sid) {
        const { backdrop: bg, box, close } = createModal(document, {
          html: `<div class="dse-modal-box"><div class="mhd">\u4E3A\u5BF9\u8BDD\u5206\u914D\u6807\u7B7E</div><div class="mbd" id="cp-list"></div><div class="mft"><button class="cancel">\u5B8C\u6210</button></div></div>`
        });
        const cpList = box.querySelector("#cp-list");
        const sc = getSessionCats(sid);
        catData.categories.forEach((c) => {
          const r = document.createElement("div");
          r.className = "dse-msg-row";
          const has = sc.includes(c.id);
          r.innerHTML = `<span style="width:14px;height:14px;border-radius:50%;background:${c.color};flex-shrink:0"></span><span style="flex:1">${esc(c.name)}</span><span style="color:${has ? "#7aa2f7" : "#555"}">${has ? "\u5DF2\u9009" : ""}</span>`;
          r.onclick = () => {
            toggleCatSession(sid, c.id);
            nativeMountManager.schedule();
            showCatPicker(sid);
            close();
          };
          cpList.appendChild(r);
        });
        box.querySelector(".cancel").onclick = close;
      }
      panel.querySelector("#cat-add").onclick = () => {
        const name = panel.querySelector("#cat-name").value.trim();
        const color = panel.querySelector("#cat-color").value;
        if (!name) {
          toast("\u8BF7\u8F93\u5165\u5206\u7C7B\u540D\u79F0", "error");
          return;
        }
        addCategory(name, color);
        panel.querySelector("#cat-name").value = "";
        renderCatChips();
        renderCatFilterBar();
        renderCatBulkOptions();
        renderSearchCatOptions();
        nativeMountManager.schedule();
        toast(`\u5DF2\u6DFB\u52A0\u300C${name}\u300D`, "success");
      };
      panel.querySelector("#cat-load").onclick = async () => {
        try {
          catListEl.innerHTML = '<div style="color:#888;padding:8px 0">\u52A0\u8F7D\u4E2D...</div>';
          allSessions = await fetchAllSessions();
          selIds.clear();
          renderCatFilterBar();
          renderCatListFiltered();
          toast(`\u5DF2\u52A0\u8F7D ${allSessions.length} \u6761`, "success");
        } catch (e) {
          toast(`\u5931\u8D25: ${e.message}`, "error");
        }
      };
      panel.querySelector("#cat-sel-all").onclick = () => {
        getVisibleCatSessions().forEach((s) => selIds.add(s.id));
        renderCatListFiltered();
      };
      panel.querySelector("#cat-desel").onclick = () => {
        selIds.clear();
        renderCatListFiltered();
      };
      panel.querySelector("#cat-bulk-add").onclick = () => applyBulkCategory("add");
      panel.querySelector("#cat-bulk-remove").onclick = () => applyBulkCategory("remove");
      panel.querySelector("#cat-export-data").onclick = () => {
        const json = JSON.stringify(catData, null, 2);
        download("dse-categories.json", json, "application/json");
        toast("\u5206\u7C7B\u6570\u636E\u5DF2\u5BFC\u51FA", "success");
      };
      panel.querySelector("#cat-import-data").onclick = () => {
        const inp = document.createElement("input");
        inp.type = "file";
        inp.accept = ".json";
        inp.onchange = async () => {
          const file = inp.files[0];
          if (!file) return;
          try {
            const text = await file.text();
            const data = JSON.parse(text);
            if (!data.categories || !data.sessionMap) throw new Error("\u683C\u5F0F\u9519\u8BEF");
            if (!confirm("\u5BFC\u5165\u4F1A\u8986\u76D6\u5F53\u524D\u5206\u7C7B\u548C\u4F1A\u8BDD\u6620\u5C04\uFF0C\u662F\u5426\u7EE7\u7EED\uFF1F")) return;
            catData = data;
            saveCats(catData);
            renderCatChips();
            renderCatFilterBar();
            renderCatBulkOptions();
            renderSearchCatOptions();
            nativeMountManager.schedule();
            toast("\u5206\u7C7B\u6570\u636E\u5DF2\u5BFC\u5165", "success");
          } catch (e) {
            toast(`\u5BFC\u5165\u5931\u8D25: ${e.message}`, "error");
          }
        };
        inp.click();
      };
      renderCatBulkOptions();
      const searchListEl = panel.querySelector("#search-list");
      const searchCountEl = panel.querySelector("#search-count");
      const searchInput = panel.querySelector("#search-input");
      const searchDateFrom = panel.querySelector("#search-date-from");
      const searchDateTo = panel.querySelector("#search-date-to");
      const searchCat = panel.querySelector("#search-cat");
      function renderSearchCatOptions() {
        const current = searchCat.value;
        searchCat.innerHTML = '<option value="">\u5168\u90E8\u5206\u7C7B</option>';
        catData.categories.forEach((c) => {
          const opt = document.createElement("option");
          opt.value = c.id;
          opt.textContent = c.name;
          searchCat.appendChild(opt);
        });
        if (current && catData.categories.some((c) => c.id === current)) searchCat.value = current;
      }
      function parseDateStart(value) {
        if (!value) return null;
        const time = (/* @__PURE__ */ new Date(`${value}T00:00:00`)).getTime();
        return Number.isFinite(time) ? Math.floor(time / 1e3) : null;
      }
      function parseDateEnd(value) {
        if (!value) return null;
        const time = (/* @__PURE__ */ new Date(`${value}T23:59:59`)).getTime();
        return Number.isFinite(time) ? Math.floor(time / 1e3) : null;
      }
      function openSession(session) {
        if (!session?.id) return;
        location.href = `/a/chat/s/${encodeURIComponent(session.id)}`;
      }
      panel.querySelector("#search-load").onclick = async () => {
        try {
          searchListEl.innerHTML = '<div style="color:#888;padding:8px 0">\u52A0\u8F7D\u4E2D...</div>';
          allSessions = await fetchAllSessions();
          renderSearchCatOptions();
          doSearch();
          toast(`\u5DF2\u52A0\u8F7D ${allSessions.length} \u6761`, "success");
        } catch (e) {
          toast(`\u5931\u8D25: ${e.message}`, "error");
        }
      };
      function doSearch() {
        const q = searchInput.value.trim().toLowerCase();
        const from = parseDateStart(searchDateFrom.value);
        const to = parseDateEnd(searchDateTo.value);
        const catId = searchCat.value;
        const matched = allSessions.filter((s) => {
          if (q && !(s.title || "").toLowerCase().includes(q)) return false;
          const updatedAt = getSessionUpdatedAt(s);
          if (from != null && (updatedAt == null || updatedAt < from)) return false;
          if (to != null && (updatedAt == null || updatedAt > to)) return false;
          if (catId && !getSessionCats(s.id).includes(catId)) return false;
          return true;
        });
        searchCountEl.textContent = `\u627E\u5230 ${matched.length} \u6761`;
        renderList(searchListEl, matched, { showCats: true, highlight: searchInput.value.trim(), onOpen: openSession });
      }
      searchInput.addEventListener("input", doSearch);
      searchDateFrom.addEventListener("change", doSearch);
      searchDateTo.addEventListener("change", doSearch);
      searchCat.addEventListener("change", doSearch);
      renderSearchCatOptions();
      const expListEl = panel.querySelector("#exp-list");
      const expStatusEl = panel.querySelector("#exp-status");
      function showExpProg(t, p) {
        expStatusEl.style.display = "block";
        expStatusEl.innerHTML = `<div>${esc(t)}</div><div class="bar"><div class="bar-i" style="width:${p}%"></div></div>`;
      }
      function hideExpProg() {
        expStatusEl.style.display = "none";
      }
      function exportCurrentSelectionFragment() {
        const text = (window.getSelection?.().toString() || "").trim();
        if (!text) {
          toast("\u8BF7\u5148\u9009\u4E2D\u8981\u5BFC\u51FA\u7684\u6D88\u606F\u7247\u6BB5", "error");
          return;
        }
        const date = (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
        const sid = (getSessionId() || "current").replace(/[^a-zA-Z0-9_-]+/g, "-");
        const content = `# DeepSeek \u6D88\u606F\u7247\u6BB5

- \u65E5\u671F: ${date}
- \u4F1A\u8BDD: ${sid}

---

${text}
`;
        download(`dse-fragment-${sid}-${date}.md`, content, "text/markdown");
        toast("\u5DF2\u5BFC\u51FA\u9009\u4E2D\u6587\u672C\u7247\u6BB5", "success");
      }
      function exportMessageFragment(messageEl) {
        const text = (messageEl?.textContent || "").trim();
        if (!text) {
          toast("\u8BE5\u6D88\u606F\u6CA1\u6709\u53EF\u5BFC\u51FA\u7684\u6587\u672C", "error");
          return;
        }
        const date = (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
        const sid = (getSessionId() || "current").replace(/[^a-zA-Z0-9_-]+/g, "-");
        const content = `# DeepSeek \u56DE\u590D\u7247\u6BB5

- \u65E5\u671F: ${date}
- \u4F1A\u8BDD: ${sid}

---

${text}
`;
        download(`dse-message-${sid}-${date}.md`, content, "text/markdown");
        toast("\u5DF2\u5BFC\u51FA\u8BE5\u6761\u56DE\u590D", "success");
      }
      panel.querySelector("#exp-load").onclick = async () => {
        try {
          expListEl.innerHTML = '<div style="color:#888;padding:8px 0">\u52A0\u8F7D\u4E2D...</div>';
          allSessions = await fetchAllSessions();
          selIds.clear();
          renderList(expListEl, allSessions, { onCheck: true, showCats: true });
          toast(`\u5DF2\u52A0\u8F7D ${allSessions.length} \u6761`, "success");
        } catch (e) {
          toast(`\u5931\u8D25: ${e.message}`, "error");
        }
      };
      panel.querySelector("#exp-sel-all").onclick = () => {
        allSessions.forEach((s) => selIds.add(s.id));
        renderList(expListEl, allSessions, { onCheck: true, showCats: true });
      };
      panel.querySelector("#exp-desel").onclick = () => {
        selIds.clear();
        renderList(expListEl, allSessions, { onCheck: true, showCats: true });
      };
      panel.querySelector("#exp-fragment").onclick = exportCurrentSelectionFragment;
      panel.querySelector("#exp-go").onclick = async () => {
        if (!selIds.size) {
          toast("\u8BF7\u5148\u9009\u62E9", "error");
          return;
        }
        const fmt = panel.querySelector("#exp-format").value;
        const ids = [...selIds];
        const results = [];
        for (let i = 0; i < ids.length; i++) {
          showExpProg(`\u5BFC\u51FA\u4E2D ${i + 1}/${ids.length}`, (i + 1) / ids.length * 100);
          const s = allSessions.find((x) => x.id === ids[i]);
          try {
            const h = await apiHistory(ids[i]);
            const msgs = h?.biz_data?.chat_messages || [];
            results.push({ session: s, messages: msgs });
          } catch (e) {
            results.push({ session: s, messages: [], error: e.message });
          }
        }
        hideExpProg();
        if (fmt === "json") {
          const json = JSON.stringify(results, null, 2);
          download(exportFileName(results, "json"), json, "application/json");
        } else {
          let md = "";
          results.forEach((r) => {
            md += `# ${r.session?.title || "(\u65E0\u6807\u9898)"}

`;
            md += `- \u65E5\u671F: ${fmtDate(r.session?.updated_at)}
`;
            md += `- ID: ${r.session?.id}

`;
            if (r.error) {
              md += `> \u5BFC\u51FA\u5931\u8D25: ${r.error}

`;
              return;
            }
            md += renderMarkdownMessageTree(r.messages);
            md += "\n";
            md += "\n";
          });
          download(exportFileName(results, "md"), md, "text/markdown");
        }
        toast(`\u5DF2\u5BFC\u51FA ${results.length} \u4E2A\u5BF9\u8BDD`, "success");
      };
      const rnmListEl = panel.querySelector("#rnm-list");
      const rnmStatusEl = panel.querySelector("#rnm-status");
      const rnmPreviewEl = panel.querySelector("#rnm-preview-area");
      const rnmMode = panel.querySelector("#rnm-mode");
      const rnmParams = panel.querySelector("#rnm-params");
      function showRnmProg(t, p) {
        rnmStatusEl.style.display = "block";
        rnmStatusEl.innerHTML = `<div>${esc(t)}</div><div class="bar"><div class="bar-i" style="width:${p}%"></div></div>`;
      }
      function hideRnmProg() {
        rnmStatusEl.style.display = "none";
      }
      async function runRenameBatch(renames, rerender) {
        let ok = 0;
        const failures = [];
        for (let i = 0; i < renames.length; i++) {
          showRnmProg(`\u91CD\u547D\u540D\u4E2D ${i + 1}/${renames.length}`, (i + 1) / renames.length * 100);
          try {
            await apiRename(renames[i].id, renames[i].title);
            ok++;
          } catch (e) {
            failures.push({ ...renames[i], error: e.message });
          }
        }
        toast(`\u5B8C\u6210: \u6210\u529F ${ok}, \u5931\u8D25 ${failures.length}`, ok ? "success" : "error");
        allSessions = await fetchAllSessions();
        rerender();
        if (failures.length) renderBatchFailures(rnmStatusEl, failures, "\u91CD\u8BD5\u5931\u8D25\u91CD\u547D\u540D", () => runRenameBatch(failures, rerender));
        else hideRnmProg();
      }
      function renderRenameParams() {
        const mode = rnmMode.value;
        if (mode === "direct") rnmParams.innerHTML = '<div style="margin-top:4px;font-size:12px;color:#888">\u9009\u4E2D\u5BF9\u8BDD\u540E\u70B9\u51FB\u4E0B\u65B9\u300C\u52A0\u8F7D\u9009\u4E2D\u300D\uFF0C\u6BCF\u6761\u4F1A\u663E\u793A\u4E00\u4E2A\u8F93\u5165\u6846\u53EF\u76F4\u63A5\u7F16\u8F91\u6807\u9898</div>';
        else if (mode === "prefix") rnmParams.innerHTML = '<input type="text" id="rnm-prefix" class="dse-input" placeholder="\u8F93\u5165\u524D\u7F00..." style="margin-top:4px">';
        else if (mode === "suffix") rnmParams.innerHTML = '<input type="text" id="rnm-suffix" class="dse-input" placeholder="\u8F93\u5165\u540E\u7F00..." style="margin-top:4px">';
        else if (mode === "replace") rnmParams.innerHTML = '<div style="display:flex;gap:6px;margin-top:4px"><input type="text" id="rnm-find" class="dse-input" placeholder="\u67E5\u627E"><input type="text" id="rnm-repl" class="dse-input" placeholder="\u66FF\u6362\u4E3A"></div>';
        else if (mode === "serial") rnmParams.innerHTML = '<div style="display:flex;gap:6px;margin-top:4px;align-items:center"><input type="text" id="rnm-fmt" class="dse-input" placeholder="\u683C\u5F0F: {n} {title}" value="{n}. {title}" style="flex:1"><span style="font-size:11px;color:#666">\u53EF\u7528: {n} {name}</span></div>';
      }
      rnmMode.onchange = () => {
        renderRenameParams();
        rnmPreviewEl.innerHTML = "";
      };
      renderRenameParams();
      function getNewTitle(s, idx, mode) {
        const t = s.title || "(\u65E0\u6807\u9898)";
        if (mode === "prefix") {
          const p = rnmParams.querySelector("#rnm-prefix")?.value || "";
          return p + t;
        }
        if (mode === "suffix") {
          const p = rnmParams.querySelector("#rnm-suffix")?.value || "";
          return t + p;
        }
        if (mode === "replace") {
          const find = rnmParams.querySelector("#rnm-find")?.value || "";
          const repl = rnmParams.querySelector("#rnm-repl")?.value || "";
          if (!find) return t;
          return t.split(find).join(repl);
        }
        if (mode === "serial") {
          const fmt = rnmParams.querySelector("#rnm-fmt")?.value || "{n}. {title}";
          const n = String(idx + 1).padStart(3, "0");
          return fmt.replace(/\{n\}/g, n).replace(/\{title\}/g, t).replace(/\{name\}/g, t);
        }
        return t;
      }
      function renderDirectRenameList(sessions) {
        rnmListEl.innerHTML = "";
        if (!sessions.length) {
          rnmListEl.innerHTML = '<div style="color:#555;font-size:13px;padding:12px 0">\u6682\u65E0\u5BF9\u8BDD</div>';
          return;
        }
        sessions.forEach((s) => {
          const row = document.createElement("div");
          row.className = "dse-row";
          row.style.cursor = "default";
          const dt = document.createElement("span");
          dt.className = "dt";
          dt.textContent = fmtDate(s.updated_at);
          dt.style.marginRight = "6px";
          const inp = document.createElement("input");
          inp.type = "text";
          inp.className = "dse-input";
          inp.value = s.title || "";
          inp.style.flex = "1";
          inp.dataset.sid = s.id;
          row.appendChild(dt);
          row.appendChild(inp);
          rnmListEl.appendChild(row);
        });
      }
      panel.querySelector("#rnm-load").onclick = async () => {
        try {
          rnmListEl.innerHTML = '<div style="color:#888;padding:8px 0">\u52A0\u8F7D\u4E2D...</div>';
          allSessions = await fetchAllSessions();
          selIds.clear();
          if (rnmMode.value === "direct") {
            renderDirectRenameList(allSessions);
          } else {
            renderList(rnmListEl, allSessions, { onCheck: true, showCats: true });
          }
          rnmPreviewEl.innerHTML = "";
          toast(`\u5DF2\u52A0\u8F7D ${allSessions.length} \u6761`, "success");
        } catch (e) {
          toast(`\u5931\u8D25: ${e.message}`, "error");
        }
      };
      panel.querySelector("#rnm-sel-all").onclick = () => {
        if (rnmMode.value === "direct") return;
        allSessions.forEach((s) => selIds.add(s.id));
        renderList(rnmListEl, allSessions, { onCheck: true, showCats: true });
      };
      panel.querySelector("#rnm-desel").onclick = () => {
        if (rnmMode.value === "direct") return;
        selIds.clear();
        renderList(rnmListEl, allSessions, { onCheck: true, showCats: true });
      };
      panel.querySelector("#rnm-preview").onclick = () => {
        if (rnmMode.value === "direct") {
          toast("\u76F4\u63A5\u91CD\u547D\u540D\u6A21\u5F0F\u65E0\u9700\u9884\u89C8\uFF0C\u76F4\u63A5\u7F16\u8F91\u8F93\u5165\u6846\u5373\u53EF", "info");
          return;
        }
        if (!selIds.size) {
          toast("\u8BF7\u5148\u9009\u62E9", "error");
          return;
        }
        const mode = rnmMode.value;
        const selected = allSessions.filter((s) => selIds.has(s.id));
        let html = "";
        selected.forEach((s, i) => {
          const oldT = s.title || "(\u65E0\u6807\u9898)";
          const newT = getNewTitle(s, i, mode);
          html += `<div class="dse-rename-preview"><span class="old">${esc(oldT)}</span><span class="arrow">\u2192</span><span class="new">${esc(newT)}</span></div>`;
        });
        rnmPreviewEl.innerHTML = html;
      };
      panel.querySelector("#rnm-go").onclick = async () => {
        const mode = rnmMode.value;
        if (mode === "direct") {
          const inputs = rnmListEl.querySelectorAll("input[data-sid]");
          if (!inputs.length) {
            toast("\u8BF7\u5148\u70B9\u51FB\u300C\u52A0\u8F7D\u5BF9\u8BDD\u5217\u8868\u300D", "error");
            return;
          }
          const renames2 = [];
          inputs.forEach((inp) => {
            const sid = inp.dataset.sid;
            const newTitle = inp.value.trim();
            const old = allSessions.find((s) => s.id === sid);
            if (old && newTitle && newTitle !== (old.title || "")) {
              renames2.push({ id: sid, title: newTitle });
            }
          });
          if (!renames2.length) {
            toast("\u6CA1\u6709\u9700\u8981\u4FEE\u6539\u7684\u6807\u9898", "info");
            return;
          }
          if (!confirm(`\u786E\u5B9A\u91CD\u547D\u540D ${renames2.length} \u6761\u5BF9\u8BDD\uFF1F`)) return;
          runRenameBatch(renames2, () => renderDirectRenameList(allSessions));
          return;
        }
        if (!selIds.size) {
          toast("\u8BF7\u5148\u9009\u62E9", "error");
          return;
        }
        const selected = allSessions.filter((s) => selIds.has(s.id));
        if (!confirm(`\u786E\u5B9A\u91CD\u547D\u540D ${selected.length} \u6761\u5BF9\u8BDD\uFF1F`)) return;
        const renames = selected.map((s, i) => ({ id: s.id, title: getNewTitle(s, i, mode), oldTitle: s.title || "(\u65E0\u6807\u9898)" }));
        runRenameBatch(renames, () => {
          selIds.clear();
          renderList(rnmListEl, allSessions, { onCheck: true, showCats: true });
          rnmPreviewEl.innerHTML = "";
        });
      };
      document.addEventListener("keydown", (e) => {
        if (e.ctrlKey && e.shiftKey && e.key === "D") {
          e.preventDefault();
          panel.classList.toggle("open");
          if (panel.classList.contains("open")) posPanel();
        }
      });
      const promptListEl = panel.querySelector("#prompt-list");
      const promptNameInput = panel.querySelector("#prompt-name");
      const promptGroupInput = panel.querySelector("#prompt-group");
      function loadPrompts() {
        let arr;
        arr = localStore.getJson(LS_PROMPTS, null);
        if (!Array.isArray(arr)) {
          const single = localStore.getText(LS_PROMPT, "").trim();
          arr = single ? [{ id: Date.now(), name: "\u9ED8\u8BA4\u63D0\u793A\u8BCD", group: "\u9ED8\u8BA4", content: single, enabled: true }] : [];
          localStore.setJson(LS_PROMPTS, arr);
        }
        return arr.map((p) => ({ group: "\u9ED8\u8BA4", ...p }));
      }
      function savePrompts(arr) {
        localStore.setJson(LS_PROMPTS, arr);
      }
      function renderPromptCards() {
        const prompts = loadPrompts();
        if (!prompts.length) {
          promptListEl.innerHTML = '<div style="color:#555;font-size:13px;text-align:center;padding:20px 0">\u6682\u65E0\u63D0\u793A\u8BCD\uFF0C\u8F93\u5165\u540D\u79F0\u540E\u70B9\u51FB"\u6DFB\u52A0"</div>';
          return;
        }
        promptListEl.innerHTML = prompts.map((p, index) => `
      <div class="dse-pcard${p.enabled ? "" : " disabled"}" data-id="${p.id}">
        <div class="dse-pcard-hd">
          <label class="dse-pcard-toggle"><input type="checkbox" class="p-toggle" ${p.enabled ? "checked" : ""}><span class="slider"></span></label>
          <span class="pname">${esc(p.name)}</span>
          <span style="font-size:11px;color:#666;border:1px solid #333;border-radius:8px;padding:1px 6px">${esc(p.group || "\u9ED8\u8BA4")}</span>
          <button class="btn-pc p-up" title="\u4E0A\u79FB" ${index === 0 ? "disabled" : ""}>\u2191</button>
          <button class="btn-pc p-down" title="\u4E0B\u79FB" ${index === prompts.length - 1 ? "disabled" : ""}>\u2193</button>
          <button class="btn-pc p-edit" title="\u7F16\u8F91">\u7F16\u8F91</button>
          <button class="btn-pc p-rename" title="\u91CD\u547D\u540D">\u91CD\u547D\u540D</button>
          <button class="btn-pc dng p-del" title="\u5220\u9664">\u5220\u9664</button>
        </div>
        <div class="dse-pcard-body">
          <input class="dse-input p-group" value="${esc(p.group || "\u9ED8\u8BA4")}" placeholder="\u5206\u7EC4" style="margin-bottom:6px;font-size:12px">
          <textarea class="p-content" rows="4">${esc(p.content)}</textarea>
          <div class="pfoot"><button class="pri p-save-content">\u4FDD\u5B58\u5185\u5BB9</button></div>
        </div>
      </div>
    `).join("");
        promptListEl.querySelectorAll(".dse-pcard").forEach((card) => {
          const id = Number(card.dataset.id);
          card.querySelector(".p-up").onclick = () => {
            const pList = loadPrompts();
            const idx = pList.findIndex((x) => x.id === id);
            if (idx > 0) {
              [pList[idx - 1], pList[idx]] = [pList[idx], pList[idx - 1]];
              savePrompts(pList);
              renderPromptCards();
              InlinePromptUI.update();
            }
          };
          card.querySelector(".p-down").onclick = () => {
            const pList = loadPrompts();
            const idx = pList.findIndex((x) => x.id === id);
            if (idx >= 0 && idx < pList.length - 1) {
              [pList[idx + 1], pList[idx]] = [pList[idx], pList[idx + 1]];
              savePrompts(pList);
              renderPromptCards();
              InlinePromptUI.update();
            }
          };
          card.querySelector(".p-toggle").onchange = (e) => {
            const pList = loadPrompts();
            const p = pList.find((x) => x.id === id);
            if (p) {
              p.enabled = e.target.checked;
              savePrompts(pList);
            }
            card.classList.toggle("disabled", !e.target.checked);
            InlinePromptUI.update();
          };
          card.querySelector(".p-edit").onclick = () => {
            card.querySelector(".dse-pcard-body").classList.toggle("open");
          };
          card.querySelector(".p-rename").onclick = () => {
            const nameEl = card.querySelector(".pname");
            nameEl.contentEditable = "true";
            nameEl.focus();
            const done = () => {
              nameEl.contentEditable = "false";
              const newName = nameEl.textContent.trim() || "\u672A\u547D\u540D";
              nameEl.textContent = newName;
              const pList = loadPrompts();
              const p = pList.find((x) => x.id === id);
              if (p) {
                p.name = newName;
                savePrompts(pList);
                InlinePromptUI.update();
              }
            };
            nameEl.onblur = done;
            nameEl.onkeydown = (ev) => {
              if (ev.key === "Enter") {
                ev.preventDefault();
                nameEl.blur();
              }
            };
          };
          card.querySelector(".p-del").onclick = () => {
            if (!confirm("\u786E\u5B9A\u5220\u9664\u8BE5\u63D0\u793A\u8BCD\uFF1F")) return;
            savePrompts(loadPrompts().filter((x) => x.id !== id));
            renderPromptCards();
            InlinePromptUI.update();
            toast("\u63D0\u793A\u8BCD\u5DF2\u5220\u9664", "info");
          };
          card.querySelector(".p-save-content").onclick = () => {
            const val = card.querySelector(".p-content").value.trim();
            const group = card.querySelector(".p-group").value.trim() || "\u9ED8\u8BA4";
            const pList = loadPrompts();
            const p = pList.find((x) => x.id === id);
            if (p) {
              p.content = val;
              p.group = group;
              savePrompts(pList);
            }
            toast("\u5185\u5BB9\u5DF2\u4FDD\u5B58", "success");
            card.querySelector(".dse-pcard-body").classList.remove("open");
            renderPromptCards();
            InlinePromptUI.update();
          };
        });
      }
      panel.querySelector("#prompt-add").onclick = () => {
        const name = promptNameInput.value.trim();
        if (!name) {
          toast("\u8BF7\u8F93\u5165\u63D0\u793A\u8BCD\u540D\u79F0", "info");
          return;
        }
        const group = promptGroupInput.value.trim() || "\u9ED8\u8BA4";
        const prompts = loadPrompts();
        prompts.push({ id: Date.now(), name, group, content: "", enabled: true });
        savePrompts(prompts);
        promptNameInput.value = "";
        promptGroupInput.value = "";
        renderPromptCards();
        toast("\u63D0\u793A\u8BCD\u5DF2\u6DFB\u52A0", "success");
        const lastCard = promptListEl.lastElementChild;
        if (lastCard) {
          lastCard.querySelector(".dse-pcard-body").classList.add("open");
          lastCard.querySelector(".p-content").focus();
        }
      };
      renderPromptCards();
      const InlinePromptUI = {
        btnId: "dse-inline-btn",
        dropdownId: "dse-global-dropdown",
        // 初始化全局无遮挡下拉菜单
        init() {
          if (!document.getElementById(this.dropdownId)) {
            const dp = document.createElement("div");
            dp.id = this.dropdownId;
            dp.className = "dse-global-dropdown";
            document.body.appendChild(dp);
            document.addEventListener("click", (e) => {
              const btn = document.getElementById(this.btnId);
              if (dp.classList.contains("open") && !dp.contains(e.target) && (!btn || !btn.contains(e.target))) {
                dp.classList.remove("open");
              }
            });
          }
        },
        // 寻找原生按钮并动态挂载/矫正位置
        mount() {
          const container = DeepSeekAdapter.findComposerToolbar();
          if (!container) return;
          let btn = document.getElementById(this.btnId);
          if (!btn) {
            btn = document.createElement("button");
            btn.id = this.btnId;
            btn.type = "button";
            btn.className = "dse-inline-btn";
            btn.innerHTML = `<span aria-hidden="true">\u2318</span><span class="dse-btn-text">\u6307\u4EE4</span>`;
            btn.onclick = (e) => {
              e.preventDefault();
              e.stopPropagation();
              this.toggleDropdown(btn);
            };
          }
          const nativeToggles = Array.from(container.children).filter((c) => c.classList?.contains("ds-toggle-button") && c.id !== this.btnId);
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
          const textEl = btn.querySelector(".dse-btn-text");
          const prompts = loadPrompts();
          const enabled = prompts.filter((p) => p.enabled);
          if (enabled.length === 0) {
            btn.classList.remove("active");
            if (textEl.textContent !== "\u6307\u4EE4") {
              textEl.textContent = "\u6307\u4EE4";
            }
          } else {
            btn.classList.add("active");
            const newText = enabled.length === 1 ? enabled[0].name : `${enabled.length} \u6761\u6307\u4EE4`;
            if (textEl.textContent !== newText) {
              textEl.textContent = newText;
            }
          }
        },
        // 展开/收起绝对定位的全局菜单
        toggleDropdown(btnEl) {
          const dp = document.getElementById(this.dropdownId);
          if (!dp) return;
          if (dp.classList.contains("open")) {
            dp.classList.remove("open");
            return;
          }
          this.renderDropdownContent(dp);
          const rect = btnEl.getBoundingClientRect();
          dp.style.left = `${rect.left}px`;
          dp.style.bottom = `${window.innerHeight - rect.top + 8}px`;
          dp.classList.add("open");
        },
        // 渲染菜单内容
        renderDropdownContent(dp) {
          const prompts = loadPrompts();
          dp.innerHTML = "";
          if (!prompts.length) {
            dp.innerHTML = '<div style="padding:8px 12px;color:#888;font-size:13px;text-align:center;">\u6682\u65E0\u63D0\u793A\u8BCD</div>';
          } else {
            prompts.forEach((p) => {
              const item = document.createElement("div");
              item.className = `dse-dropdown-item ${p.enabled ? "active" : ""}`;
              item.innerHTML = `
            <div style="width:14px;height:14px;border-radius:4px;border:1px solid ${p.enabled ? "#7aa2f7" : "#555"};background:${p.enabled ? "#7aa2f7" : "transparent"};display:flex;align-items:center;justify-content:center;flex-shrink:0;">
              ${p.enabled ? '<svg width="10" height="10" viewBox="0 0 12 12" fill="none"><path d="M2 6L5 9L10 3" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>' : ""}
            </div>
            <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(p.content)}">${esc(p.name)}</span>
          `;
              item.onclick = (e) => {
                e.stopPropagation();
                p.enabled = !p.enabled;
                savePrompts(prompts);
                renderPromptCards();
                this.renderDropdownContent(dp);
                this.update();
              };
              dp.appendChild(item);
            });
          }
          const div = document.createElement("div");
          div.style.cssText = "height:1px;background:#333;margin:4px 0;";
          dp.appendChild(div);
          const setBtn = document.createElement("div");
          setBtn.className = "dse-dropdown-item";
          setBtn.innerHTML = `<span style="text-align:center;width:100%;color:#aaa;">\u2699\uFE0F \u7BA1\u7406\u63D0\u793A\u8BCD</span>`;
          setBtn.onclick = (e) => {
            e.stopPropagation();
            dp.classList.remove("open");
            document.getElementById("dse-panel").classList.add("open");
            posPanel();
          };
          dp.appendChild(setBtn);
        }
      };
      const NativeSidebarUI = {
        searchBtnId: "dse-native-search-btn",
        batchBtnId: "dse-native-batch-btn",
        mountSearchEntry() {
          const header = DeepSeekAdapter.findSidebarHeader();
          if (!header) return;
          let btn = document.getElementById(this.searchBtnId);
          if (!btn) {
            btn = document.createElement("button");
            btn.id = this.searchBtnId;
            btn.type = "button";
            btn.className = "dse-native-sidebar-btn";
            btn.textContent = "\u641C\u7D22";
            btn.title = "\u6253\u5F00 DS Enhance \u4F1A\u8BDD\u641C\u7D22";
            btn.onclick = (e) => {
              e.preventDefault();
              e.stopPropagation();
              openPanelTab("search");
            };
          }
          if (!header.contains(btn)) header.insertBefore(btn, header.firstChild);
        },
        mountBatchEntry() {
          const header = DeepSeekAdapter.findSidebarHeader();
          if (!header) return;
          let btn = document.getElementById(this.batchBtnId);
          if (!btn) {
            btn = document.createElement("button");
            btn.id = this.batchBtnId;
            btn.type = "button";
            btn.className = "dse-native-sidebar-btn";
            btn.textContent = "\u6279\u91CF";
            btn.title = "\u6253\u5F00 DS Enhance \u6279\u91CF\u64CD\u4F5C";
            btn.onclick = (e) => {
              e.preventDefault();
              e.stopPropagation();
              openPanelTab("batch");
            };
          }
          if (!header.contains(btn)) header.insertBefore(btn, header.firstChild);
        },
        getSessionIdFromLink(link) {
          const href = link.getAttribute("href") || "";
          const match = href.match(/\/s\/([a-f0-9-]+)/i);
          return match?.[1] || null;
        },
        mountCategoryDots() {
          const links = DeepSeekAdapter.findConversationLinks();
          links.forEach((link) => {
            const sid = this.getSessionIdFromLink(link);
            if (!sid) return;
            const row = DeepSeekAdapter.findConversationRow(link);
            row.querySelector?.(".dse-cat-dots")?.remove();
            const cats = getSessionCats(sid).map((id) => catData.categories.find((c) => c.id === id)).filter(Boolean);
            if (!cats.length) return;
            const wrap = document.createElement("span");
            wrap.className = "dse-cat-dots";
            wrap.title = cats.map((c) => c.name).join(", ");
            cats.slice(0, 3).forEach((c) => {
              const dot = document.createElement("span");
              dot.className = "dse-cat-dot";
              dot.style.background = c.color;
              wrap.appendChild(dot);
            });
            const textHost = DeepSeekAdapter.findConversationTitleHost(link);
            textHost.insertBefore(wrap, textHost.firstChild);
          });
        },
        mount() {
          this.mountSearchEntry();
          this.mountBatchEntry();
          this.mountCategoryDots();
        }
      };
      const MessageActionUI = {
        mountExportButtons() {
          DeepSeekAdapter.findAssistantMessages().forEach((msg) => {
            const container = DeepSeekAdapter.findMessageContainer(msg);
            if (!container || container.querySelector?.(".dse-msg-export-btn")) return;
            const btn = document.createElement("button");
            btn.type = "button";
            btn.className = "dse-msg-export-btn";
            btn.textContent = "\u5BFC\u51FA";
            btn.title = "\u5BFC\u51FA\u8FD9\u6761\u52A9\u624B\u56DE\u590D";
            btn.onclick = (e) => {
              e.preventDefault();
              e.stopPropagation();
              exportMessageFragment(msg);
            };
            const actionBar = DeepSeekAdapter.findMessageActions(msg);
            if (actionBar) actionBar.appendChild(btn);
            else container.appendChild(btn);
          });
        },
        mount() {
          this.mountExportButtons();
        }
      };
      function mountQuickBar() {
        if (document.getElementById("dse-quickbar")) return;
        const bar = document.createElement("div");
        bar.id = "dse-quickbar";
        [
          ["\u6307\u4EE4", "prompt"],
          ["\u641C\u7D22", "search"],
          ["\u6279\u91CF", "batch"]
        ].forEach(([label, tab]) => {
          const btn = document.createElement("button");
          btn.type = "button";
          btn.textContent = label;
          btn.onclick = (e) => {
            e.preventDefault();
            e.stopPropagation();
            openPanelTab(tab);
          };
          bar.appendChild(btn);
        });
        document.body.appendChild(bar);
      }
      const nativeMountManager = createMountManager(180);
      InlinePromptUI.init();
      mountQuickBar();
      nativeMountManager.register("composer-prompts", () => InlinePromptUI.mount());
      nativeMountManager.register("sidebar-native", () => NativeSidebarUI.mount());
      nativeMountManager.register("message-export", () => MessageActionUI.mount());
      nativeMountManager.observe(document.body);
      setTimeout(() => nativeMountManager.schedule(), 1e3);
      console.log("[DSE] DeepSeek Chat Enhance v4.2.1 loaded");
    });
  })();
})();
