import { phase } from './execution.mjs';
import { changeList, entries } from './trees.mjs';

export async function continuousPreview(receiver, delivery) {
  return phase('file-rules', '核对核心变更与声明保留的文件范围', async () => {
    const [base, source, internal] = await Promise.all([
      entries(receiver.git.directory, delivery.base.upstream),
      entries(receiver.git.directory, delivery.target),
      entries(receiver.git.directory, delivery.base.internal),
    ]);
    return {
      changes: changeList(base, source, receiver.config),
      internalChanges: changeList(base, internal, receiver.config),
    };
  });
}
