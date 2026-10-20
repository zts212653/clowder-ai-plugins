import { fail } from './config.mjs';
import { phase } from './execution.mjs';
import { api, withGithub } from './gh-api.mjs';
import { requireGithubToken } from './github-auth.mjs';
import { collectIssues } from './github-issues.mjs';
import { groupLandings, splitLandingsOutsidePr } from './github-landings.mjs';
import { git } from './process.mjs';
import { attachIssueRequirements } from './requirements.mjs';
import { sourceTarget } from './source-target.mjs';
import { assertTransferWritable } from './transfer-state.mjs';
import { developmentHistory } from './development-history.mjs';

export { groupLandings } from './github-landings.mjs';
export function githubRepository(url) {
  const match =
    /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(
      url,
    );
  if (!match) fail('SOURCE_PLATFORM_UNSUPPORTED', '来源需要 github.com 仓库；本地仓仅用于合成验证');
  return `${match[1]}/${match[2]}`;
}
const nativeProvider = { api, collectIssues };
export async function discover(receiver, selection, provider = nativeProvider) {
  if (receiver.config.mode === 'version') fail('WRONG_MODE', '按版本更新从 Git 读取 tag，不扫描 Issue / PR');
  if (selection?.includeDirectCommits !== undefined && typeof selection.includeDirectCommits !== 'boolean')
    fail('INVALID_TARGET', '旧版无 PR 参数格式无效；当前流程会自动识别提交来源。');
  return withGithub(receiver.config, () => receiver.store.locked(() => discoverLocked(receiver, selection, provider)));
}
async function discoverLocked(receiver, selection, provider) {
  await assertTransferWritable(receiver.config);
  const state = await receiver.read();
  if (!state) fail('NOT_ADOPTED', '先登记基线');
  if (receiver.active(state)) fail('RECOVERY_FIRST', '先恢复未完成交付，再扫描新的范围');
  if (provider === nativeProvider)
    await phase('github-auth', '检查已提供 GitHub API 读取认证', async () => {
      requireGithubToken(receiver.config);
    });
  const repo = githubRepository(receiver.config.sourceUrl);
  const repository = await phase('github-repository', '读取 GitHub 仓库元数据', () => provider.api(`repos/${repo}`));
  const heads = await receiver.git.fetch();
  const target = await phase('target-check', '核验目标与来源分支的提交关系', async () => {
    if (!(await receiver.git.isAncestor(state.accepted.upstream, heads.upstream)))
      fail('SOURCE_REWRITTEN', '来源分支已不包含已接收版本，请核对是否发生历史改写；未推进接收基线。');
    return sourceTarget(receiver, state, heads, selection);
  });
  const output = await git(receiver.git.directory, [
    'rev-list',
    '--first-parent',
    '--reverse',
    `${state.accepted.upstream}..${target.commit}`,
  ]);
  const boundaries = output ? output.split('\n') : [];
  return phase('github-deliveries', '读取并核对 PR / Issue / commit 对应', async () => {
    const associations = {};
    for (const sha of boundaries)
      associations[sha] = await provider.api(`repos/${repo}/commits/${sha}/pulls?per_page=100`, true);
    const grouped = groupLandings(
      boundaries,
      associations,
      receiver.config.sourceBranch,
      selection?.includeDirectCommits === true,
    );
    // 只有该 PR 自己的提交才能算作它的 landing；其余边界拆成独立交付，避免死锁。
    const groups = [];
    for (const group of grouped) {
      if (!group.pr || group.boundaries.length < 2) {
        groups.push(group);
        continue;
      }
      const commits = await provider.api(`repos/${repo}/pulls/${group.pr.number}/commits?per_page=100`, true);
      const owned = new Set(
        (Array.isArray(commits) ? commits : []).map((item) => item?.sha).filter((sha) => typeof sha === 'string'),
      );
      groups.push(...splitLandingsOutsidePr(group, owned, associations, receiver.config.sourceBranch));
    }
    const plans = [];
    let base = state.accepted.upstream;
    for (const group of groups) {
      const { pr, source } = await landingSource(receiver, provider, repo, repository, group);
      const introduced = (await git(receiver.git.directory, ['rev-list', `${base}..${group.target}`])).split('\n');
      if (pr) Object.assign(source, await developmentHistory(receiver, provider, repo, pr, introduced, base));
      const messages = [];
      for (const sha of introduced)
        messages.push(await git(receiver.git.directory, ['show', '-s', '--format=%B', sha]));
      const issueReferenceNotes = [];
      const issues = await provider.collectIssues(repo, pr, introduced, messages, issueReferenceNotes);
      if (issueReferenceNotes.length) source.issueReferenceNotes = issueReferenceNotes;
      plans.push({
        target: group.target,
        syncTarget: target,
        source,
        issues,
      });
      base = group.target;
    }
    attachIssueRequirements(plans);
    await receiver.replaceQueue(state, plans, heads, target.commit);
    state.syncTarget = target;
    if (state.automation?.status === 'RUNNING') {
      state.automation.scanned = true;
      state.automation.target = target.commit;
    }
    await receiver.store.save(state);
    return state;
  });
}
async function landingSource(receiver, provider, repo, repository, group) {
  if (typeof repository.node_id !== 'string' || !repository.node_id)
    fail('METADATA_INCOMPLETE', '来源仓库缺少稳定身份，不能记录不完整交付。');
  if (!group.pr)
    return {
      pr: null,
      source: {
        kind: 'commit',
        id: `commit:${repository.node_id}:${group.target}`,
        repositoryId: repository.node_id,
        commit: group.target,
        url: `https://github.com/${repo}/commit/${group.target}`,
        title: await git(receiver.git.directory, ['show', '-s', '--format=%s', group.target]),
      },
    };
  const pr = await provider.api(`repos/${repo}/pulls/${group.pr.number}`);
  if (
    !pr.merged ||
    pr.merge_commit_sha !== group.target ||
    pr.node_id !== group.pr.node_id ||
    pr.base?.ref !== receiver.config.sourceBranch
  )
    fail('SOURCE_CHANGED', '扫描过程中 PR 来源发生变化');
  return {
    pr,
    source: {
      kind: 'pr',
      id: pr.node_id,
      repositoryId: repository.node_id,
      number: pr.number,
      url: pr.html_url,
      title: pr.title,
      mergedAt: pr.merged_at,
    },
  };
}
