const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const FILES = ['ds-enhance.user.js', 'ds-mcp-bridge.user.js'];
const REQUIRED_COMMON = ['@homepageURL', '@supportURL', '@downloadURL', '@updateURL', '@license', '@icon', '@match        https://chat.deepseek.com/*'];

function read(relPath) {
  return fs.readFileSync(path.join(ROOT, relPath), 'utf8');
}

function headerOf(script) {
  const end = script.indexOf('// ==/UserScript==');
  if (end < 0) throw new Error('missing userscript header end');
  return script.slice(0, end);
}

function field(header, name) {
  const re = new RegExp(`^//\\s+${name}\\s+(.+)$`, 'm');
  return header.match(re)?.[1]?.trim() || '';
}

function assertIncludes(text, needle, context) {
  if (!text.includes(needle)) throw new Error(`${context} missing ${needle}`);
}

function main() {
  const pkg = JSON.parse(read('package.json'));
  const readme = read('README.md');
  const changelog = read('CHANGELOG.md');
  const release = read('RELEASE.md');
  read('docs/storage-migration.md');
  read('docs/manual-smoke.md');
  const versions = new Set();

  for (const filename of FILES) {
    const root = read(filename);
    const dist = read(path.join('dist', filename));
    if (root !== dist) throw new Error(`${filename} differs from dist artifact`);

    const header = headerOf(root);
    for (const item of REQUIRED_COMMON) assertIncludes(header, item, filename);
    const version = field(header, '@version');
    if (!version) throw new Error(`${filename} missing @version`);
    versions.add(version);
    assertIncludes(readme, `https://raw.githubusercontent.com/calendar0917/DeepseekWeb-enhance/main/${filename}`, 'README raw links');
    assertIncludes(changelog, `## [${version}]`, 'CHANGELOG');
  }

  assertIncludes(readme, 'docs/storage-migration.md', 'README');
  assertIncludes(readme, 'docs/manual-smoke.md', 'README');
  assertIncludes(release, 'docs/manual-smoke.md', 'RELEASE');
  assertIncludes(release, 'docs/storage-migration.md', 'RELEASE');

  if (versions.size !== 1) throw new Error(`userscript versions differ: ${Array.from(versions).join(', ')}`);
  const [version] = Array.from(versions);
  if (pkg.version !== version) throw new Error(`package version ${pkg.version} does not match userscript version ${version}`);

  const bridgeHeader = headerOf(read('ds-mcp-bridge.user.js'));
  assertIncludes(bridgeHeader, '@connect      localhost', 'DS MCP Bridge');
  assertIncludes(bridgeHeader, '@connect      127.0.0.1', 'DS MCP Bridge');
  console.log(`release metadata ok: ${version}`);
}

try {
  main();
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
