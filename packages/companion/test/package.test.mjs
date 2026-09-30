import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { validateManifest } from '@clowder-ai/plugin-contract';
import { parse } from 'yaml';

const root = new URL('../', import.meta.url);
test('the installable package declares one companion body and contains a closed browser asset graph', async () => {
  const built = spawnSync(process.execPath, ['scripts/build.mjs'], { cwd: root, encoding: 'utf8' });
  assert.equal(built.status, 0, built.stderr);
  const manifest = JSON.parse(await readFile(new URL('manifest.json', root)));
  const catalogManifest = parse(await readFile(new URL('plugin.yaml', root), 'utf8'));
  assert.deepEqual(catalogManifest, manifest, 'catalog and module consumers read the same generated manifest');
  const pkg = JSON.parse(await readFile(new URL('package.json', root)));
  assert.ok(pkg.files.includes('plugin.yaml'), 'the catalog manifest must reach the published archive');
  assert.equal(validateManifest(manifest).valid, true);
  assert.deepEqual(manifest.runtime, { transport: 'builtin' });
  assert.deepEqual(manifest.features[0].capabilities, ['windows.create']);
  const html = await readFile(new URL('renderer/index.html', root));
  assert.match(html.toString(), /id="listen"[^>]*data-action="listen"[^>]*hidden/u,
    'the package must carry a distinct capability-gated receive-only control');
  assert.match(html.toString(), /id="actions"[^>]*class="[^"]*call-bar[^"]*"/u,
    'the package must carry the persistent active-call bar');
  assert.match(html.toString(), /id="call-state"[^>]*>通话中</u,
    'connection state must remain visible as text instead of a mode-only badge');
  assert.match(html.toString(), /id="begin"[^>]*>[\s\S]*?<span class="label">语音通话<\/span>/u,
    'the primary action must use the approved Voice call product name');
  assert.match(html.toString(), /class="call-recent-label">最新消息<\/small>/u,
    'the call bar must use the approved Latest message label');
  assert.match(html.toString(), /id="call-share-context"/u,
    'the persistent call bar must retain the exact shared target while sharing');
  assert.match(html.toString(), /data-action="stop"[^>]*><span>挂断</u,
    'the persistent call bar must keep an explicit destructive hang-up action');
  assert.match(html.toString(), /id="call-transcript-log"[^>]*role="log"/u,
    'the installable renderer must contain the Host-bound transcript surface');
  assert.equal(manifest.contributions[0].surface.integrity, `sha256-${createHash('sha256').update(html).digest('base64')}`);
  for (const name of await readdir(new URL('renderer/', root))) {
    if (!/\.(html|css|mjs)$/.test(name)) continue;
    const file = new URL(`renderer/${name}`, root);
    const source = await readFile(file, 'utf8');
    assert.doesNotMatch(source, /F317_HOST_API_URL|F317_MEMORY_MCP|window\.live\b|MediaRecorder|localStorage|sessionStorage|node:|https?:\/\/|\/Users\/|RTCPeerConnection|createDataChannel|getUserMedia/, name);
    const refs = name.endsWith('.html') ? [...source.matchAll(/(?:src|href)="([^"]+)"/g)]
      : name.endsWith('.css') ? [...source.matchAll(/url\("([^"]+)"\)/g)]
      : [...source.matchAll(/\bfrom ['"]([^'"]+)['"]/g)];
    for (const [, ref] of refs) { if (ref.startsWith('#')) continue; assert.ok(ref.startsWith('./'), `${name}: ${ref}`); await readFile(new URL(ref, file)); }
  }
});
test('public imagery provenance pins only distributable assets, without private pet metadata', async () => {
  const lock = JSON.parse(await readFile(new URL('source-lock.json', root)));
  assert.match(lock.commit, /^[a-f0-9]{40}$/);
  for (const file of lock.files) {
    const content = await readFile(new URL(file.destination, root));
    assert.equal(createHash('sha256').update(content).digest('hex'), file.sha256);
    assert.doesNotMatch(file.destination, /pet\.json/);
  }
  assert.match(lock.livingSkin.manifestSha256, /^[a-f0-9]{64}$/u);
  assert.equal(lock.livingSkin.files.length, 22, '12 layers, nine clips and layer geometry travel together');
  assert.doesNotMatch(JSON.stringify(lock.livingSkin), /\/Users\/|\/api\/workspace\/file\/raw/u);
  for (const file of lock.livingSkin.files) {
    const content = await readFile(new URL(file.destination, root));
    assert.equal(createHash('sha256').update(content).digest('hex'), file.sha256, file.destination);
    const packed = await readFile(new URL(file.destination.replace(/^assets\//u, 'renderer/'), root));
    assert.deepEqual(packed, content, `${file.destination} must reach the installable renderer`);
  }
});
