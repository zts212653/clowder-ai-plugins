import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fail } from './config.mjs';
import { phase } from './execution.mjs';
import { GitReceiver } from './git.mjs';
import { matches } from './policy.mjs';
import { git } from './process.mjs';
import { assertProjection, entries } from './trees.mjs';

export class VersionGitReceiver extends GitReceiver {
  constructor(config) {
    super(config);
    this.directory = join(config.stateDir, `objects-v-${config.bindingId.slice(0, 24)}.git`);
  }
  async baseline(upstream, internal) {
    return assertProjection(this.directory, upstream, internal, this.config);
  }
  async candidate(accepted, target, id) {
    const { source, local } = await this.baseline(accepted.upstream, accepted.internal);
    if (!(await this.isAncestor(accepted.upstream, target))) fail('VERSION_NOT_FORWARD', '目标版本不包含上次接收版本');
    await this.checkContent(target);
    await this.checkContent(accepted.internal);
    const incoming = await entries(this.directory, target);
    const folder = join(this.config.stateDir, 'version-build', id);
    await mkdir(folder, { recursive: true });
    const env = {
      ...process.env,
      GIT_INDEX_FILE: join(folder, 'index'),
      GIT_WORK_TREE: folder,
      GIT_TERMINAL_PROMPT: '0',
    };
    const index = (args) =>
      import('./process.mjs').then(({ command }) => command('git', ['-C', this.directory, ...args], { env }));
    await index(['read-tree', target]);
    await phase('internal-preserve', '保留内部专有文件', () =>
      preserveFiles(index, source, local, incoming, this.config.internalPaths),
    );
    const tree = await index(['write-tree']);
    const head = await this.mergeNode(tree, [accepted.internal], `repo-sync version ${id}`);
    await git(this.directory, ['update-ref', `refs/sync/deliveries/${id}`, head]);
    return head;
  }
  async verify(delivery, actual) {
    if (!(await this.sameTree(delivery.candidate, actual)))
      fail('TREE_MISMATCH', '实际 main 与已检查的版本候选文件树不一致');
    for (const sha of [delivery.base.internal, delivery.candidate]) {
      if (!(await this.isAncestor(sha, actual))) fail('HISTORY_REWRITTEN', '版本候选或内部基线没有完整接受');
    }
    if (actual !== delivery.candidate) {
      const parents = (await git(this.directory, ['rev-list', '--parents', '-n', '1', actual])).split(' ').slice(1);
      if (parents.length !== 2 || parents[0] !== delivery.base.internal || parents[1] !== delivery.candidate)
        fail('MERGE_BASE_HEAD_MISMATCH', '实际合入的版本 PR 与冻结 base/head 不匹配');
    }
    await this.baseline(delivery.target, actual);
  }
}
async function preserveFiles(index, source, local, incoming, rules) {
  for (const rule of rules) {
    const previous = [...source.keys()].some((path) => matches(path, rule));
    const paths = [...incoming.keys()].filter((path) => matches(path, rule));
    if (!previous && paths.length)
      fail('INTERNAL_PATH_COLLISION', '上游新增了内部保留路径，请处理命名冲突后重新发起', { paths });
    for (const path of paths) await index(['update-index', '--force-remove', '--', path]);
    for (const [path, entry] of local) {
      if (matches(path, rule)) {
        const collision = [...incoming.keys()].find(
          (targetPath) =>
            !matches(targetPath, rule) && (path.startsWith(`${targetPath}/`) || targetPath.startsWith(`${path}/`)),
        );
        if (collision)
          fail('INTERNAL_PATH_COLLISION', '上游文件与内部保留目录发生结构冲突', { paths: [path, collision] });
        await index(['update-index', '--add', '--cacheinfo', entry.mode, entry.object, path]);
      }
    }
  }
}
