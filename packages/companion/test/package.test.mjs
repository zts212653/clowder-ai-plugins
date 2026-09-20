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
});
