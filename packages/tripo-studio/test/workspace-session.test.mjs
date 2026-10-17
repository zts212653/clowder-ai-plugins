import assert from 'node:assert/strict';
import test from 'node:test';
import { workspaceSession } from '../plugins/tripo-studio/extension/workspace-session.mjs';

function fake() {
  const stored = { workspaceGrant: { tabId: 7 } };
  let calls = 0;
  let snapshot = {
    loggedIn: true,
    pageUrl: 'https://studio.tripo3d.ai/workspace/generate',
    privacy: 'Private',
    model: 'P2.0',
    generationLabel: 'Generate 100',
    creditCost: 100,
    quantity: 1,
    canSubmit: true,
    imageSlots: [{}],
  };
  const chrome = {
    storage: {
      local: {
        get: async (key) =>
          key === null ? structuredClone(stored) : { [key]: stored[key] },
        set: async (values) => Object.assign(stored, structuredClone(values)),
      },
    },
    tabs: { get: async () => ({ url: snapshot.pageUrl }) },
    scripting: {
      executeScript: async ({ args }) => {
        calls++;
        const command = args[0];
        return [
          {
            result:
              command.kind === 'submit'
                ? { receipt: null }
                : command.kind === 'upload-file'
                  ? { ...snapshot, dispatched: true }
                  : snapshot,
          },
        ];
      },
    },
  };
  const run = workspaceSession(
    chrome,
    async () => ({
      focusedWindowId: 1,
      activeTabs: [{ windowId: 1, tabId: 3 }],
    }),
    {},
  );
  return { run, stored, snapshot, chrome, calls: () => calls };
}
const upload = {
  kind: 'upload',
  view: 'front',
  name: 'front.png',
  mime: 'image/png',
  sha256: 'a'.repeat(64),
  bytes: 3,
  index: 0,
  total: 1,
  data: 'YWJj',
};
test('read-only authorization cannot operate the workspace and revoked grants stop before page dispatch', async () => {
  const f = fake();
  delete f.stored.workspaceGrant;
  await assert.rejects(f.run({ kind: 'inspect' }), /GENERATION_NOT_AUTHORIZED/);
  assert.equal(f.calls(), 0);
});
test('preview pins credits/privacy/input metadata and attempted browser jobs survive a service-worker restart', async () => {
  const f = fake();
  await f.run({
    kind: 'configure',
    mode: 'Smart Mesh',
    views: 1,
    privacy: 'Private',
  });
  await f.run(upload);
  const prepared = await f.run({
    kind: 'preview',
    jobId: 'b'.repeat(64),
    sourceRef: 'approved-source',
  });
  f.snapshot.generationLabel = 'Generate 200';
  await assert.rejects(
    f.run({
      kind: 'submit',
      jobId: prepared.jobId,
      previewDigest: prepared.digest,
    }),
    /PREVIEW_CHANGED/,
  );
  f.snapshot.generationLabel = 'Generate 100';
  const result = await f.run({
    kind: 'submit',
    jobId: prepared.jobId,
    previewDigest: prepared.digest,
  });
  assert.equal(result.receipt, null);
  assert.equal(
    f.stored[`submission:${prepared.jobId}`].state,
    'submission_unknown',
  );
  const restored = workspaceSession(f.chrome, async () => ({}), {});
  await restored({
    kind: 'configure',
    mode: 'Smart Mesh',
    views: 1,
    privacy: 'Private',
  });
  await restored(upload);
  const again = await restored({
    kind: 'preview',
    jobId: prepared.jobId,
    sourceRef: 'approved-source',
  });
  await assert.rejects(
    restored({
      kind: 'submit',
      jobId: again.jobId,
      previewDigest: again.digest,
    }),
    /ALREADY_ATTEMPTED/,
  );
});
test('one-file preparation does not accept a back image and batch quantity four cannot be previewed', async () => {
  const f = fake();
  await f.run({
    kind: 'configure',
    mode: 'Smart Mesh',
    views: 1,
    privacy: 'Private',
  });
  await assert.rejects(
    f.run({ ...upload, view: 'back' }),
    /CONFIGURE_WORKSPACE_FIRST/,
  );
  await f.run(upload);
  f.snapshot.quantity = 4;
  await assert.rejects(
    f.run({
      kind: 'preview',
      jobId: 'b'.repeat(64),
      sourceRef: 'approved-source',
    }),
    /PREVIEW_NOT_READY/,
  );
});
