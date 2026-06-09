function injectStyle(documentRef, cssText) {
  const style = documentRef.createElement('style');
  style.textContent = cssText;
  documentRef.head.appendChild(style);
  return style;
}

function createToast(documentRef, options = {}) {
  const colors = {
    info: '#2a2a3e',
    success: '#0d3320',
    error: '#3d0f0f',
    ...(options.colors || {}),
  };
  const duration = options.duration || 3500;

  return function toast(msg, type = 'info') {
    const el = documentRef.createElement('div');
    el.style.cssText = `position:fixed;bottom:24px;right:24px;z-index:2000001;background:${colors[type] || colors.info};color:#eee;padding:12px 22px;border-radius:10px;font-size:14px;box-shadow:0 4px 20px rgba(0,0,0,.5);font-family:system-ui;transition:opacity .3s;`;
    el.textContent = msg;
    documentRef.body.appendChild(el);
    setTimeout(() => { el.style.opacity = '0'; setTimeout(() => el.remove(), 300); }, duration);
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
  let left = options.align === 'right' ? rect.right - width : rect.left;

  if (left + width > view.innerWidth - margin) left = view.innerWidth - width - margin;
  if (left < margin) left = margin;
  panel.style.left = left + 'px';

  if (typeof options.topMargin === 'number') {
    const topMargin = options.topMargin;
    const spaceAbove = rect.top - gap - topMargin;
    const maxHeight = Math.min(view.innerHeight * (options.maxHeightRatio || 0.75), view.innerHeight - 2 * topMargin);
    if (spaceAbove >= (options.minSpaceAbove || 200)) {
      panel.style.bottom = (view.innerHeight - rect.top + gap) + 'px';
      panel.style.top = 'auto';
    } else {
      panel.style.top = topMargin + 'px';
      panel.style.bottom = 'auto';
    }
    panel.style.maxHeight = maxHeight + 'px';
    return;
  }

  panel.style.bottom = (view.innerHeight - rect.top + gap) + 'px';
  panel.style.top = 'auto';
}

function createModal(documentRef, options = {}) {
  const backdrop = documentRef.createElement('div');
  backdrop.className = options.backdropClass || 'dse-modal-bg';
  if (options.html) backdrop.innerHTML = options.html;

  const box = options.box || backdrop.querySelector?.(options.boxSelector || '.dse-modal-box') || null;
  const close = () => backdrop.remove();
  if (options.closeOnBackdrop !== false) {
    backdrop.onclick = event => { if (event.target === backdrop) close(); };
  }
  documentRef.body.appendChild(backdrop);
  return { backdrop, box, close };
}

module.exports = { createModal, createToast, injectStyle, positionFloatingPanel };
