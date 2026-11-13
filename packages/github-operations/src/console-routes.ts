import { createHash } from 'node:crypto';
import type { FastifyInstance, InjectOptions } from 'fastify';
import type { PluginMemberHost, PluginStorageHost } from '@clowder-ai/plugin-sdk';
import { z } from 'zod';
import type { CommunityRequestContext } from './business/routes/community-request-context.js';

const entry = z.object({ authoredByRole: z.string().optional(), questions: z.array(z.object({ id: z.string(), result: z.string() })),
  evidenceRefs: z.array(z.string()).optional(), routeRecommendation: z.object({ kind: z.string(), threadId: z.string().optional() }).optional(), recommendedOwnerRole: z.string().optional() });
const issue = z.object({ id: z.string(), issueNumber: z.number(), title: z.string(), state: z.string(), updatedAt: z.number(),
  assignedCatId: z.string().nullable(), assignedThreadId: z.string().nullable(), assignedThreadName: z.string().nullish(),
  directionCard: z.object({ entries: z.array(entry) }).nullish(),
  closureChecklist: z.object({ blockers: z.array(z.object({ detail: z.string() })), waiverPresent: z.boolean() }).nullish(),
  closureWaiver: z.object({ reason: z.string() }).nullish() });
const signal = z.object({ headSha: z.string(), status: z.string() }).nullish();
const pr = z.object({ prNumber: z.number().nullable(), title: z.string(), author: z.string().optional(), updatedAt: z.number(), group: z.string(),
  ownerCatId: z.string().nullish(), threadId: z.string().nullish(),
  externalReview: z.object({ currentHeadSha: z.string().nullish(), lifecycle: z.string().nullish(), lastDeliveredHeadSha: z.string().nullish(), cloud: signal, ci: signal }).nullish() });
const boardSchema = z.object({ repo: z.string(), issues: z.array(issue), prItems: z.array(pr) });
const draft = z.object({ draftId: z.string(), title: z.string(), bodyMarkdown: z.string(), targetRepo: z.string(), labels: z.array(z.string()).optional(), status: z.string(), githubIssueUrl: z.string().optional() });
const cardSchema = z.object({ title: z.string(), mid: z.string().min(1).max(500), sourceId: z.string().min(1).max(256),
  draftId: z.string(), phase: z.string(), titleValue: z.string(), bodyMarkdown: z.string(), targetRepo: z.string(), labels: z.array(z.string()),
  url: z.string(), lastError: z.string(), lastAction: z.enum(['read', 'edit', 'create', 'publish', 'cancel']).default('read') });
type Card = z.infer<typeof cardSchema>;
const address = z.object({ mid: z.string().min(1).max(500), b: z.string().min(1).max(256) });
const stateName = (v: string) => ({ 'pending-decision': 'pending_decision', declined: 'rejected', 'has-new-activity': 'new' }[v] ?? v);

/** Component snapshots and draft lifecycle belong to this plugin. All business
 * writes reuse its existing owner routes and durable publication journal. */
