import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { validateManifest } from '@clowder-ai/plugin-contract';

import {
  createFeishuTranscriptSourceAdapter,
  normalizeGeneratedArtifact,
  parseFeishuSourceHandle,
  type FeishuPollingGateway,
  type FeishuTranscriptGateway,
} from './index.js';

const DESCRIPTOR = {
  artifactId: 'om_abc123',
  kind: 'minute',
  revision: '7',
  generatedAt: '2026-08-09T04:12:31Z',
  title: 'F292 design review',
  meetingId: 'meeting-42',
} as const;

test('ships a contract-valid stdio manifest with one declared signal', async () => {
  const manifest: unknown = JSON.parse(
    await readFile(new URL('../manifest.json', import.meta.url), 'utf8'),
  );
  const packageMetadata: unknown = JSON.parse(
    await readFile(new URL('../package.json', import.meta.url), 'utf8'),
  );
  const result = validateManifest(manifest);
  assert.equal(result.valid, true, result.valid ? undefined : JSON.stringify(result.errors));
  if (result.valid) {
    assert.equal(result.manifest.version, '0.1.0-alpha.3');
    assert.equal(
      (packageMetadata as { readonly version?: unknown }).version,
      result.manifest.version,
      'manifest and immutable npm artifact versions must match',
    );
    assert.deepEqual(result.manifest.runtime, {
      transport: 'stdio',
      entrypoint: 'dist/entrypoint.js',
    });
    assert.deepEqual(result.manifest.signals?.provides, [
      {
        type: 'feishu.meeting_artifact.generated.v1',
        schemaRef: 'schemas/feishu-meeting-artifact.schema.json',
        epistemicStatus: 'observation',
        privacyClass: 'content-adjacent',
        sourceClass: 'remote-service',
      },
    ]);
  }
});

test('normalizes bounded metadata into a destination-free declared signal', () => {
  assert.deepEqual(normalizeGeneratedArtifact(DESCRIPTOR), {
    signalType: 'feishu.meeting_artifact.generated.v1',
    eventId: 'feishu-minute-om_abc123-v7',
    idempotencyKey: 'feishu:minute:om_abc123:7',
    occurredAt: '2026-08-09T04:12:31Z',
    payload: {
      artifactId: 'om_abc123',
      artifactKind: 'minute',
      revision: '7',
      title: 'F292 design review',
      meetingId: 'meeting-42',
    },
    source: {
      handle: 'feishu://meeting-artifacts/minute/om_abc123?revision=7',
    },
  });
});

test('rejects transcript leakage, open descriptors, and hostile identifiers', () => {
  for (const candidate of [
    { ...DESCRIPTOR, transcript: 'must not enter the event' },
    { ...DESCRIPTOR, artifactId: '../../secrets' },
    { ...DESCRIPTOR, title: 'a'.repeat(513) },
    { ...DESCRIPTOR, generatedAt: '2026-08-09' },
  ]) {
    assert.throws(() => normalizeGeneratedArtifact(candidate));
  }
});

test('parses only canonical source handles and resolves transcript through the injected gateway', async () => {
  const calls: unknown[] = [];
  const signal = new AbortController().signal;
  const gateway: FeishuTranscriptGateway = {
    resolveGrantedTranscript: async (request) => {
      calls.push(request);
      return { text: 'Speaker 1: hello', contentType: 'text/plain' };
    },
  };
  const adapter = createFeishuTranscriptSourceAdapter(gateway);
  const handle = 'feishu://meeting-artifacts/minute/om_abc123?revision=7';

  assert.deepEqual(parseFeishuSourceHandle(handle), {
    artifactId: 'om_abc123',
    kind: 'minute',
    revision: '7',
  });
  assert.deepEqual(await adapter.resolve({
    sourceHandle: handle,
    intakeId: 'intake-1',
    sourceGrant: 'source-grant-1',
  }, signal), {
    text: 'Speaker 1: hello',
    contentType: 'text/plain',
  });
  assert.deepEqual(calls, [
    {
      locator: { artifactId: 'om_abc123', kind: 'minute', revision: '7' },
      sourceHandle: handle,
      intakeId: 'intake-1',
      sourceGrant: 'source-grant-1',
      signal,
    },
  ]);

  await assert.rejects(
    adapter.resolve({
      sourceHandle: handle,
      intakeId: 'intake-1',
      sourceGrant: '',
    }, signal),
    /source grant/,
  );
  assert.equal(calls.length, 1, 'ungranted resolution must stop before Host gateway');

  for (const invalid of [
    '/tmp/meeting.txt',
    'file:///tmp/meeting.txt',
    'https://attacker.example/minutes/om_abc123',
    'feishu://meeting-artifacts/minute/om_abc123?revision=7&threadId=thread-1',
    'feishu://meeting-artifacts/minute/om_abc123?revision=7#',
    'feishu://meeting-artifacts/minute/om_abc123?revision=7&',
    'feishu://meeting-artifacts:8443/minute/om_abc123?revision=7',
  ]) {
    assert.throws(() => parseFeishuSourceHandle(invalid));
    await assert.rejects(
      adapter.resolve({
        sourceHandle: invalid,
        intakeId: 'intake-1',
        sourceGrant: 'source-grant-1',
      }, signal),
    );
  }
  assert.equal(calls.length, 1, 'noncanonical aliases must stop before Host gateway');
});

test('keeps polling metadata gateway separate from transcript authority', () => {
  const polling: FeishuPollingGateway = {
    listGeneratedArtifacts: async () => ({ artifacts: [], nextCursor: null }),
    inspectArtifact: async () => DESCRIPTOR,
  };
  assert.deepEqual(Object.keys(polling).sort(), ['inspectArtifact', 'listGeneratedArtifacts']);
});
