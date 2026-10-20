import { fail } from './config.mjs';
import { category } from './policy.mjs';
import { git } from './process.mjs';

export async function entries(directory, sha) {
  const text = await git(directory, ['ls-tree', '-rz', sha]);
  return new Map(
    text
      .split('\0')
      .filter(Boolean)
      .map((line) => {
        const tab = line.indexOf('\t');
        const [mode, type, object] = line.slice(0, tab).split(' ');
        return [line.slice(tab + 1), { mode, type, object }];
      }),
  );
}
export const equalEntry = (a, b) => a?.mode === b?.mode && a?.type === b?.type && a?.object === b?.object;
export async function assertProjection(directory, upstream, internal, policy, code = 'UNAPPROVED_DIFFERENCE') {
  const [source, local] = await Promise.all([entries(directory, upstream), entries(directory, internal)]);
  const differences = changeList(source, local, policy).map((item) => ({
    ...item,
    blocking: item.category === 'upstream',
    sourceMode: source.get(item.path)?.mode ?? null,
    internalMode: local.get(item.path)?.mode ?? null,
  }));
  const changed = differences.filter((item) => item.blocking);
  if (changed.length)
    fail(
      code,
      code === 'BASELINE_MISMATCH'
        ? 'U0 与 I0 的核心范围不一致。请核对上次同步版本或通过内部修复 PR 恢复；仅明确声明的保留路径允许差异'
        : '内部同步范围存在未声明的修改，请在当前步骤处理差异后重新核验',
      {
        paths: changed.map((item) => item.path),
        differences,
        upstream,
        internal,
      },
    );
  return { source, local };
}
export function changeList(before, after, policy) {
  return [...new Set([...before.keys(), ...after.keys()])]
    .sort()
    .filter((path) => !equalEntry(before.get(path), after.get(path)))
    .map((path) => ({
      path,
      kind: !before.has(path) ? 'added' : !after.has(path) ? 'deleted' : 'modified',
      category: category(path, policy),
    }));
}
