import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, rmdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fail } from './config.mjs';
import { git } from './process.mjs';

const maxBundle = 80 * 1024 * 1024;
const digest = (data) => createHash('sha256').update(data).digest('hex');
export async function noSymlinks(path) {
  let current = resolve(path);
  while (true) {
    try {
      if ((await lstat(current)).isSymbolicLink())
        fail('TRANSFER_SYMLINK', '迁移文件和目录不能通过符号链接读取或写入。');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const next = dirname(current);
    if (next === current) break;
    current = next;
  }
}
function validRefs(text, auxiliary = false) {
  const refs = text
    .split('\n')
    .filter(Boolean)
    .map((line) => line.split(' '));
  if (
    !refs.length ||
    refs.some(
      ([sha, ref, extra]) =>
        extra ||
        !/^[a-f0-9]{40}$/.test(sha) ||
        (!/^refs\/sync\/[\w/-]+$/.test(ref) && !(auxiliary && /^worktrees\/[\w-]+\/HEAD$/.test(ref))),
    )
  )
    fail('TRANSFER_OBJECT_REFS', '迁移 Git 对象含未识别引用；只允许同步执行器拥有的 refs/sync 引用。');
  const owned = refs.filter(([, ref]) => ref.startsWith('refs/sync/'));
  if (!owned.length) fail('TRANSFER_OBJECT_REFS', '迁移对象包缺少同步执行器引用。');
  return owned;
}
async function noObjectLinks(directory) {
  const pending = [directory];
  let count = 0;
  while (pending.length) {
    for (const entry of await readdir(pending.pop(), { withFileTypes: true })) {
      if (++count > 100000) fail('TRANSFER_TOO_LARGE', '对象目录文件过多，暂停网页迁移。');
      if (entry.isSymbolicLink()) fail('TRANSFER_SYMLINK', 'Git 对象目录包含符号链接，停止导出。');
      if (entry.isDirectory()) pending.push(join(entry.parentPath, entry.name));
    }
  }
}
export function validateObjects(value) {
  if (
    !value ||
    Object.keys(value).some((key) => !['encoding', 'data', 'sha256'].includes(key)) ||
    value.encoding !== 'base64' ||
    typeof value.data !== 'string' ||
    value.data.length > Math.ceil(maxBundle / 3) * 4
  )
    fail('TRANSFER_OBJECT_INVALID', 'Git 对象包格式或大小无效。');
  const bytes = Buffer.from(value.data, 'base64');
  if (
    !bytes.length ||
    bytes.length > maxBundle ||
    bytes.toString('base64') !== value.data ||
    digest(bytes) !== value.sha256
  )
    fail('TRANSFER_OBJECT_INVALID', 'Git 对象包损坏或摘要不匹配。');
  return bytes;
}
export function requiredCommits(files) {
  const ledger = files.find((file) => file.path === 'ledger.json');
  if (!ledger) return [];
  const state = JSON.parse(ledger.content);
  const values = [
    state.initial?.upstream,
    state.initial?.internal,
    state.accepted?.upstream,
    state.accepted?.internal,
    state.latest,
    state.observedInternal,
  ];
  for (const item of [...state.queue, ...state.deliveries]) {
    values.push(
      item.target,
      item.base?.upstream,
      item.base?.internal,
      item.candidate,
      item.acceptedInternal,
      item.repairPlan?.internal,
      item.repairPlan?.previewCommit,
      item.repair?.delivery?.base?.internal,
      item.repair?.delivery?.candidate,
      item.repair?.delivery?.acceptedInternal,
      ...(item.repair?.mappings ?? []).flatMap((mapping) => [mapping.source, mapping.internal]),
      ...(item.repairHistory ?? []).flatMap((old) => [old.delivery.base.internal, old.delivery.candidate, old.plan.previewCommit]),
      ...(item.commits ?? []),
      ...(item.commitMappings ?? []).flatMap((mapping) => [mapping.source, mapping.internal]),
      ...(item.source?.developmentReplay?.commits ?? []),
      ...(item.developmentMappings ?? []).flatMap((mapping) => [mapping.source, mapping.internal]),
    );
  }
  return [...new Set(values.filter((value) => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value)))];
}
async function verifyCommits(directory, required) {
  for (let index = 0; index < required.length; index += 1000) {
    const batch = required.slice(index, index + 1000);
    const result = await git(directory, ['cat-file', '--batch-check=%(objectname) %(objecttype)'], {
      input: `${batch.join('\n')}\n`,
    });
    const rows = result.split('\n');
    if (rows.length !== batch.length || rows.some((row, i) => row !== `${batch[i]} commit`))
      fail('TRANSFER_OBJECT_MISSING', '台账或提交映射引用的 Git commit 缺失；保留原历史，不能导入不完整对象包。');
  }
}
export async function exportObjects(config, required = []) {
  const directory = objectDirectory(config);
  await noSymlinks(directory);
  await noObjectLinks(directory);
  if ((await readFile(join(directory, 'repo-sync-owner'), 'utf8')) !== config.bindingId)
    fail('TRANSFER_OBJECT_OWNER', 'Git 对象目录不属于当前绑定，停止导出。');
  validRefs(await git(directory, ['for-each-ref', '--format=%(objectname) %(refname)']));
  await verifyCommits(directory, required);
  const temporary = await mkdtemp(join(tmpdir(), 'repo-sync-transfer-'));
  const bundle = join(temporary, 'objects.bundle');
  try {
    await git(directory, ['bundle', 'create', bundle, '--all', '--stdin'], { input: `${required.join('\n')}\n` });
    if ((await stat(bundle)).size > maxBundle)
      fail('TRANSFER_TOO_LARGE', 'Git 对象包超过 80 MiB，暂不支持网页迁移；原状态保留。');
    const bytes = await readFile(bundle);
    return { encoding: 'base64', data: bytes.toString('base64'), sha256: digest(bytes) };
  } finally {
    await rm(bundle, { force: true });
    await rmdir(temporary);
  }
}
export async function restoreObjects(value, config, required = []) {
  const bytes = validateObjects(value);
  const temporary = await mkdtemp(join(tmpdir(), 'repo-sync-transfer-'));
  const bundle = join(temporary, 'objects.bundle');
  const directory = objectDirectory(config);
  try {
    await writeFile(bundle, bytes, { mode: 0o600, flag: 'wx' });
    await mkdir(directory, { mode: 0o700 });
    await git(directory, ['init', '--bare', '--template=']);
    await git(directory, ['bundle', 'verify', bundle]);
    const refs = validRefs(await git(directory, ['bundle', 'list-heads', bundle]), true);
    await git(directory, [
      '-c',
      'transfer.fsckObjects=true',
      'fetch',
      '--no-tags',
      bundle,
      ...refs.map(([, ref]) => `${ref}:${ref}`),
    ]);
    await git(directory, ['fsck', '--full', '--no-reflogs']);
    await verifyCommits(directory, required);
    await writeFile(join(directory, 'repo-sync-owner'), config.bindingId, { mode: 0o600, flag: 'wx' });
  } finally {
    await rm(bundle, { force: true });
    await rmdir(temporary);
  }
}
function objectDirectory(config) {
  return join(
    config.stateDir,
    config.mode === 'version' ? `objects-v-${config.bindingId.slice(0, 24)}.git` : 'objects.git',
  );
}
