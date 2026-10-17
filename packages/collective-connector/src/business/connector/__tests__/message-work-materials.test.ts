import {createHash} from 'node:crypto';
import {expect, test} from 'vitest';
import type {FeatureContext} from '@clowder-ai/plugin-sdk';
import {createCollectiveMessageWorkArtifacts} from '../../../collective-message-work-artifacts.js';
import type {createCollectiveMessageWorkMaterials} from '../../../collective-message-work-materials.js';

function fixture() {
  let active = true;
  const entries = new Map<string, {revision: number; value: unknown}>();let revision = 0;
  const text = '# Original document\n';
  const capture = {v: 1 as const, taskRef: 'task:work:task', workId: 'work', resultRevision: 1, executionRevision: 1,
    invocationId: 'publisher', triggerMessageId: 'trigger', trigger: {},
    message: {id: 'publication', threadId: 'private', userId: 'owner', catId: 'cat', content: 'Published',
      timestamp: 2, sourceRevision: 'published-1', mentions: []},
    files: [{index: 0, block: {id: 'file', url: '/uploads/report.md', mimeType: 'text/markdown'}, text,
      contentDigest: 'sha256:' + createHash('sha256').update(text).digest('hex')}]};
  let available = true;
  const context = {storage: {get: async (key: string) => structuredClone(entries.get(key)),
    compareAndSet: async (key: string, expected: number | null, value: unknown) => {
      if ((entries.get(key)?.revision ?? null) !== expected) return {applied: false};
      entries.set(key, {revision: ++revision, value: structuredClone(value)});return {applied: true, revision};
    }}, threads: {readMessages: async () => [{id: 'publication', timestamp: 2}]}} as unknown as FeatureContext;
  const materials = {read: async () => available ? structuredClone(capture) : undefined} as unknown as ReturnType<typeof createCollectiveMessageWorkMaterials>;
  const artifacts = createCollectiveMessageWorkArtifacts(context, materials);
  const binding = {auth: {userId: 'owner', threadId: 'private', catId: 'cat'}, resultKey: 'work:task',
    work: {workId: 'work', revision: 1234, resultRevision: 1, executionRevision: 1, assignmentEventId: 'assignment'},
    artifactRefs: [] as string[],
    registerArtifactRefs: async (expected: number, artifactRefs: readonly string[]) => {
      if (!active) throw Error('stopped');
      if (expected !== binding.work.revision) throw Object.assign(Error('revision'), {code: 'WORK_ARTIFACT_REVISION_CONFLICT'});
      binding.work = {...binding.work, revision: expected + 1};binding.artifactRefs = [...artifactRefs];
    },
    revalidate: async () => {if (!active) throw Error('stopped');}} as unknown as Parameters<typeof artifacts.current>[0];
  return {artifacts, binding, capture, text, remove: () => {available = false;}, stop: () => {active = false;}};
}

test('received file stays unselected; explicit registration uses the canonical Task revision', async () => {
  const f = fixture();
  expect(await f.artifacts.readSelected(f.binding)).toBeUndefined();
  expect(await f.artifacts.register(f.binding, 1234, ['/uploads/report.md'])).toEqual({revision: 1235, artifactRefs: ['/uploads/report.md']});
  const result = await f.artifacts.readSelected(f.binding);
  expect(result?.text).toBe(f.text);expect(result?.snapshot.taskRevision).toBe(1235);
  expect(result?.snapshot.textPublication).toMatchObject({publisherCatId: 'cat', invocationId: 'publisher', triggerMessageId: 'trigger'});
});

test('stale registration cannot overwrite a newer explicit choice', async () => {
  const f = fixture();await f.artifacts.register(f.binding, 1234, ['/uploads/report.md']);
  await expect(f.artifacts.register(f.binding, 1234, ['/uploads/other.md'])).rejects.toMatchObject({code: 'WORK_ARTIFACT_REVISION_CONFLICT'});
  expect((await f.artifacts.current(f.binding)).artifactRefs).toEqual(['/uploads/report.md']);
});

test('missing publication and multiple explicit refs refuse rather than choose or downgrade', async () => {
  const f = fixture();await f.artifacts.register(f.binding, 1234, ['/uploads/report.md']);f.remove();
  await expect(f.artifacts.readSelected(f.binding)).rejects.toThrow();
  await expect(f.artifacts.register(f.binding, 1235, ['/uploads/report.md', '/uploads/other.md'])).rejects.toThrow();
  expect(f.binding.work.revision).toBe(1235);expect(f.binding.artifactRefs).toEqual(['/uploads/report.md']);
});

test('explicitly retained publication is data across later results; another Task or stopped invocation cannot satisfy it', async () => {
  const f = fixture();await f.artifacts.register(f.binding, 1234, ['/uploads/report.md']);
  f.binding.work = {...f.binding.work, resultRevision: 2, executionRevision: 2};
  expect((await f.artifacts.readSelected(f.binding))?.text).toBe(f.text);
  f.capture.taskRef = 'task:work:foreign';await expect(f.artifacts.readSelected(f.binding)).rejects.toThrow();
  f.stop();await expect(f.artifacts.current(f.binding)).rejects.toThrow('stopped');
});

test('internal explicit registration rejects empty, multiple and duplicate refs before mutation and canonicalizes a single ref', async () => {
  const f = fixture();
  for (const refs of [[], ['/uploads/z.md', '/uploads/a.md'], ['/uploads/a.md', '/uploads/a.md']]) {
    await expect(f.artifacts.register(f.binding, 1234, refs)).rejects.toThrow();
    expect(f.binding.work.revision).toBe(1234);expect(f.binding.artifactRefs).toEqual([]);
  }
  const selected = await f.artifacts.register(f.binding, 1234, [' /uploads/report.md ']);
  expect(selected).toEqual({revision: 1235, artifactRefs: ['/uploads/report.md']});
  expect((await f.artifacts.readSelected(f.binding))?.text).toBe(f.text);
});
