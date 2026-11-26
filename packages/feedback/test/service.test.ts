import assert from 'node:assert/strict';
import test from 'node:test';
import { FeedbackService } from '../src/service.js';
import {fixture} from './service-fixture.js';
import { pngFixture } from './png-fixture.js';
import { feedbackKey } from '../src/config.js';
import type {HydratedJournal,Journal} from '../src/types.js';

const report = { title: '中文标题', body: '## 现象\napi_key=secret-value', attachments: [] };

test('initial Issue publication sends no images, then uploads exactly the selected subset to the same Issue', async () => {
  const f = fixture();
  f.adapter.preflight = async () => ({principal:'owner',visibility:'public',attachments:false,githubCliAttachments:true});
  f.adapter.upload = async () => assert.fail('no pre-Issue upload');
  let remoteHashes: string[] = [];
  f.adapter.attachToIssue = async (issue,pictures) => {
    assert.equal(f.creates(),1);
    assert.ok(issue.url.endsWith('/issues/12'));
    remoteHashes = pictures.map(picture=>picture.sha256);
    return remoteHashes;
  };
  const pictures = [16,17,18].map(size=>({mime:'image/png',base64:pngFixture(size).toString('base64')}));
  const saved = await f.call({op:'save',targetId:'clowder',report:{...report,attachments:pictures.slice(0,2)}});
  const {digest,id} = saved.journal;
  await f.call({op:'approve',digest,confirmed:true});
  const published = await f.call({op:'submit',digest});
  assert.equal(published.journal.state,'published');
  assert.equal(published.journal.screenshotItems?.length,2);
  assert.deepEqual(published.journal.report.attachments,[]);
  assert.deepEqual(remoteHashes,[]);
  assert.ok(!published.journal.issue?.body.includes('Clowder-screenshot'));

  const added = await f.call({op:'add-screenshots',digest,pictures:[pictures[2]]});
  assert.equal(added.journal.digest,digest);
  const selected = added.journal.screenshotItems?.[2]?.sha256;
  assert.ok(selected);
  await assert.rejects(f.call({op:'upload-screenshots',digest,hashes:[selected]}));
  assert.deepEqual(remoteHashes,[]);
  await f.call({op:'upload-screenshots',digest,hashes:[selected],confirmed:true});
  const reopened = await f.call({op:'bootstrap',feedbackId:id});
  assert.deepEqual(reopened.journal.screenshotSent,[selected]);
  assert.deepEqual(remoteHashes,[selected]);
  await assert.rejects(f.call({op:'upload-screenshots',digest,hashes:[selected],confirmed:true}));
  await f.call({op:'submit',digest});
  assert.equal(f.creates(),1);
});

test('a lost screenshot comment response is checked on the existing Issue without blind re-upload', async () => {
  const f = fixture();
  let comments = 0;
  f.adapter.preflight = async () => ({principal:'owner',visibility:'public',attachments:false,githubCliAttachments:true});
  f.adapter.attachToIssue = async () => {
    comments++;
    throw new Error('synthetic lost response');
  };
  let checked = false;
  f.adapter.findIssueScreenshots = async (_issue, hashes) => checked ? hashes.slice(0,1) : undefined;
  const saved = await f.call({op:'save',targetId:'clowder',report:{...report,
    attachments:[20,21].map(size=>({mime:'image/png',base64:pngFixture(size).toString('base64')}))}});
  const {digest,id} = saved.journal;
  await f.call({op:'approve',digest,confirmed:true});
  const result = await f.call({op:'submit',digest});
  const hashes = result.journal.screenshotItems?.map(item=>item.sha256);
  const uploaded = await f.call({op:'upload-screenshots',digest,hashes,confirmed:true});
  assert.deepEqual(uploaded.journal.screenshotAttempt?.hashes,hashes);
  await assert.rejects(f.call({op:'upload-screenshots',digest,hashes,confirmed:true}));
  const reopened = await f.call({op:'bootstrap',feedbackId:id});
  assert.deepEqual(reopened.journal.screenshotAttempt?.hashes,hashes);
  assert.ok((await f.call({op:'check-screenshots',digest})).journal.screenshotAttempt);
  checked = true;
  const verified = await f.call({op:'retry-screenshots',digest,confirmed:true});
  assert.deepEqual(verified.journal.screenshotSent,hashes?.slice(0,1));
  assert.equal(verified.journal.screenshotAttempt,undefined);
  assert.equal(f.creates(),1);
  assert.equal(comments,1);
});


