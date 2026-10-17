import { fail } from './config.mjs';
import { preservedTree } from './preserved-tree.mjs';
import { git, gitEnvironment } from './process.mjs';
import { verifyDevelopmentHistory } from './development-history.mjs';

export function commitPolicy(config) {
  const strategy = config.commitStrategy ?? 'preserve';
  const identity = config.receivingIdentity ?? { name: 'Repository Sync', email: 'repo-sync@localhost' };
  if (
    !['preserve', 'rewrite'].includes(strategy) ||
    !identity ||
    Object.keys(identity).some((key) => !['name', 'email'].includes(key)) ||
    typeof identity.name !== 'string' ||
    !identity.name.trim() ||
    /[<>\r\n\0]/.test(identity.name) ||
    typeof identity.email !== 'string' ||
    !/^[^\s<>@]+@[^\s<>@]+$/.test(identity.email)
  )
    fail('INVALID_COMMIT_IDENTITY', '请选择提交身份策略，并填写有效的 Git 姓名和邮箱；Token 不决定 Git 署名。');
  return { strategy, identity };
}
export function mappedCommit(state, source) {
  for (const delivery of [...state.deliveries].reverse()) {
    const mapped = delivery.commitMappings?.find((item) => item.source === source);
    if (mapped) return mapped.internal;
    const development = delivery.developmentMappings?.find((item) => item.source === source);
    if (development) return development.internal;
  }
  return source === state.initial?.upstream ? state.initial.internal : source;
}
export async function buildCandidate(receiver, state, delivery) {
  const policy = delivery.commitPolicy ?? commitPolicy(receiver.config);
  if (JSON.stringify(policy) !== JSON.stringify(commitPolicy(receiver.config)))
    fail('COMMIT_POLICY_CHANGED', '当前提交身份与冻结交付不一致，请恢复原身份配置后继续；原候选未覆盖。');
  if (receiver.config.mode === 'version')
    return { head: await receiver.git.candidate(delivery.base, delivery.target, delivery.id) };
  if (policy.strategy === 'preserve') {
    const head = await receiver.git.candidate(delivery.base, delivery.target, delivery.id);
    return { head, mappings: delivery.commits.map((source) => ({ source, internal: source })) };
  }
  await receiver.git.baseline(delivery.base.upstream, delivery.base.internal);
  if (!(await receiver.git.isAncestor(delivery.base.upstream, delivery.target)))
    fail('SOURCE_REWRITTEN', '目标不包含已接受上游历史');
  await receiver.git.checkContent(delivery.target);
  const replay = delivery.source.developmentReplay;
  const sources = replay ? await verifyDevelopmentHistory(receiver, delivery) : (
    await git(receiver.git.directory, [
      'rev-list',
      '--reverse',
      '--topo-order',
      `${delivery.base.upstream}..${delivery.target}`,
    ])
  ).split('\n');
  const mappings = [],
    lookup = new Map();
  for (const source of sources) {
    const parents = (await git(receiver.git.directory, ['show', '-s', '--format=%P', source]))
      .split(' ')
      .filter(Boolean);
    const translated = [];
    for (const parent of parents) translated.push(await translateParent(receiver, state, delivery, lookup, parent));
    // Always include the current accepted internal head; never reintroduce an old internal baseline.
    if (!translated.length) translated.push(delivery.base.internal);
    const dates = (await git(receiver.git.directory, ['show', '-s', '--format=%aI%n%cI', source])).split('\n');
    const object = await git(receiver.git.directory, ['cat-file', 'commit', source], { binary: true });
    const separator = object.indexOf(Buffer.from('\n\n'));
    if (separator < 0) fail('COMMIT_OBJECT_INVALID', '来源提交缺少有效消息边界。');
    const message = object.subarray(separator + 2);
    const tree = await preservedTree(receiver.git, source, delivery.base.internal, delivery.id);
    const env = {
      ...gitEnvironment(),
      GIT_AUTHOR_NAME: policy.identity.name,
      GIT_AUTHOR_EMAIL: policy.identity.email,
      GIT_COMMITTER_NAME: policy.identity.name,
      GIT_COMMITTER_EMAIL: policy.identity.email,
      GIT_AUTHOR_DATE: dates[0],
      GIT_COMMITTER_DATE: dates[1],
    };
    const internal = await git(
      receiver.git.directory,
      ['commit-tree', tree, ...[...new Set(translated)].flatMap((p) => ['-p', p])],
      { env, input: message },
    );
    mappings.push({ source, internal });
    lookup.set(source, internal);
  }
  const head = lookup.get(replay?.head ?? delivery.target);
  if (!head || !(await receiver.git.isAncestor(delivery.base.internal, head)))
    fail('COMMIT_MAPPING_MISSING', '重写候选未包含当前内部基线，暂停；未推送。');
  await git(receiver.git.directory, ['update-ref', `refs/sync/deliveries/${delivery.id}`, head]);
  return replay
    ? { head, mappings: [{ source: delivery.target, internal: head }], developmentMappings: mappings }
    : { head, mappings };
}

async function translateParent(receiver, state, delivery, lookup, parent) {
  if (lookup.has(parent)) return lookup.get(parent);
  if (await receiver.git.isAncestor(parent, delivery.base.upstream)) return delivery.base.internal;
  const internal = mappedCommit(state, parent);
  if (internal === parent) fail('COMMIT_MAPPING_MISSING', '来源父提交缺少可证明的内部映射，暂停保留原记录。');
  return internal;
}
