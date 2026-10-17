import { fail } from './config.mjs';
import { git } from './process.mjs';
import { entries } from './trees.mjs';

export async function baselineFile(receiver, input) {
  if (
    !/^[a-f0-9]{40}$/.test(input.upstream ?? '') ||
    !/^[a-f0-9]{40}$/.test(input.internal ?? '') ||
    typeof input.path !== 'string'
  )
    fail('INVALID_BASELINE_FILE', '需要核验报告中的两侧完整 commit 与文件路径');
  const [source, local] = await Promise.all([
    entries(receiver.git.directory, input.upstream),
    entries(receiver.git.directory, input.internal),
  ]);
  if (!source.has(input.path) && !local.has(input.path))
    fail('BASELINE_FILE_MISSING', '该路径不在两侧提交中，请重新核验');
  const read = async (entry) => {
    if (!entry) return { exists: false, content: '此版本没有该文件' };
    if (entry.type !== 'blob' || !['100644', '100755'].includes(entry.mode))
      return { exists: true, mode: entry.mode, content: '该文件类型不能作为文本预览；请在内部环境查看' };
    const size = Number(await git(receiver.git.directory, ['cat-file', '-s', entry.object]));
    if (size > 131072)
      return { exists: true, mode: entry.mode, content: '文件超过 128 KiB，请在内部环境查看；文件归属仍需明确确认' };
    const value = await git(receiver.git.directory, ['cat-file', 'blob', entry.object], { binary: true });
    const content = value.toString('utf8');
    return {
      exists: true,
      mode: entry.mode,
      content:
        value.includes(0) || !Buffer.from(content).equals(value) ? '二进制或非 UTF-8 文件，请在内部环境查看' : content,
    };
  };
  return {
    path: input.path,
    upstream: await read(source.get(input.path)),
    internal: await read(local.get(input.path)),
  };
}
