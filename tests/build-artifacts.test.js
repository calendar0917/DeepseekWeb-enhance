const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const FILES = ['ds-enhance.user.js', 'ds-mcp-bridge.user.js'];

test('userscript build artifacts are synchronized with src entries', () => {
  for (const filename of FILES) {
    const entryName = filename.replace('.user.js', '.entry.js');
    const source = fs.readFileSync(path.join(ROOT, 'src/entries', entryName), 'utf8');
    const root = fs.readFileSync(path.join(ROOT, filename), 'utf8');
    const dist = fs.readFileSync(path.join(ROOT, 'dist', filename), 'utf8');
    const sourceVersion = source.match(/@version\s+([^\n]+)/)?.[1].trim();
    const distVersion = dist.match(/@version\s+([^\n]+)/)?.[1].trim();
    assert.equal(root, dist, `${filename} root artifact differs from dist`);
    assert.equal(distVersion, sourceVersion, `${filename} version differs from source entry`);
    assert.match(dist, /^\/\/ ==UserScript==/);
    assert.match(dist, /function createMountManager/);
  }
});
