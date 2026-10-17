import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';

export const digest = text => createHash('sha256').update(text).digest('hex');
function safePath(root, relative) {
  if (isAbsolute(relative) || relative.split(/[\\/]/).some(x => x === '..')) throw new Error('Invalid export path');
  const base = resolve(root); const path = resolve(base, relative);
  if (!path.startsWith(base + sep)) throw new Error('Invalid export path');
  let cursor = path;
  while (cursor !== base) {
    if (lstatSync(cursor, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error('Symlinks are not export targets');
    cursor = dirname(cursor);
  }
  return path;
}
function json(path) { return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null; }
function atomic(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  const temp = path + `.sync-${process.pid}`;
  writeFileSync(temp, text, { flag: 'wx' }); renameSync(temp, path);
}
export function verify(dest) {
  const state = json(safePath(dest, 'sync-state.json'));
  if (!state || state.version !== 1) throw new Error('Missing/unsupported sync receipt');
  for (const file of state.files) {
    const path = safePath(dest, file.target);
    if (!existsSync(path) || digest(readFileSync(path)) !== file.targetHash) {
      throw new Error(`Destination changed: ${file.target}. Reconcile the public contribution before syncing.`);
    }
  }
  return state;
}
export function synchronize({ source, dest, ref, mappings, mode = 'check' }) {
  if (!['check', 'write'].includes(mode)) throw new Error('Unknown sync mode');
  if (!/^[a-f0-9]{40}$/.test(ref)) throw new Error('An exact 40-character SHA is required');
  const policy = json(safePath(dest, 'sync-policy.json'));
  if (policy && policy.mode !== 'core-export') throw new Error('Core export is retired; develop in Plugins');
  const git = (...args) => execFileSync('git', ['-C', resolve(source), ...args], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  git('cat-file', '-e', `${ref}^{commit}`);
  const changedSource = git('status', '--porcelain', '--', ...mappings.map(x => x.source));
  if (changedSource.trim()) throw new Error('Source has uncommitted mapped files; commit the optimization first');
  const statePath = safePath(dest, 'sync-state.json');
  const previous = existsSync(statePath) ? verify(dest) : null;
  const targets = new Set(mappings.map(x => x.target));
  if (targets.size !== mappings.length) throw new Error('Duplicate export target');
  for (const old of previous?.files ?? []) {
    if (!targets.has(old.target)) throw new Error(`Mapping removed: ${old.target}; use an explicit reviewed migration`);
  }
  const files = mappings.map(map => {
    const path = safePath(dest, map.target);
    if (existsSync(path) && !previous?.files.some(x => x.target === map.target)) {
      throw new Error(`Destination changed/unowned: ${map.target}`);
    }
    const entry = git('ls-tree', ref, '--', map.source);
    if (!entry.startsWith('100644 blob ') && !entry.startsWith('100755 blob ')) throw new Error(`Source is not a regular tracked file: ${map.source}`);
    const raw = git('show', `${ref}:${map.source}`);
    const content = map.transform(raw);
    if (typeof content !== 'string') throw new Error('Invalid export transform');
    return { source: map.source, target: map.target, sourceHash: digest(raw), targetHash: digest(content), content, path };
  });
  const changed = files.filter(x => !existsSync(x.path) || digest(readFileSync(x.path)) !== x.targetHash).map(x => x.target);
  const next = { version: 1, sourceRepository: 'https://github.com/zts212653/clowder-ai', sourceCommit: ref,
    files: files.map(({ source, target, sourceHash, targetHash }) => ({ source, target, sourceHash, targetHash })) };
  const receipt = JSON.stringify(next, null, 2) + '\n';
  const outdated = changed.length || !existsSync(statePath) || readFileSync(statePath, 'utf8') !== receipt;
  if (mode === 'check' && outdated) throw new Error(`Export out of date: ${changed.join(', ') || 'source receipt'}`);
  if (mode === 'write' && outdated) {
    // Complete every read/transform/conflict check before the first mutation; receipt commits last.
    for (const f of files) if (changed.includes(f.target)) atomic(f.path, f.content);
    atomic(statePath, receipt);
  }
  return { sourceCommit: ref, changed };
}
