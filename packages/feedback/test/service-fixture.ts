import {randomUUID} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {FeedbackService} from '../src/service.js';
import {marker} from '../src/providers.js';
import type {Host,HydratedJournal,OwnerContext,Provider} from '../src/types.js';
export function fixture() {
  const values = new Map<string, { revision: number; value: unknown }>();
  let revision = 0; let creates = 0; let fail = false; let remote: { id: string; url: string; title: string; body: string } | undefined;
  const host: Host = { pluginInstanceId: 'fixture', dataPath: join(tmpdir(), 'feedback-service-tests', randomUUID()), config: { get: async () => undefined }, secrets: { get: async () => undefined }, storage: {
    get: async key => structuredClone(values.get(key)),
    compareAndSet: async (key, expected, value) => {
      if ((values.get(key)?.revision ?? null) !== expected) return { applied: false };
      const r = ++revision; values.set(key, { revision: r, value: structuredClone(value) }); return { applied: true, revision: r };
    },
  } };
  const adapter: Provider = {
    preflight: async () => ({ principal: 'owner', visibility: 'public', attachments: true }),
    upload: async () => '![screenshot](https://images.example.test/screenshot.png)',
    create: async (report, id) => { creates++; remote = { id: '12', url: 'https://github.com/zts212653/clowder-ai/issues/12', title: report.title, body: `${report.body}\n\n${marker(id)}` }; if (fail) throw new Error('lost response after create'); return remote; },
    reconcile: async () => remote, read: async () => { if (!remote) throw new Error('not found'); return remote; },
  };
  const ctx: OwnerContext = { kind: 'owner-http-request', userId: 'owner', pluginInstanceId: 'fixture', operation: 'write', requestIdentity: { requestId: 'request' }, signal: new AbortController().signal, assertCurrent: async () => {} };
  const service = new FeedbackService(host, () => adapter);
  let feedbackId: string | undefined;
  let selectedRevision: number | undefined;
  // A panel carries its selected record ID; raw dispatch tests cover the blank home.
  const call = async (input: unknown) => {
    const request=input as Record<string,unknown>;
    if (request.op==='prepare-analysis' && !feedbackId) {
      const saved=await service.dispatch({op:'save',targetId:'clowder',report:request.report},ctx) as {journal:HydratedJournal;revision:number};
      feedbackId=saved.journal.id; selectedRevision=saved.revision;
    }
    const result=await service.dispatch({...request,revision:request.revision ?? selectedRevision,feedbackId:request.feedbackId ?? feedbackId},ctx) as {journal:HydratedJournal;revision:number};
    if (result.journal) feedbackId=result.journal.id;
    if (result.revision !== undefined) selectedRevision=result.revision;
    return result;
  };
  return { host, adapter, ctx, service, call, feedbackId:()=>feedbackId, creates: () => creates, fail: () => { fail = true; } };
}
