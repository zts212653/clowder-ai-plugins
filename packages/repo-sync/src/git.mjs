import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { commitPolicy } from './commit-policy.mjs';
import { fail } from './config.mjs';
import { phase } from './execution.mjs';
import { captureGitPr } from './git-pr.mjs';
import { preservedTree } from './preserved-tree.mjs';
import { ancestor, command, git, gitEnvironment } from './process.mjs';
import { remoteHeads } from './remote-heads.mjs';
import { assertProjection } from './trees.mjs';

export class GitReceiver {
  constructor(config) {
    this.config = config;
    this.directory = join(config.stateDir, 'objects.git');
  }
  async ready() {
    await mkdir(this.directory, { recursive: true });
    const marker = join(this.directory, 'repo-sync-owner');
    try {
      if ((await readFile(marker, 'utf8')) !== this.config.bindingId)
        fail('OBJECT_STORE_OWNER_CONFLICT', 'Git 对象目录属于其他绑定');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      if ((await readdir(this.directory)).length)
        fail('OBJECT_STORE_NOT_OWNED', '对象目录已有内容且不属于本执行器，暂停');
      await writeFile(marker, this.config.bindingId, { mode: 0o600 });
    }
    await git(this.directory, ['init', '--bare']);
  }
  heads() {
    return remoteHeads(this.config);
  }
  async fetch() {
    await this.heads();
    await phase('object-store', '准备私有对象目录', () => this.ready());
    const c = this.config;
    const options = { timeout: c.timeouts?.fetch ?? 600000 };
    await phase('source-fetch', '下载外部对象', () =>
      git(
        this.directory,
        ['fetch', '--progress', '--no-tags', c.sourceUrl, `+refs/heads/${c.sourceBranch}:refs/sync/source`],
        options,
      ),
    );
    await phase('internal-fetch', '下载内部对象', () =>
      git(
        this.directory,
        ['fetch', '--progress', '--no-tags', c.internalUrl, `+refs/heads/${c.targetBranch}:refs/sync/internal`],
        options,
      ),
    );
    return { upstream: await this.sha('refs/sync/source'), internal: await this.sha('refs/sync/internal') };
  }
  async sha(ref) {
    if (typeof ref !== 'string' || (!/^[0-9a-f]{40}$/.test(ref) && !/^refs\/sync\/[\w/-]+$/.test(ref)))
      fail('INVALID_REF', '仅允许完整 SHA 或执行器内部 ref');
    return git(this.directory, ['rev-parse', '--verify', `${ref}^{commit}`]);
  }
  async tree(ref) {
    return git(this.directory, ['rev-parse', `${await this.sha(ref)}^{tree}`]);
  }
  async sameTree(a, b) {
    return (await this.tree(a)) === (await this.tree(b));
  }
  async baseline(upstream, internal) {
    return assertProjection(
      this.directory,
      upstream,
      internal,
      { internalPaths: this.config.internalPaths ?? [], mergePaths: [] },
      'BASELINE_MISMATCH',
    );
  }
  async isAncestor(a, b) {
    return ancestor(this.directory, await this.sha(a), await this.sha(b));
  }
  async mainBoundary(commit, head) {
    return (await git(this.directory, ['rev-list', '--first-parent', head])).split('\n').includes(commit);
  }
  async checkContent(target) {
    const paths = await git(this.directory, ['ls-tree', '-r', '--name-only', target]);
    const modes = await git(this.directory, ['ls-tree', '-r', target]);
    if (paths.split('\n').includes('.gitmodules') || /^160000 /m.test(modes))
      fail('SUBMODULE_UNSUPPORTED', '首版未支持子模块，暂停接收');
    for (const path of paths.split('\n').filter((item) => item.endsWith('.gitattributes'))) {
      const attributes = await git(this.directory, ['show', `${target}:${path}`]);
      if (/filter\s*=\s*lfs/.test(attributes)) fail('LFS_UNSUPPORTED', '首版未支持 LFS，暂停接收');
    }
  }
  async mergeNode(tree, parents, message) {
    const args = ['-c', 'user.name=Repository Sync', '-c', 'user.email=repo-sync@localhost', 'commit-tree', tree];
    for (const parent of parents) args.push('-p', parent);
    args.push('-m', message);
    const { identity } = commitPolicy(this.config);
    return git(this.directory, args, {
      env: {
        ...gitEnvironment(),
        GIT_AUTHOR_NAME: identity.name,
        GIT_AUTHOR_EMAIL: identity.email,
        GIT_COMMITTER_NAME: identity.name,
        GIT_COMMITTER_EMAIL: identity.email,
      },
    });
  }
  async candidate(accepted, target, id) {
    await this.baseline(accepted.upstream, accepted.internal);
    if (!(await this.isAncestor(accepted.upstream, target))) fail('SOURCE_REWRITTEN', '目标不包含已接受上游历史');
    await this.checkContent(target);
    // Source objects stay untouched; the receiving merge applies declared internal preservation to the source tree.
    const tree = await preservedTree(this, target, accepted.internal, id);
    const head = await this.mergeNode(tree, [accepted.internal, target], `repo-sync delivery ${id}`);
    if (!/^[a-f0-9]{24}$/.test(id)) fail('INVALID_DELIVERY_ID', '候选交付身份无效');
    await git(this.directory, ['update-ref', `refs/sync/deliveries/${id}`, head]);
    return head;
  }
  async remoteBranch(branch, options = {}) {
    const output = await git(
      this.directory,
      ['ls-remote', '--heads', this.config.internalUrl, `refs/heads/${branch}`],
      options,
    );
    if (!output) return null;
    const [sha, ref] = output.split(/\s+/);
    if (ref !== `refs/heads/${branch}` || !/^[0-9a-f]{40}$/.test(sha))
      fail('REMOTE_REF_CONFLICT', '远端候选 ref 返回不明确');
    return sha;
  }
  async publish(delivery, pushOptions = []) {
    const existing = await this.remoteBranch(delivery.branch);
    if (existing && existing !== delivery.candidate) fail('CANDIDATE_CONFLICT', '候选分支存在不同 SHA，禁止覆盖');
    // Empty expected value is a create-only condition, never permission to replace a ref.
    if (!existing)
      await git(
        this.directory,
        [
          'push',
          ...pushOptions.flatMap((option) => ['--push-option', option]),
          `--force-with-lease=refs/heads/${delivery.branch}:`,
          this.config.internalUrl,
          `${delivery.candidate}:refs/heads/${delivery.branch}`,
        ],
        delivery.gitPr ? { onOutput: (output) => captureGitPr(this.config, delivery, output) } : {},
      );
    if ((await this.remoteBranch(delivery.branch)) !== delivery.candidate)
      fail('PUSH_RESULT_UNKNOWN', '推送结果待回读确认');
  }
  async verify(delivery, actual) {
    if (!(await this.sameTree(delivery.candidate, actual)))
      fail('TREE_MISMATCH', '实际 main 文件树不等于已检查候选（含声明的保留规则）');
    await this.baseline(delivery.target, actual);
    for (const sha of [
      delivery.commitPolicy?.strategy === 'rewrite' ? delivery.candidate : delivery.target,
      delivery.base.internal,
      delivery.candidate,
      ...(delivery.commitMappings ?? []).map((item) => item.internal),
      ...(delivery.developmentMappings ?? []).map((item) => item.internal),
    ]) {
      if (!(await this.isAncestor(sha, actual))) fail('HISTORY_REWRITTEN', '来源、上一内部版本或冻结候选未完整接受');
    }
    if (actual !== delivery.candidate) {
      const parents = (await git(this.directory, ['rev-list', '--parents', '-n', '1', actual])).split(' ').slice(1);
      if (parents.length !== 2 || parents[0] !== delivery.base.internal || parents[1] !== delivery.candidate)
        fail('MERGE_BASE_HEAD_MISMATCH', '实际合入的 base/head 与冻结候选不匹配');
    }
  }
  async checks(head) {
    const path = join(this.config.stateDir, 'checks', head);
    await mkdir(join(this.config.stateDir, 'checks'), { recursive: true });
    const { stat } = await import('node:fs/promises');
    try {
      await stat(path);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await git(this.directory, ['worktree', 'add', '--detach', path, head]);
    }
    for (const check of this.config.checks ?? []) await command(check.command, check.args, { cwd: path });
    if ((await git(path, ['rev-parse', 'HEAD'])) !== head) fail('CHECK_HEAD_CHANGED', '检查命令改变了候选 HEAD');
    await git(path, ['diff', '--exit-code', 'HEAD', '--', '.']);
    return {
      head,
      time: new Date().toISOString(),
      count: (this.config.checks ?? []).length,
      passed: true,
      profile: this.config.checkProfile ?? 'custom',
    };
  }
}
