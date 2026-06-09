const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const fixture = fs.readFileSync(path.join(ROOT, 'tests/fixtures/deepseek-chat.html'), 'utf8');
const enhanceSource = fs.readFileSync(path.join(ROOT, 'dist/ds-enhance.user.js'), 'utf8');
const bridgeSource = fs.readFileSync(path.join(ROOT, 'dist/ds-mcp-bridge.user.js'), 'utf8');

function hasSelector(selector) {
  if (selector.includes('a[href*="/s/"]')) return /<a\s+href="[^"]*\/s\//.test(fixture);
  if (selector.includes('.ds-toggle-button')) return fixture.includes('class="ds-toggle-button"');
  if (selector.includes('[class*="action"]')) return fixture.includes('message-action-toolbar');
  if (selector.includes('[class*="toolbar"]')) return fixture.includes('message-action-toolbar') || fixture.includes('composer-toolbar');
  if (selector.includes('[class*="buttons"]')) return false;
  if (selector.includes('[class*="footer"]')) return false;
  if (selector.includes('textarea')) return fixture.includes('<textarea');
  return false;
}

test('DeepSeek fixture preserves native composer sidebar and message mount anchors', () => {
  assert.equal(hasSelector('.ds-toggle-button, [class*="ds-toggle-button"]'), true);
  assert.equal(hasSelector('a[href*="/s/"]'), true);
  assert.equal(hasSelector('[class*="action"], [class*="toolbar"], [class*="buttons"], [class*="footer"]'), true);
  assert.equal(hasSelector('textarea, [contenteditable="true"][placeholder]'), true);
});

test('built userscripts keep adapter selectors compatible with DeepSeek fixture', () => {
  assert.match(enhanceSource, /composerToggles: '\.ds-toggle-button, \[class\*="ds-toggle-button"\]'/);
  assert.match(enhanceSource, /conversationLinks: 'a\[href\*="\/s\/"\]'/);
  assert.match(bridgeSource, /composerToggles: '\.ds-toggle-button, \[class\*="ds-toggle-button"\]'/);
  assert.match(bridgeSource, /messageActions: '\[class\*="action"\], \[class\*="toolbar"\], \[class\*="buttons"\], \[class\*="footer"\]'/);
});
