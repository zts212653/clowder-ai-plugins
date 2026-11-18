import assert from 'node:assert/strict';
import test from 'node:test';
import { FeedbackService } from '../src/service.js';
import {fixture} from './service-fixture.js';
import { pngFixture } from './png-fixture.js';
import type {HydratedJournal} from '../src/types.js';

const report = { title: '中文标题', body: '## 现象\napi_key=secret-value', attachments: [] };

test('GitHub with an image can create one verified Issue after explicit approval to add the image later', async () => {
  const f = fixture();
  f.adapter.preflight = async () => ({ principal: 'owner', visibility: 'public', attachments: false });
  f.adapter.upload = async () => assert.fail('The approved screenshot stays on this device');
  const image = pngFixture().toString('base64');
  const saved = await f.call({ op:'save', targetId:'clowder',
    report:{...report,attachments:[{mime:'image/png',base64:image}]},
  });
  const {digest,id} = saved.journal;
  assert.deepEqual(await f.call({op:'preflight',digest}), {principal:'owner',visibility:'public',attachments:false});
  await f.call({op:'approve',digest,confirmed:true});
  await assert.rejects(f.call({op:'submit',digest}), /\u622a\u56fe/);
  assert.equal(f.creates(),0);

  await f.call({op:'approve',digest,confirmed:true,addScreenshotsLater:true});
  await assert.rejects(f.call({op:'submit',digest}), /\u622a\u56fe/);
  const submitted = await f.call({op:'submit',digest,addScreenshotsLater:true});
  assert.equal(submitted.journal.state,'published');
  assert.equal(submitted.journal.addScreenshotsLater,true);
  assert.ok(submitted.journal.issue?.url.endsWith('/issues/12'));
  assert.ok(!submitted.journal.issue?.body.includes('## \u622a\u56fe'));
  assert.equal(f.creates(),1);
  const reopened = await f.call({op:'bootstrap',feedbackId:id});
  assert.equal(reopened.journal.addScreenshotsLater,true);
  assert.equal(reopened.journal.report.attachments[0]?.base64,image);
  const confirmed = await f.call({op:'confirm-screenshots',digest});
  assert.equal(confirmed.journal.screenshotsConfirmed,true);
  await f.call({op:'submit',digest});
  assert.equal(f.creates(),1);
});

test('GitHub CLI comment failure preserves the verified Issue and the pictures without another create or comment', async () => {
  const f = fixture();
  let comments = 0;
  f.adapter.preflight = async () => ({principal:'owner',visibility:'public',attachments:false,githubCliAttachments:true});
  f.adapter.upload = async () => assert.fail('The CLI adds pictures to the verified Issue');
  f.adapter.attachToIssue = async (issue, pictures) => {
    assert.equal(f.creates(),1);
    assert.ok(issue.url.endsWith('/issues/12'));
    assert.equal(pictures.length,1);
    comments++;
    throw new Error('synthetic incomplete attachment comment');
  };
  const saved = await f.call({op:'save',targetId:'clowder',
    report:{...report,attachments:[{mime:'image/png',base64:pngFixture().toString('base64')}]},
  });
  const { digest, id } = saved.journal;
  await f.call({op:'approve',digest,confirmed:true});
  const result = await f.call({op:'submit',digest});
  assert.equal(result.journal.state,'published');
  assert.equal(result.journal.screenshotCommentUnverified,true);
  const reopened = await f.call({op:'bootstrap',feedbackId:id});
  assert.equal(reopened.journal.screenshotCommentUnverified,true);
  assert.equal(reopened.journal.report.attachments.length,1);
  await f.call({op:'submit',digest});
  assert.equal(f.creates(),1);
  assert.equal(comments,1);
});

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
