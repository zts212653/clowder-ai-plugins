import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fail } from './config.mjs';
import { phase } from './execution.mjs';
import { matches } from './policy.mjs';
import { command } from './process.mjs';
import { entries } from './trees.mjs';

export async function preservedTree(receiver, target, internal, id) {
  const rules = receiver.config.internalPaths ?? [];
  if (!rules.length) return receiver.tree(target);
  return phase('internal-preserve', '保留声明的内部文件和不存在状态', async () => {
    const [source, local] = await Promise.all([
      entries(receiver.directory, target),
      entries(receiver.directory, internal),
    ]);
    const preserved = (path) => rules.some((rule) => matches(path, rule));
    const core = [...source.keys()].filter((path) => !preserved(path));
    const kept = [...local].filter(([path]) => preserved(path));
    for (const [path] of kept) {
      const collision = core.find((other) => other.startsWith(`${path}/`) || path.startsWith(`${other}/`));
      if (collision)
        fail('INTERNAL_PATH_COLLISION', '保留文件与上游核心目录发生结构冲突，请核对具体路径；候选未发布', {
          paths: [path, collision],
        });
    }
    const folder = join(receiver.config.stateDir, 'preserved-trees', id);
    await mkdir(folder, { recursive: true });
    const env = {
      ...process.env,
      GIT_WORK_TREE: folder,
      GIT_INDEX_FILE: join(folder, `${randomUUID()}.index`),
      GIT_TERMINAL_PROMPT: '0',
    };
    const index = (args) => command('git', ['-C', receiver.directory, ...args], { env });
    await index(['read-tree', target]);
    for (const path of source.keys()) if (preserved(path)) await index(['update-index', '--force-remove', '--', path]);
    for (const [path, entry] of kept)
      await index(['update-index', '--add', '--cacheinfo', entry.mode, entry.object, path]);
    return index(['write-tree']);
  });
}

export async function preservedInternalHead(receiver, state, head) {
  if (head === state.accepted.internal) return;
  if (!receiver.config.internalPaths?.length || !(await receiver.git.isAncestor(state.accepted.internal, head)))
    fail('CORE_DRIFT', '内部 main 与已接受版本不同，请核对原交付或内部修复 PR');
  await receiver.git.baseline(state.accepted.upstream, head);
  state.accepted.internal = head;
  state.observedInternal = head;
  state.events.push({
    time: new Date().toISOString(),
    deliveryId: null,
    message: '已核验并接管仅保留路径中的内部提交；外部游标保持不变',
  });
}
