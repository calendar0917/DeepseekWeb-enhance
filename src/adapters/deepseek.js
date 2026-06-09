const selectors = {
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
  codeContent: 'pre, code',
  systemInstructionRoots: '.ds-markdown, .ds-markdown--block, [class*="markdown"], [data-message-author-role="user"]',
};

function splitSelectorList(value) {
  return String(value || '').split(',').map(s => s.trim()).filter(Boolean);
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
    id: 'deepseek',
    name: 'DeepSeek Chat',
    selectors,

    findComposerToolbar() {
      const buttons = Array.from(doc.querySelectorAll(selectors.composerToggles))
        .filter(b => b.id !== 'dse-inline-btn' && b.id !== 'mcp-inline-btn' && typeof b.textContent === 'string');
      const anchorBtn = buttons.find(b =>
        b.textContent.includes('智能搜索') ||
        b.textContent.includes('深度思考') ||
        b.textContent.includes('联网搜索') ||
        b.textContent.includes('DeepThink')
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
      const allEls = Array.from(container.querySelectorAll('*') || []);
      for (let i = allEls.length - 1; i >= 0; i--) {
        const el = allEls[i];
        if (el.querySelectorAll(':scope > button').length >= 1) return el;
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
      const candidates = new Set();
      doc.querySelectorAll(selectors.codeBlockCandidates).forEach(el => {
        candidates.add(el.closest?.(selectors.codeBlockContainers) || el);
      });
      return Array.from(candidates);
    },

    findCodeBanner(block) {
      return queryAny(block, selectors.codeBlockBanner);
    },

    findCodeContentElement(block) {
      if (block?.matches?.('pre')) return block;
      return queryAny(block, selectors.codeContent);
    },

    findCodeActionContainer(block) {
      const banner = this.findCodeBanner(block);
      if (banner) return queryAny(banner, selectors.codeBlockActions) || banner;
      const pre = this.findCodeContentElement(block);
      if (!pre?.parentNode) return null;
      const bar = doc.createElement('div');
      bar.style.cssText = 'display:flex;justify-content:flex-end;gap:4px;margin:4px 0;';
      pre.parentNode.insertBefore(bar, pre);
      return bar;
    },

    findSystemInstructionRoots() {
      return Array.from(doc.querySelectorAll(selectors.systemInstructionRoots));
    },

    findChatContainer() {
      return queryAny(doc, selectors.chatMessageLists) || doc.body;
    },
  };
}

module.exports = { createDeepSeekAdapter, selectors, splitSelectorList };