test('after a failed screenshot comment, confirming the missing images unlocks the same Issue for retry', async () => {
  const f = fixture();
  let comments = 0;
  f.adapter.attachToIssue = async (_issue, pictures) => {
    if (!comments++) throw new Error('synthetic failure before comment');
    return pictures.map(picture => picture.sha256);
  };
  f.adapter.findIssueScreenshots = async () => undefined;
  const image = {mime:'image/png',base64:pngFixture().toString('base64')};
  const {journal:{digest,id}} = await f.call({op:'save',targetId:'clowder',report:{...report,attachments:[image]}});
  await f.call({op:'approve',digest,confirmed:true});
  const published = await f.call({op:'submit',digest});
  const hashes = published.journal.screenshotItems?.map(item => item.sha256);
  await f.call({op:'upload-screenshots',digest,hashes,confirmed:true});
  const reopened = await f.call({op:'bootstrap',feedbackId:id});
  assert.ok(reopened.journal.screenshotAttempt);
  assert.ok((await f.call({op:'check-screenshots',digest})).journal.screenshotAttempt);
  await assert.rejects(f.call({op:'retry-screenshots',digest}), /确认/);
  await assert.rejects(f.call({op:'retry-screenshots',digest,confirmed:true,revision:published.revision}), /更新/);

  const retry = await f.call({op:'retry-screenshots',digest,confirmed:true});
  assert.equal(retry.journal.screenshotAttempt?.retryConfirmed,true);
  assert.equal(retry.journal.screenshotAttempt?.id,reopened.journal.screenshotAttempt?.id);
  assert.equal(retry.journal.issue?.url,published.journal.issue?.url);
  assert.deepEqual(retry.journal.screenshotItems,published.journal.screenshotItems);
  assert.equal(comments,1);
  const retried = await f.call({op:'upload-screenshots',digest,hashes,confirmed:true});
  assert.deepEqual(retried.journal.screenshotSent,hashes);
  assert.equal(comments,2);
  assert.equal(f.creates(),1);
});


test('retry rechecks the original screenshot comment before writing another', async () => {
  const f = fixture();
  let comments = 0;
  let visible = false;
  f.adapter.attachToIssue = async (_issue,pictures) => {
    if (++comments === 1) throw new Error('lost response after comment');
    return pictures.map(picture=>picture.sha256);
  };
  f.adapter.findIssueScreenshots = async (_issue,hashes) => visible ? hashes.slice(0,1) : undefined;
  const attachments = [20,21].map(size=>({mime:'image/png',base64:pngFixture(size).toString('base64')}));
  const {journal:{digest,id}} = await f.call({op:'save',targetId:'clowder',report:{...report,attachments}});
  await f.call({op:'approve',digest,confirmed:true});
  const published = await f.call({op:'submit',digest});
  assert.ok(published.journal.screenshotItems);
  const hashes = published.journal.screenshotItems.map(item=>item.sha256);
  await f.call({op:'upload-screenshots',digest,hashes,confirmed:true});
  await f.call({op:'retry-screenshots',digest,confirmed:true});
  await f.call({op:'bootstrap',feedbackId:id});

  visible = true;
  const reconciled = await f.call({op:'upload-screenshots',digest,hashes,confirmed:true});
  assert.equal(comments,1);
  assert.deepEqual(reconciled.journal.screenshotSent,hashes.slice(0,1));
  assert.equal(reconciled.journal.screenshotAttempt,undefined);
  const remaining = await f.call({op:'upload-screenshots',digest,hashes:hashes.slice(1),confirmed:true});
  assert.deepEqual(remaining.journal.screenshotSent,hashes);
  assert.equal(comments,2);
  assert.equal(f.creates(),1);
});

test('owner confirmation clears the legacy screenshot notice without a remote write', async () => {
  const f = fixture();
  const {journal:{digest,id}} = await f.call({op:'save',targetId:'clowder',report});
  await f.call({op:'approve',digest,confirmed:true});
  await f.call({op:'submit',digest});
  const key = feedbackKey(f.ctx.userId,id);
  const stored = (await f.host.storage.get(key))!;
  await f.host.storage.compareAndSet(key,stored.revision,{...stored.value as Journal,screenshotCommentUnverified:true});
  const reopened = await f.call({op:'bootstrap',feedbackId:id}) as Awaited<ReturnType<typeof f.call>> & { items: { screenshotsPending?: string }[] };
  assert.equal(reopened.items[0]?.screenshotsPending,'verify');
  const confirmed = await f.call({op:'confirm-screenshots',digest,confirmed:true});
  assert.equal(confirmed.journal.screenshotsConfirmed,true);
  assert.equal(confirmed.journal.issue?.url,reopened.journal.issue?.url);
  const rechecked = await f.call({op:'bootstrap',feedbackId:id}) as typeof reopened;
  assert.equal(rechecked.items[0]?.screenshotsPending,undefined);
  assert.equal(f.creates(),1);
});

test('an Issue published by alpha.7 can upload the saved screenshots in place', async () => {
  const f = fixture();
  const image = {mime:'image/png',base64:pngFixture().toString('base64')};
  f.adapter.attachToIssue = async (_issue,pictures)=>pictures.map(picture=>picture.sha256);
  const saved = await f.call({op:'save',targetId:'clowder',report:{...report,attachments:[image]}});
  const {digest,id} = saved.journal;
  await f.call({op:'approve',digest,confirmed:true});
  await f.call({op:'submit',digest});
  const key = feedbackKey(f.ctx.userId,id);
  const state = (await f.host.storage.get(key))!;
  const journal = state.value as Journal;
  await f.host.storage.compareAndSet(key,state.revision,{...journal,screenshotItems:undefined,addScreenshotsLater:true});
  const reopened = await f.call({op:'bootstrap',feedbackId:id});
  const hash = reopened.journal.report.attachments[0]?.sha256;
  assert.ok(hash);
  const result = await f.call({op:'upload-screenshots',digest,hashes:[hash],confirmed:true});
  assert.deepEqual(result.journal.screenshotSent,[hash]);
  assert.equal(f.creates(),1);
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
