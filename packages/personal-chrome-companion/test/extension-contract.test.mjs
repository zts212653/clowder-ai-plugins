import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const extension = new URL('../extension/', import.meta.url);

async function source(name) {
  return readFile(new URL(name, extension), 'utf8');
}

test('ships an MV3 extension with only the narrow F247 ChatGPT + Native Messaging surface', async () => {
  const manifest = JSON.parse(await source('manifest.json'));

  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.key, undefined, 'signed extension identity remains an admission concern');
  assert.deepEqual(manifest.permissions, ['nativeMessaging', 'tabs']);
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

test('extension source has no focus, navigation, cookie, debugger, private API, or storage escape hatch', async () => {
  const combined = await Promise.all(
    ['service-worker.js', 'content-script.js', 'chatgpt-page-adapter.mjs'].map(source),
  ).then(parts => parts.join('\n'));

  for (const forbidden of [
    'tabs.update',
    'tabs.create',
    'tabs.reload',
    'tabs.highlight',
    'tabs.move',
    'windows.update',
    'windows.create',
    'chrome.cookies',
    'chrome.debugger',
    'chrome.scripting',
    'chrome.storage',
    'fetch(',
    'XMLHttpRequest',
  ]) {
    assert.doesNotMatch(combined, new RegExp(forbidden.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  assert.match(await source('service-worker.js'), /chrome\.tabs\.query\(\{ url: `https:\/\/chatgpt\.com\/c\/\$\{request\.conversationId\}\*` \}\)/);
  assert.match(await source('service-worker.js'), /chrome\.tabs\.sendMessage\(matches\[0\]\.id, request\)/);
});
