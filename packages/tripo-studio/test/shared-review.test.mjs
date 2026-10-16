import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { launchIsolatedChrome } from '../plugins/tripo-studio/runtime/isolated-chrome.mjs';
import { closeActiveReview, reviewSharedModel } from '../plugins/tripo-studio/runtime/shared-review.mjs';

const page = 'https://studio.tripo3d.ai/3d-model/11111111-1111-4111-8111-111111111111';
const other = page.replace('11111111-', '22222222-');
const foreground = async () => ({ status: 'observed', applicationPid: 1, chromeWindows: [] });
test('route change after orbit cannot publish files or provenance under the original candidate', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'tripo-route-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let shots = 0;
  let closed = false;
  const launch = async () => ({
    close: async () => {
      closed = true;
    },
    cdp: {
      call: async (method) =>
        method === 'Page.captureScreenshot' ? { data: Buffer.from(`test-shot-${++shots}`).toString('base64') } : {},
      evaluate: async (expression) =>
        expression === 'location.href'
          ? page
          : expression.includes('Faces|Vertices')
            ? { ready: true, url: page, canvas: { x: 0, y: 0, width: 100, height: 100 }, text: '' }
            : { pageUrl: other, resources: [] },
    },
  });
  await assert.rejects(
    reviewSharedModel(page, 1, root, { launch, foreground, delay: async () => {} }),
    /SHARED_PAGE_CHANGED/,
  );
  assert.equal(closed, true);
  assert.deepEqual(await readdir(root), []);
});

test('closing a review during launch cancels its owned child and removes the temporary profile', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'tripo-cancel-'));
  let owned, profile, started;
  const spawned = new Promise((resolve) => {
    started = resolve;
  });
  const launch = (options) =>
    launchIsolatedChrome({
      ...options,
      executable: 'injected-test-browser',
      startupTimeoutMs: 2000,
      spawnBrowser: (_command, args, config) => {
        profile = args.find((arg) => arg.startsWith('--user-data-dir=')).slice('--user-data-dir='.length);
        owned = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], config);
        started();
        return owned;
      },
    });
  const outcome = reviewSharedModel(page, 1, root, { launch, foreground }).then(
    (result) => ({ result }),
    (error) => ({ error }),
  );
  t.after(async () => {
    await outcome;
    await rm(root, { recursive: true, force: true });
  });
  await spawned;
  await closeActiveReview();
  assert.throws(() => process.kill(owned.pid, 0), { code: 'ESRCH' });
  await assert.rejects(access(profile), { code: 'ENOENT' });
  assert.match((await outcome).error.message, /abort|CANCELLED/i);
  assert.deepEqual(await readdir(root), []);
});

test('caller cancellation during startup releases the browser and review slot', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'tripo-request-cancel-'));
  t.after(async () => {
    await closeActiveReview();
    await rm(root, { recursive: true, force: true });
  });
  const controller = new AbortController();
  let started;
  const running = new Promise((resolve) => {
    started = resolve;
  });
  const launch = ({ signal }) =>
    new Promise((_resolve, reject) => {
      started();
      const timer = setTimeout(() => reject(new Error('STARTUP_NOT_CANCELLED')), 200);
      signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          reject(signal.reason);
        },
        { once: true },
      );
    });
  const outcome = reviewSharedModel(page, 1, root, { launch, foreground, signal: controller.signal });
  await running;
  controller.abort();
  await assert.rejects(outcome, /abort/i);
  assert.deepEqual(await readdir(root), []);
  await assert.rejects(reviewSharedModel('invalid', 1, root), /Invalid URL/);
});
