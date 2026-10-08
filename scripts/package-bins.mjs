import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, lstat, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

export function declaredBins(manifest) {
  const bins = typeof manifest.bin === 'string' ? [manifest.bin] : Object.values(manifest.bin ?? {});
  return [...new Set(bins.map(bin => {
    assert.equal(typeof bin, 'string', 'bin paths must be strings');
    const path = bin.replace(/^\.\//u, '');
    assert.ok(path.length > 0 && !isAbsolute(path) && !/[\\\r\n]/u.test(path)
      && path.split('/').every(part => part !== '..' && part !== '.' && part !== ''), 'bin must be a package-relative file');
    return path;
  }))];
}

export async function normalizePackageBins(packageRoot) {
  const root = await realpath(packageRoot);
  const manifest = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
  for (const bin of declaredBins(manifest)) {
    const path = resolve(root, bin);
    const physical = await realpath(path);
    const rel = relative(root, physical);
    assert.ok(rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel), 'bin must stay inside its package');
    assert.ok((await lstat(path)).isFile(), 'bin must be a regular file');
    await chmod(path, 0o755);
  }
}

export function assertArchiveBins(manifest, archive) {
  const bins = declaredBins(manifest);
  if (bins.length === 0) return;
  const options = { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 };
  const names = execFileSync('tar', ['-tzf', archive], options).trimEnd().split('\n');
  const details = execFileSync('tar', ['-tvzf', archive], options).trimEnd().split('\n');
  assert.equal(names.length, details.length, 'archive listings must agree');
  for (const bin of bins) {
    const member = `package/${bin}`;
    const index = names.indexOf(member);
    assert.ok(index >= 0, `archive is missing declared bin ${member}`);
    assert.equal(names.lastIndexOf(member), index, `archive repeats bin ${member}`);
    assert.match(details[index], /^-rwxr-xr-x\s/u, `archive bin must be a regular executable 0755 file: ${member}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(await realpath(process.argv[1])).href) {
  await normalizePackageBins(process.cwd());
}
