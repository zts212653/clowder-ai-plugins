import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { fixture } from './service-fixture.js';

test('published archive installs alone and retains feedback across activations', async t => {
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  const temporary = await mkdtemp(join(tmpdir(), 'clowder-feedback-consumer-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const consumer = join(temporary, 'consumer');
  await mkdir(consumer);
  await writeFile(join(consumer, 'package.json'), '{"private":true,"type":"module"}');
  const packed = spawnSync(process.execPath,
    [join(root, 'scripts/pack-publish-artifact.mjs'), 'packages/feedback', temporary],
    { cwd: root, encoding: 'utf8' });
  assert.equal(packed.status, 0, packed.stderr);
  const [artifact] = JSON.parse(packed.stdout);
  const archive = join(temporary, artifact.filename);
  const metadata = spawnSync('tar', ['-xOf', archive, 'package/package.json'], { encoding: 'utf8' });
  assert.equal(metadata.status, 0, metadata.stderr);
  assert.doesNotMatch(metadata.stdout, /"workspace:/u, 'published metadata must resolve outside the workspace');
  const args = ['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false', archive];
  const installed = process.env.CLOWDER_ARTIFACT_NPM_CLI
    ? spawnSync(process.execPath, [process.env.CLOWDER_ARTIFACT_NPM_CLI, ...args], { cwd: consumer, encoding: 'utf8' })
    : spawnSync('npm', args, { cwd: consumer, encoding: 'utf8' });
  assert.equal(installed.status, 0, installed.stderr);
  const entry: typeof import('../dist/index.js') = await import(pathToFileURL(join(consumer, 'node_modules/@clowder-ai/feedback/dist/index.js')).href);
  const f = fixture();
  const active = await entry.default.create().start(f.host);
  const request = async (activation: typeof active, input: object) => {
    const response = await activation.actions['feedback.http'](
      { request: { method: 'POST', path: 'feedback', body: input } }, undefined, f.ctx);
    assert.equal(response.status, 200);
    return JSON.parse(Buffer.concat((await Array.fromAsync(response.body)).map(chunk => Buffer.from(chunk))).toString());
  };
  const saved = await request(active, { op: 'save', targetId: 'clowder',
    report: { kind: 'bug', title: 'Installed feedback', body: 'Retained draft', attachments: [] } });
  await active.stop();
  const reopened = await entry.default.create().start(f.host);
  const restored = await request(reopened, { op: 'bootstrap', feedbackId: saved.journal.id });
  assert.equal(restored.journal.report.body, 'Retained draft');
  assert.equal(restored.items.length, 1);
  const page = await reopened.actions['feedback.panel'](
    { request: { method: 'GET', path: 'panel' } }, undefined, { ...f.ctx, operation: 'read' });
  assert.equal(page.status, 200);
  assert.match(page.body, /<!doctype html>/iu);
  assert.match(await readFile(join(consumer, 'node_modules/@clowder-ai/feedback/plugin.yaml'), 'utf8'), /official\.feedback/u);
  await reopened.stop();
});
