import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkspaceJobs } from '../plugins/tripo-studio/runtime/workspace-jobs.mjs';

// A lost supplier response must never turn into a second credit-consuming click,
// including after the MCP process restarts.
test('an accepted generation job is persisted before click and cannot be automatically resubmitted', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'tripo-workspace-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const jobs = new WorkspaceJobs(root);
  const draft = {
    sourceRef: 'approved-cat-reference',
    inputHashes: ['a'.repeat(64)],
    pageUrl: 'https://studio.tripo3d.ai/workspace/generate',
    settings: { privacy: 'Private' },
  };
  const prepared = await jobs.prepare('cat-first-model', draft);
  assert.equal(prepared.state, 'prepared');
  let clicks = 0;
  await assert.rejects(
    jobs.submit(prepared.jobId, prepared.digest, async () => {
      clicks++;
      throw new Error('CONNECTION_LOST');
    }),
    /CONNECTION_LOST/,
  );
  const restarted = new WorkspaceJobs(root);
  assert.equal(
    (await restarted.read(prepared.jobId)).state,
    'submission_unknown',
  );
  await assert.rejects(
    restarted.submit(prepared.jobId, prepared.digest, async () => {
      clicks++;
    }),
    /ALREADY_ATTEMPTED/,
  );
  assert.equal(clicks, 1);
});

test('changed preview or concurrent submission cannot submit; unknown state remains blocked', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'tripo-workspace-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const jobs = new WorkspaceJobs(root);
  const prepared = await jobs.prepare('cat-once', {
    inputHashes: ['b'.repeat(64)],
    privacy: 'Private',
  });
  await assert.rejects(
    jobs.submit(prepared.jobId, 'stale-preview', async () => {}),
    /PREVIEW_CHANGED/,
  );
  let release, started;
  const entered = new Promise((resolve) => {
    started = resolve;
  });
  const waiting = new Promise((resolve) => {
    release = resolve;
  });
  const first = jobs.submit(prepared.jobId, prepared.digest, async () => {
    started();
    await waiting;
    return { receipt: null };
  });
  await entered;
  await assert.rejects(
    jobs.submit(prepared.jobId, prepared.digest, async () => {}),
    /BUSY|ALREADY_ATTEMPTED/,
  );
  release();
  await first;
  assert.equal((await jobs.read(prepared.jobId)).state, 'submission_unknown');
});
