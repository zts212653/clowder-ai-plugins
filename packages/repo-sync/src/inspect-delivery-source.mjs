import { fail } from './config.mjs';
import { api, withGithub } from './gh-api.mjs';
import { githubRepository } from './github.mjs';
import { git } from './process.mjs';
import { event } from './store.mjs';

export function inspectDeliverySource(receiver) {
  return withGithub(receiver.config, () => receiver.change(async (state) => {
    const d = receiver.requireActive(state);
    if (!d.source.number) fail('SOURCE_UNPROVEN', '此笔没有上游 PR，不读取其他来源。');
    const repo = githubRepository(receiver.config.sourceUrl);
    const pr = await api(`repos/${repo}/pulls/${d.source.number}`);
    if (!pr.merged || pr.node_id !== d.source.id || pr.merge_commit_sha !== d.target || pr.html_url !== d.source.url ||
        !Number.isSafeInteger(pr.commits) || pr.commits < 1)
      fail('SOURCE_CHANGED', '原 PR 来源或落点与冻结交付不一致，未替换历史。');
    const commits = await api(`repos/${repo}/pulls/${d.source.number}/commits?per_page=100`, true);
    if (commits.length !== pr.commits || commits.some((item) => !/^[a-f0-9]{40}$/.test(item?.sha ?? '')) ||
        new Set(commits.map((item) => item.sha)).size !== commits.length)
      fail('PR_HISTORY_INCOMPLETE', '原 PR 开发清单读取不完整，未改变候选或映射。');
    d.source.developmentCommitCount = pr.commits;
    d.developmentDetails = commits.map((item) => ({ sha: item.sha, subject: item.commit?.message?.split('\n')[0] ?? '标题未记录' }));
    if (d.candidate) {
      await receiver.git.fetch();
      d.internalCommitCount = Number(await git(receiver.git.directory, ['rev-list', '--count', d.candidate, `^${d.base.internal}`]));
    }
    event(state, d, '已只读回读原 PR 开发清单；现有候选、映射与接受游标未修改。');
  }));
}
