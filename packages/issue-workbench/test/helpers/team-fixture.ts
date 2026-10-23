import { IssueTeamRuntime } from '../../src/team/runtime.js';
import type { TeamContext, TeamProvider, TeamIssue, SharedDispatch, TeamCaller } from '../../src/team/types.js';
export function setup() {
  const entries = new Map<string, { revision: number; value: unknown }>();
  let revision = 0;
  const config: Record<string, unknown> = {
    repositories: 'fixture/repo', analysisCatId: 'analyst', inboxCatId: 'receiver',
    inboxThreadId: 'inbox', receiveAssignments: true, automaticAssignment: true,
    teamOrganization: 'fixture-org',
    routingRules: JSON.stringify([{ login: 'alice', categories: ['Agent 运行'], features: ['F123'] }]),
  };
  const issues: TeamIssue[] = [{
    repo: 'fixture/repo', number: 1, id: 'issue-1', title: 'Cannot start',
    body: 'The café cannot start. No workaround.', updatedAt: '2026-10-14T10:00:00Z', author: 'reporter', state: 'open', labels: [], assignees: [],
    url: 'https://github.com/fixture/repo/issues/1',
  }];
  const sends = new Map<string, any>();
  const writes: string[] = [];
  let login = 'maintainer', failSend = false, routable = true, epoch = 'assignment-1';
  let feedbackCat: string | null = null;
  const dispatches: SharedDispatch[] = [];
  const context: TeamContext = {
    pluginInstanceId: 'isolated-test',
    config: { get: async key => config[key] },
    storage: {
      get: async key => structuredClone(entries.get(key)),
      list: async () => structuredClone(Object.fromEntries(entries)),
      set: async (key, value) => { const n = ++revision; entries.set(key, { revision: n, value: structuredClone(value) }); return { revision: n }; },
      compareAndSet: async (key, expected, value) => {
        if ((entries.get(key)?.revision ?? null) !== expected) return { applied: false };
        const n = ++revision; entries.set(key, { revision: n, value: structuredClone(value) }); return { applied: true, revision: n };
      },
      delete: async key => ({ deleted: entries.delete(key) }),
    },
    threads: {
      get: async id => ({ id, deepLinkUrl: 'https://host.test/thread/' + id, title: id, createdAt: 1, lastActiveAt: 1, preferredCats: [], featureRefs: [] }),
      getCats: async () => ({ participants: [], routableNow: routable ? [{ catId: 'analyst', displayName: 'analyst', aliases: [] }, { catId: 'receiver', displayName: 'receiver', aliases: [] }] : [], routableNotJoined: [], notRoutable: [] }),
    } as TeamContext['threads'],
    messaging: {
      send: async (threadId, draft) => {
        if (failSend) throw new Error('Host offline');
        if (!sends.has(draft.idempotencyKey)) sends.set(draft.idempotencyKey, { threadId, draft, messageId: 'message-' + sends.size });
        return { messageId: sends.get(draft.idempotencyKey).messageId, threadId };
      },
      get: async id => ({ id, catId: feedbackCat, threadId: 'analysis', userId: 'owner', content: 'Please record my feedback: workaround discovered.', mentions: [], timestamp: Date.now() + 1, sourceRevision: '1' }),
      subscribe: async () => {}, unsubscribe: async () => {},
    },
    log: () => {},
  };
  const members = ['alice', 'bob'];
  const provider: TeamProvider = {
    allIssues: async repo => structuredClone(issues.filter(issue => issue.repo === repo)),
    openIssues: async repo => structuredClone(issues.filter(issue => issue.repo === repo && issue.state === 'open')),
    organizationMembers: async () => [...members],
    identity: async () => login,
    issue: async (_repo, number) => structuredClone(issues.find(issue => issue.number === number)!),
    canWrite: async () => login === 'maintainer',
    assignable: async (_repo, target) => target === 'alice',
    addAssignee: async (issue, target) => { writes.push(target); issues.find(item => item.id === issue.id)!.assignees.push(target); },
    publishDispatch: async (_issue, dispatch) => { if (!dispatches.some(item => item.id === dispatch.id)) dispatches.push(dispatch); return 'comment-1'; },
    invitations: async (_repo, target, senders) => ({ nextPage: null, observations: dispatches.filter(d => d.delivery === 'invitation' && d.assignee === target && senders.includes('bob'))
      .flatMap(d => issues.filter(issue => issue.id === d.issueId && issue.state === 'open').map(issue => ({ issue: structuredClone(issue), assignmentId: 'invitation:' + d.id, dispatch: d, delivery: 'invitation' as const }))) }),
    invitation: async (issue, id, target, senders, signal) => (await provider.invitations(issue.repo, target, senders, signal)).observations.find(row => row.assignmentId === id) ?? null,
    assigned: async (_repo, target) => issues.filter(issue => issue.state === 'open' && issue.assignees.includes(target))
      .map(issue => ({ issue: structuredClone(issue), assignmentId: epoch, dispatch: dispatches.at(-1) ?? null })),
    publishReceipt: async () => 'receipt-comment',
    receipts: async () => [],
  };
  const caller = (catId = 'analyst', threadId = 'analysis', source = 'request-source'): TeamCaller => ({
    catId, threadId, userId: 'owner', invocationId: 'invocation-' + catId, ownerAuthProvenance: 'strict',
    source: { kind: 'primary', sourceMessageId: source }, assertCurrent: async () => {},
  });
  const runtime = () => new IssueTeamRuntime(context, provider);
  const analysis = { category: 'Agent 运行', score: 9, reason: 'Core startup is blocked', evidence: 'The café cannot start.', blocksRuntime: true, workaround: '' };
  return { runtime, context, provider, caller, config, members, issues, sends, writes, dispatches, analysis,
    feedbackFromCat: () => { feedbackCat = 'analyst'; },
    login: (value: string) => { login = value; }, failSend: (value: boolean) => { failSend = value; },
    routable: (value: boolean) => { routable = value; }, epoch: (value: string) => { epoch = value; } };
}
