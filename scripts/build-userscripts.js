const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');

const ROOT = path.resolve(__dirname, '..');
const ENTRIES = [
  {
    source: 'src/entries/ds-enhance.entry.js',
    rootOut: 'ds-enhance.user.js',
    distOut: 'dist/ds-enhance.user.js',
    requiredHeader: ['@homepageURL', '@supportURL', '@downloadURL', '@updateURL', '@license', '@icon'],
  },
  {
    source: 'src/entries/ds-mcp-bridge.entry.js',
    rootOut: 'ds-mcp-bridge.user.js',
    distOut: 'dist/ds-mcp-bridge.user.js',
    requiredHeader: ['@homepageURL', '@supportURL', '@downloadURL', '@updateURL', '@license', '@icon', '@connect      localhost'],
  },
];

function read(relPath) {
  return fs.readFileSync(path.join(ROOT, relPath), 'utf8');
}

function write(relPath, content) {
  const fullPath = path.join(ROOT, relPath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content);
}

function assertHeader(script, relPath, required) {
  if (!script.startsWith('// ==UserScript==')) {
    throw new Error(`${relPath} missing userscript header`);
  }
  for (const field of required) {
    if (!script.includes(field)) throw new Error(`${relPath} missing metadata: ${field}`);
  }
}

function splitUserscript(script, relPath) {
  const endMarker = '// ==/UserScript==';
  const end = script.indexOf(endMarker);
  if (end < 0) throw new Error(`${relPath} missing userscript header end`);
  const headerEnd = end + endMarker.length;
  const newline = script.slice(headerEnd, headerEnd + 2) === '\r\n' ? '\r\n' : '\n';
  return {
    header: script.slice(0, headerEnd),
    body: script.slice(headerEnd).replace(/^\r?\n/, ''),
    newline,
  };
}

async function bundleBody(relPath, body) {
  const result = await esbuild.build({
    stdin: {
      contents: body,
      resolveDir: path.dirname(path.join(ROOT, relPath)),
      sourcefile: path.basename(relPath),
      loader: 'js',
    },
    bundle: true,
    write: false,
    logLevel: 'silent',
    platform: 'browser',
    format: 'iife',
    target: 'es2020',
  });
  return result.outputFiles[0].text;
}

async function main() {
  for (const entry of ENTRIES) {
    const content = read(entry.source);
    assertHeader(content, entry.source, entry.requiredHeader);
    const parts = splitUserscript(content, entry.source);
    const body = await bundleBody(entry.source, parts.body);
    const built = `${parts.header}${parts.newline}${body}`;
    write(entry.rootOut, built);
    write(entry.distOut, built);
    console.log(`built ${entry.distOut}`);
  }
}

main().catch(err => {
  console.error(err.message);
  process.exit(1);
});
