import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { synchronize } from '../scripts/sync-engine.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'issue-export-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, 'source'); const dest = join(root, 'dest');
  mkdirSync(source); mkdirSync(dest);
  const git = (...args) => execFileSync('git', args, { cwd: source, encoding: 'utf8' }).trim();
  git('init', '-q'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.test');
  writeFileSync(join(source, 'model.ts'), 'export const value = 1;\n');
  git('add', '.'); git('-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'fixture');
  const ref = git('rev-parse', 'HEAD');
  const mappings = [{ source: 'model.ts', target: 'src/model.ts', transform: x => x }];
  const options = { source, dest, ref, mappings, mode: 'write' };
  return { ...options, options, git };
}
test('exports a frozen commit, detects stale cut in check mode and stays idempotent', t => {
  const f = fixture(t);
  assert.throws(() => synchronize({ ...f.options, mode: 'check' }), /out of date/i);
  assert.equal(synchronize(f.options).changed.length, 1);
  const receipt = readFileSync(join(f.dest, 'sync-state.json'), 'utf8');
  assert.equal(synchronize(f.options).changed.length, 0);
  assert.equal(readFileSync(join(f.dest, 'sync-state.json'), 'utf8'), receipt);
  writeFileSync(join(f.source, 'model.ts'), 'export const value = 2;\n');
  f.git('add', '.'); f.git('-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'next');
  const ref = f.git('rev-parse', 'HEAD');
  assert.throws(() => synchronize({ ...f.options, ref, mode: 'check' }), /out of date/i);
  synchronize({ ...f.options, ref });
  assert.match(readFileSync(join(f.dest, 'src/model.ts'), 'utf8'), /value = 2/);
});
test('public-side edits are never silently overwritten', t => {
  const f = fixture(t); synchronize(f.options);
  writeFileSync(join(f.dest, 'src/model.ts'), 'public contribution\n');
  assert.throws(() => synchronize(f.options), /destination.*changed/i);
  assert.equal(readFileSync(join(f.dest, 'src/model.ts'), 'utf8'), 'public contribution\n');
});
test('dirty sources, unpinned refs and retired sync mode cannot export', t => {
  const f = fixture(t);
  assert.throws(() => synchronize({ ...f.options, ref: 'HEAD' }), /40.*SHA/i);
  writeFileSync(join(f.source, 'model.ts'), 'uncommitted change');
  assert.throws(() => synchronize(f.options), /uncommitted/i);
  f.git('restore', 'model.ts');
  writeFileSync(join(f.dest, 'sync-policy.json'), JSON.stringify({ mode: 'plugin-native' }));
  assert.throws(() => synchronize(f.options), /retired/i);
});

test('a later transform failure leaves every earlier output and receipt unchanged', t => {
  const f = fixture(t); synchronize(f.options);
  const output = readFileSync(join(f.dest, 'src/model.ts'), 'utf8');
  const receipt = readFileSync(join(f.dest, 'sync-state.json'), 'utf8');
  const mappings = [
    { ...f.mappings[0], transform: () => 'updated' },
    { source: 'model.ts', target: 'src/second.ts', transform: () => { throw new Error('changed source seam'); } },
  ];
  assert.throws(() => synchronize({ ...f.options, mappings }), /changed source seam/);
  assert.equal(readFileSync(join(f.dest, 'src/model.ts'), 'utf8'), output);
  assert.equal(readFileSync(join(f.dest, 'sync-state.json'), 'utf8'), receipt);
  assert.equal(existsSync(join(f.dest, 'src/second.ts')), false);
});
test('dangling symlink outputs are refused before creating any package files', t => {
  const f = fixture(t);
  mkdirSync(join(f.dest, 'src'));
  symlinkSync(join(f.dest, 'missing'), join(f.dest, 'src/model.ts'));
  assert.throws(() => synchronize(f.options), /symlinks/i);
  assert.equal(existsSync(join(f.dest, 'sync-state.json')), false);
});