export function registerConsoleRoutes(app: FastifyInstance, scope: CommunityRequestContext, options: {
  storage: PluginStorageHost; members?: PluginMemberHost;
  messageThread?: (mid: string) => Promise<string | null>;
}) {
  const base = '/api/community-console';
  async function call(path: string, method: InjectOptions['method'] = 'GET', body?: unknown) {
    await scope.assertCurrent();
    const response = await scope.injectOwner({ kind: 'owner', id: scope.userId()! }, {
      method, url: '/api/community-' + path, ...(body === undefined ? {} : { payload: body as InjectOptions['payload'] }),
    });
    const result = response.body ? response.json() as Record<string, unknown> : {};
    if (response.statusCode >= 400 || result.error) throw new Error(String(result.error ?? `Community request failed (${response.statusCode})`));
    return result;
  }
  const repoQuery = (repo: string) => '?repo=' + encodeURIComponent(repo);
  const narrator = (i: z.infer<typeof issue>) => i.directionCard?.entries.find(e => e.authoredByRole === 'narrator');
  async function board(repo?: string) {
    const { repos } = z.object({ repos: z.array(z.string()) }).parse(await call('repos'));
    const selected = repo ?? repos[0];
    return { repos, board: selected ? boardSchema.parse(await call('board' + repoQuery(selected))) : null };
  }
  async function find(repo: string | undefined, n: number) {
    const snapshot = await board(repo);
    const found = snapshot.board?.issues.find(i => i.issueNumber === n);
    if (!found) throw new Error('Community issue not found');
    return found;
  }
  app.get(base, async request => {
    const q = z.object({ repo: z.string().optional(), detail: z.coerce.number().optional(), cSt: z.string().default('all'), cCat: z.string().default('all'), cTime: z.string().default('all') }).parse(request.query);
    const { repos, board: b } = await board(q.repo);
    if (!b) return { noRepo: true, repos, list: null };
    const members = await options.members?.list() ?? [];
    const identity = (id: string | null | undefined) => {
      const member = members.find(m => m.catId === id);
      return { name: member?.nickname || member?.displayName || id || '', handle: id ? '@' + id : '' };
    };
    const threadTitle = async (i: z.infer<typeof issue>) => i.assignedThreadName || i.assignedThreadId || '';
    if (q.detail) {
      const i = b.issues.find(i => i.issueNumber === q.detail);
      if (!i) return { detail: { gone: true } };
      const e = narrator(i), route = e?.routeRecommendation;
      return { detail: { n: i.issueNumber, thread: i.assignedThreadId, state: stateName(i.state), ago: i.updatedAt, title: i.title,
        url: `https://github.com/${b.repo}/issues/${i.issueNumber}`, hasCat: !!i.assignedCatId, catName: identity(i.assignedCatId).name,
        catHandle: identity(i.assignedCatId).handle, threadTitle: await threadTitle(i),
        ...(e && i.state === 'pending-decision' ? { dir: { reject: route?.kind === 'decline', accept: route?.kind !== 'decline',
          questions: e.questions.map(q => ({ label: q.id, value: q.result })), evidence: e.evidenceRefs ?? [],
          route: route?.kind === 'existing-thread' ? 'existing' : route?.kind === 'new-thread' ? 'new' : route?.kind, role: e.recommendedOwnerRole ?? 'case-owner' } }
          : i.closureChecklist ? { closure: { pending: !!i.closureChecklist.blockers.length && !i.closureChecklist.waiverPresent,
            // There is no owner close operation in the workflow API yet.
            locked: true, rows: i.closureWaiver ? [{ waived: true, text: i.closureWaiver.reason }]
              : i.closureChecklist.blockers.length ? i.closureChecklist.blockers.map(b => ({ blocker: true, text: b.detail })) : [{ ready: true }] } } : {}),
      } };
    }
    const [queue, findings] = await Promise.all([call('decision-queue' + repoQuery(b.repo)), call('findings?status=open,acknowledged')]);
    const decisions = z.array(z.object({ subjectType: z.string(), number: z.number().optional(), priority: z.string() }).passthrough()).parse(queue.items);
    const selected = b.issues.filter(i => (q.cSt === 'all' || stateName(i.state) === q.cSt) && (q.cCat === 'all' || i.assignedCatId === q.cCat)
      && (q.cTime === 'all' || Date.now() - i.updatedAt <= Number(q.cTime) * 86400000));
    return { repos, list: { repo: b.repo, fs: q.cSt, fc: q.cCat, ft: q.cTime, syncing: false,
      cats: [...new Set(b.issues.map(i => i.assignedCatId).filter((id): id is string => !!id))].map(id => ({ v: id, ...identity(id) })),
      issueCount: b.issues.length, prCount: b.prItems.length,
      issueGroups: await Promise.all(['unreplied','discussing','pending-decision','accepted','declined','closed'].map(async state => ({ state: stateName(state),
        items: await Promise.all(selected.filter(i => i.state === state).map(async i => {
          const d = decisions.find(d => d.subjectType === 'issue' && d.number === i.issueNumber);
          const drill = !!((narrator(i) && i.state === 'pending-decision') || i.closureChecklist);
          return { id: i.issueNumber, n: i.issueNumber, title: i.title, hasCat: !!i.assignedCatId, catName: identity(i.assignedCatId).name,
            catHandle: identity(i.assignedCatId).handle, threadTitle: await threadTitle(i), ago: i.updatedAt, unreplied: i.state === 'unreplied',
            priority: d?.priority ?? 'normal', normalPriority: !d || d.priority === 'normal', drill, canOpen: drill || !!i.assignedThreadId, thread: i.assignedThreadId };
        })) }))),
      prGroups: ['unreplied','replied','has-new-activity','merged','closed'].map(state => ({ state: stateName(state), items: b.prItems.filter(p => p.group === state).map(p => {
        const r = p.externalReview, cloud = r?.cloud?.headSha === r?.currentHeadSha ? r?.cloud : null, ci = r?.ci?.headSha === r?.currentHeadSha ? r?.ci : null;
        return { id: p.prNumber, n: p.prNumber, title: p.title, author: p.author, catName: identity(p.ownerCatId).name, ago: p.updatedAt,
          life: r?.lifecycle, cloud: cloud?.status, cloudFail: !!cloud && ['blocking','failed_or_timeout'].includes(cloud.status), ci: ci?.status,
          ciFail: ci?.status === 'fail', sent: r?.lastDeliveredHeadSha, thread: p.threadId };
      }) })),
      findings: z.array(z.object({ findingId: z.string(), subjectKey: z.string(), message: z.string(), findingKind: z.string(), severity: z.string(), status: z.string() })).parse(findings.findings)
        .filter(f => ['issue:', 'pr:'].some(prefix => f.subjectKey.startsWith(prefix + b.repo + '#')))
        .map(f => ({ i: f.findingId, msg: f.message, kind: f.findingKind, sev: f.severity, st: ({open:'pending',acknowledged:'confirmed',waived:'exempted'}[f.status] ?? f.status), pending: ['open','acknowledged'].includes(f.status) })),
    } };
  });
  app.post(base + '/sync', async request => {
    const { repo } = z.object({ repo: z.string().trim().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/) }).parse(request.body);
    await Promise.all([call('issues/sync' + repoQuery(repo), 'POST', {}), call('issues/sync-prs' + repoQuery(repo), 'POST', {})]);
    return { ok: true, act: 'plugSet', args: { plugin: 'official.github-operations', k: 'repo', v: repo } };
  });
  for (const op of ['status','route','report','waive']) app.post(base + '/' + op, async request => {
    const b = z.object({ repo: z.string().optional(), n: z.coerce.number().optional(), id: z.union([z.string(), z.number()]).optional(),
      entity: z.string().optional(), v: z.string().optional(), reportURL: z.string().optional(), reason: z.string().optional(), evidence: z.string().optional() }).parse(request.body);
    if (op === 'status' && b.entity === 'finding') {
      if (!['confirmed','resolved','exempted'].includes(b.v ?? '')) throw new Error('Invalid finding status');
      // Preserve the previous confirm/resolve behavior; waiver needs its own evidence form.
      await call('findings/' + encodeURIComponent(String(b.id)) + '/' + (b.v === 'confirmed' ? 'acknowledge' : 'resolve'), 'POST', {});
    } else {
      const i = await find(b.repo, Number(b.n ?? b.id)), path = 'issues/' + encodeURIComponent(i.id);
      if (op === 'route') await call(path + '/dispatch', 'POST', {});
      if (op === 'report') await call(path + '/report', 'POST', { publicCommentUrl: b.reportURL });
      if (op === 'waive') await call(path + '/waive-closure', 'POST', { reason: b.reason, evidence: b.evidence });
      if (op === 'status') {
        if (b.v !== 'accepted' && b.v !== 'rejected') throw new Error('Invalid owner decision');
        await call(path + '/resolve', 'POST', { decision: b.v === 'accepted' ? 'accepted' : 'declined', routeRecommendation: narrator(i)?.routeRecommendation });
      }
    }
    return { ok: true };
  });

  const keyFor = (mid: string, b: string) => 'community.console.card.' + createHash('sha256').update(JSON.stringify([scope.userId(), mid, b])).digest('hex');
  const savedCard = async (mid: string, b: string) => {
    const row = await options.storage.get(keyFor(mid, b));
    if (!row) throw new Error('Open the draft card before editing');
    return { row, card: cardSchema.parse(row.value) };
  };
  const save = async (s: Card, revision: number | null) => {
    await scope.assertCurrent();
    if (!(await options.storage.compareAndSet(keyFor(s.mid, s.sourceId), revision, s)).applied) throw new Error('Draft card changed; reload before retrying');
  };
  const receipt = (s: Card, value: unknown) => {
    const d = draft.parse(value);
    s.draftId = d.draftId; s.phase = d.status === 'draft' ? 'editing' : d.status; s.url = d.githubIssueUrl ?? '';
    if (d.status === 'published' || d.status === 'cancelled') s.lastError = '';
    if (d.status === 'publishing') { s.lastAction = 'publish'; s.lastError ||= 'Publication outcome uncertain. Retry to reconcile the original issue.'; }
  };
  app.post(base + '/draft/read', async request => {
    const b = z.object({ mid: address.shape.mid, title: z.string().default(''), block: z.object({ id: address.shape.b, meta: z.object({
      draftId: z.string().optional(), proposedTitle: z.string().default(''), proposedBody: z.string().default(''), proposedRepo: z.string().optional(), proposedLabels: z.array(z.string()).default([]),
    }) }) }).parse(request.body);
    const config = z.object({ repos: z.array(z.string()), defaultRepo: z.string() }).parse(await call('issue-drafts/config'));
    const key = keyFor(b.mid, b.block.id), stored = await options.storage.get(key);
    const s: Card = stored ? cardSchema.parse(stored.value) : { title: b.title, mid: b.mid, sourceId: b.block.id, draftId: b.block.meta.draftId ?? '', phase: 'editing',
      titleValue: b.block.meta.proposedTitle, bodyMarkdown: b.block.meta.proposedBody, targetRepo: b.block.meta.proposedRepo || config.defaultRepo,
      labels: b.block.meta.proposedLabels, url: '', lastError: '', lastAction: 'read' };
    if (s.draftId) {
      try {
        const result = await call('issue-drafts/by-id/' + encodeURIComponent(s.draftId));
        const d = draft.parse(result.draft);
        if (s.lastAction === 'read') s.lastError = '';
        receipt(s, d);
        if (!stored) { s.titleValue = d.title; s.bodyMarkdown = d.bodyMarkdown; s.targetRepo = d.targetRepo; s.labels = d.labels ?? []; }
      } catch (error) { s.lastError = error instanceof Error ? error.message : 'Draft read failed'; if (s.lastAction !== 'publish' && s.lastAction !== 'create') s.lastAction = 'read'; }
    }
    if (!stored || JSON.stringify(s) !== JSON.stringify(stored.value)) await save(s, stored?.revision ?? null);
    const f = 'issue-' + s.mid + '-' + s.sourceId + '-', editable = s.phase === 'editing' && !(s.lastAction === 'read' && s.lastError);
    return { ...s, repos: config.repos, repoId: f + 'repo', titleId: f + 'title', bodyId: f + 'body', canEdit: editable,
      canCreate: editable && !s.draftId, canPublish: editable && !!s.draftId, canCancel: editable,
      state: editable ? (s.draftId ? 'draft' : '') : s.phase };
  });
  for (const action of ['edit','create','publish','cancel','retry'] as const) app.post(base + '/draft/' + action, async request => {
    const b = address.extend({ field: z.enum(['title','bodyMarkdown','targetRepo']).optional(), value: z.string().optional() }).parse(request.body);
    const { row, card: s } = await savedCard(b.mid, b.b);
    const op = action === 'retry' ? s.lastAction : action;
    s.lastError = ''; s.lastAction = op;
    let revision = row.revision;
    try {
      if (op === 'edit') {
        if (s.phase !== 'editing' || !b.field || b.value === undefined || b.field === 'targetRepo' && !!s.draftId) throw new Error('Draft is not editable');
        s[b.field === 'title' ? 'titleValue' : b.field] = b.value;
      } else if (op === 'read') {
        if (s.draftId) receipt(s, (await call('issue-drafts/by-id/' + encodeURIComponent(s.draftId))).draft);
      } else if (op === 'cancel' && !s.draftId) { s.phase = 'cancelled'; }
      else {
        if (s.phase === 'cancelled' || s.phase === 'published') throw new Error('Draft is already settled');
        if (op === 'create' && s.draftId || op !== 'create' && !s.draftId) throw new Error('Draft operation does not match its lifecycle');
        if (op !== 'cancel' && (!s.titleValue.trim() || !s.bodyMarkdown.trim())) throw new Error('Please fill in the title and body');
        s.phase = op === 'create' ? 'creating' : op === 'publish' ? 'publishing' : s.phase;
        s.lastError = 'Draft operation interrupted; retry to reconcile the original draft';
        await save(s, revision);
        revision = (await savedCard(b.mid, b.b)).row.revision;
        const result = op === 'create' ? await call('issue-drafts', 'POST', {
          sourceType: 'cat_initiated', sourceId: s.sourceId, title: s.titleValue, bodyMarkdown: s.bodyMarkdown, targetRepo: s.targetRepo, labels: s.labels,
          threadId: await options.messageThread?.(s.mid), messageId: s.mid,
        }) : await call('issue-drafts/by-id/' + encodeURIComponent(s.draftId) + '/' + op, 'POST', op === 'publish' ? { title: s.titleValue, bodyMarkdown: s.bodyMarkdown } : {});
        receipt(s, result.draft); s.lastError = '';
        if (op === 'create') { const d = draft.parse(result.draft); s.titleValue = d.title; s.bodyMarkdown = d.bodyMarkdown; }
      }
    } catch (error) { s.lastError = error instanceof Error ? error.message : 'Draft operation failed'; }
    await save(s, revision);
    return { ok: true };
  });
}
