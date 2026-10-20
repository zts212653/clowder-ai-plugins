import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { verifyArchive, verifyTargets } from './f202-sign-publish-recovery.mjs';

const manifest = JSON.parse(await readFile(new URL('./f202-publish-recovery-targets.json', import.meta.url)));
const bytes = Buffer.from('reviewed original archive fixture');
const target = { name: '@clowder-ai/xiangqi', version: '0.1.0-alpha.1', size: bytes.length,
  sha256: createHash('sha256').update(bytes).digest('hex'), shasum: createHash('sha1').update(bytes).digest('hex'),
  integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}` };
const packed = { name: target.name, version: target.version, filename: 'clowder-ai-xiangqi-0.1.0-alpha.1.tgz' };

test('accepted nineteen prerelease targets remain frozen', () => verifyTargets(manifest));
test('archive verifier produces the same npm package URL as npm-package-arg', () => {
  assert.equal(verifyArchive(target, packed, bytes).name, 'pkg:npm/%40clowder-ai/xiangqi@0.1.0-alpha.1');
});
test('changed bytes cannot get an original archive signature', () => {
  assert.throws(() => verifyArchive(target, packed, Buffer.from('unreviewed original archive fixture')));
});
test('substituted identity or path cannot be signed', () => {
  assert.throws(() => verifyArchive(target, { ...packed, version: '0.1.0-alpha.2' }, bytes));
  assert.throws(() => verifyArchive(target, { ...packed, filename: '../other.tgz' }, bytes));
});
test('stable release and substituted manifest targets are rejected', () => {
  const altered = structuredClone(manifest); altered.targets[0].version = '1.0.0';
  assert.throws(() => verifyTargets(altered));
  altered.targets[0] = altered.targets[1];
  assert.throws(() => verifyTargets(altered));
});
