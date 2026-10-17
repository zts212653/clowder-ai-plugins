import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { Receiver } from '../src/engine.mjs';
import { gitPrFixture } from './git-pr-fixtures.mjs';

test('Git push options automatically create and register a PR during preparation, with no manual link step', async () => {
  const f = await gitPrFixture();
  const receiver = new Receiver(f.config);
  await receiver.adopt(f.u0, f.i0);
  await receiver.selectTag('v2.0.0');
  await receiver.start();
  await receiver.prepare();
  const delivery = (await receiver.status()).active;
  assert.equal(delivery.status, 'WAITING_APPROVAL');
  assert.equal(delivery.prUrl, 'https://codehub.example/core/-/merge_requests/501');
  const receipt = JSON.parse(await readFile(f.resultFile));
  assert.ok(receipt.opts.includes('merge_request.create'));
  assert.ok(receipt.opts.includes('merge_request.target=main'));
  assert.ok(receipt.opts.some((option) => option.startsWith('merge_request.description=') && option.includes('\\n')));
  assert.doesNotMatch(JSON.stringify(await receiver.status()), /private diagnostic/);
  assert.equal((await receiver.git.heads()).internal, f.i0);
  await f.merge(delivery);
  await receiver.recover();
  assert.equal((await receiver.status()).accepted.tag, 'v2.0.0');
});
test('Git creation with no receipt never falls back to manual creation or retries an existing push', async () => {
  const f = await gitPrFixture('missing');
  const receiver = new Receiver(f.config);
  await receiver.adopt(f.u0, f.i0);
  await receiver.selectTag('v2.0.0');
  await receiver.start();
  await assert.rejects(() => receiver.prepare(), { code: 'GIT_PR_LINK_UNKNOWN' });
  const delivery = (await receiver.status()).active;
  assert.equal(await receiver.git.remoteBranch(delivery.branch), delivery.candidate);
  await assert.rejects(() => receiver.createPr(), { code: 'GIT_PR_LINK_UNKNOWN' });
  assert.equal((await receiver.status()).active.prUrl, undefined);
  assert.equal(JSON.parse(await readFile(f.resultFile)).count, 1);
});
test('unsupported Git push options pause without publishing or silently requiring a manual PR', async () => {
  const f = await gitPrFixture();
  const { git } = await import('../src/process.mjs');
  await git(f.internal, ['config', 'receive.advertisePushOptions', 'false']);
  const receiver = new Receiver(f.config);
  await receiver.adopt(f.u0, f.i0);
  await receiver.selectTag('v2.0.0');
  await receiver.start();
  await assert.rejects(() => receiver.prepare(), { code: 'GIT_PR_UNSUPPORTED' });
  assert.equal(await receiver.git.remoteBranch((await receiver.status()).active.branch), null);
});
test('ambiguous Git receipts are not guessed and recovering does not create another PR', async () => {
  const f = await gitPrFixture('ambiguous');
  const receiver = new Receiver(f.config);
  await receiver.adopt(f.u0, f.i0);
  await receiver.selectTag('v2.0.0');
  await receiver.start();
  await assert.rejects(() => receiver.prepare(), { code: 'GIT_PR_RESPONSE_AMBIGUOUS' });
  await assert.rejects(() => receiver.recover(), { code: 'GIT_PR_LINK_UNKNOWN' });
  assert.equal(JSON.parse(await readFile(f.resultFile)).count, 1);
});
test('an already published manual candidate gets a dedicated PR branch at the same checked commit', async () => {
  const f = await gitPrFixture();
  const manual = new Receiver({ ...f.config, pullRequests: undefined });
  await manual.adopt(f.u0, f.i0);
  await manual.selectTag('v2.0.0');
  await manual.start();
  await manual.prepare();
  const before = (await manual.status()).active;
  const automatic = new Receiver(f.config);
  await automatic.prepare();
  const after = (await automatic.status()).active;
  assert.equal(after.candidate, before.candidate);
  assert.equal(after.branch, `${before.branch}-pr`);
  assert.equal(await automatic.git.remoteBranch(before.branch), before.candidate);
  assert.equal(after.status, 'WAITING_APPROVAL');
  assert.equal(JSON.parse(await readFile(f.resultFile)).count, 1);
});

test('withdrawn automatic reference stays withdrawn after recovery and never creates a second PR', async () => {
  const f = await gitPrFixture();
  const receiver = new Receiver(f.config);
  await receiver.adopt(f.u0, f.i0);
  await receiver.selectTag('v2.0.0');
  await receiver.start();
  await receiver.prepare();
  const before = (await receiver.status()).active;
  await receiver.linkPr(null, { previousUrl: before.prUrl });
  await assert.rejects(() => receiver.recover(), { code: 'PR_REFERENCE_WITHDRAWN' });
  assert.equal((await receiver.status()).active.prUrl, undefined);
  assert.equal(JSON.parse(await readFile(f.resultFile)).count, 1);
});

test('Git receipt cannot overwrite an operator correction after a paused preparation', async () => {
  const f = await gitPrFixture();
  const receiver = new Receiver(f.config);
  await receiver.adopt(f.u0, f.i0);
  await receiver.selectTag('v2.0.0');
  await receiver.start();
  await receiver.prepare();
  await receiver.linkPr('https://codehub.example/core/-/merge_requests/502', {
    previousUrl: 'https://codehub.example/core/-/merge_requests/501',
  });
  const state = await receiver.read();
  state.deliveries[0].error = { code: 'PAUSED', message: 'synthetic pause' };
  await receiver.store.save(state);
  await assert.rejects(() => receiver.prepare(), { code: 'PR_MAPPING_CONFLICT' });
  assert.equal((await receiver.status()).active.prUrl, 'https://codehub.example/core/-/merge_requests/502');
  assert.equal(JSON.parse(await readFile(f.resultFile)).count, 1);
});
