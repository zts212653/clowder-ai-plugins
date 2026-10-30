import assert from 'node:assert/strict';
import test from 'node:test';
import { FeedbackService } from '../src/service.js';
import {fixture} from './service-fixture.js';
import type {HydratedJournal} from '../src/types.js';

const report = { title: '中文标题', body: '## 现象\napi_key=secret-value', attachments: [] };

test('owner-only confirmation binds sanitized bytes and CAS allows only one create', async () => {
  const f = fixture();
  await assert.rejects(f.service.dispatch({ op: 'save' }, undefined), /已登录/);
  const saved = await f.call({ op: 'save', targetId: 'clowder', report });
  assert.ok(!saved.journal.report.body.includes('secret-value'));
  await assert.rejects(f.call({ op: 'submit', digest: saved.journal.digest }), /尚未确认/);
  const approved = await f.call({ op: 'approve', digest: saved.journal.digest, confirmed: true });
  const results = await Promise.allSettled([f.call({ op: 'submit', digest: approved.journal.digest }), f.call({ op: 'submit', digest: approved.journal.digest })]);
  assert.equal(f.creates(), 1);
  const success = results.find(v => v.status === 'fulfilled');
  assert.ok(success?.status === 'fulfilled');
  assert.equal(success.value.journal.state, 'published');
  assert.match(success.value.journal.issue?.url ?? '', /\/issues\/12$/);
});

test('lost response survives service restart and reconciles without a second POST', async () => {
  const f = fixture(); f.fail();
  const saved = await f.call({ op: 'save', targetId: 'clowder', report });
  await f.call({ op: 'approve', digest: saved.journal.digest, confirmed: true });
  const outcome = await f.call({ op: 'submit', digest: saved.journal.digest });
  assert.equal(outcome.journal.state, 'unknown');
  const restarted = new FeedbackService(f.host, () => f.adapter);
  await assert.rejects(restarted.dispatch({ op: 'submit',feedbackId:f.feedbackId(), digest: saved.journal.digest }, f.ctx), /不会重复/);
  const reconciled = await restarted.dispatch({ op: 'reconcile',feedbackId:f.feedbackId(), digest: saved.journal.digest }, f.ctx) as { journal: HydratedJournal };
  assert.equal(reconciled.journal.state, 'published');
  assert.equal(f.creates(), 1);
});

test('edits revoke consent; stale digest and stale window cannot publish', async () => {
  const f = fixture();
  const saved = await f.call({ op: 'save', targetId: 'clowder', report });
  const approved = await f.call({ op: 'approve', digest: saved.journal.digest, confirmed: true });
  const edited = await f.call({ op: 'save', revision: approved.revision, targetId: 'clowder', report: { ...report, title: '新标题' } });
  assert.equal(edited.journal.state, 'draft');
  await assert.rejects(f.call({ op: 'submit', digest: approved.journal.digest }), /版本已变化/);
  await assert.rejects(f.call({ op: 'save', revision: approved.revision, targetId: 'clowder', report }), /版本已变化/);
  assert.equal(f.creates(), 0);
});
