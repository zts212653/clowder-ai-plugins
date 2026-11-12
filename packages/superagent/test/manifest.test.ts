import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { validateManifest } from '@clowder-ai/plugin-contract';
import { parse } from 'yaml';
import { z } from 'zod';
import { parse } from 'yaml';
import { planSchema, reportSchema } from '../src/state.js';

test('published tool schemas describe exactly what the runtime accepts', async () => {
  const manifest = parse(await readFile(new URL('../plugin.yaml', import.meta.url), 'utf8'));
  for (const [id, schema] of Object.entries({
    inspect: z.object({}).strict(),
    route: planSchema.omit({ applied: true }),
    report: reportSchema.omit({ applied: true, invocationId: true }),
  })) {
    const { $schema: _dialect, ...expected } = z.toJSONSchema(schema, { target: 'draft-7' });
    assert.deepEqual(
      manifest.contributions.find((row: { id: string }) => row.id === id).inputSchema,
      expected,
      `${id} must not advertise unsupported parameters`,
    );
  }
});

test('the manifest declares members and conversations as configuration the contract accepts', async () => {
  const manifest = parse(await readFile(new URL('../plugin.yaml', import.meta.url), 'utf8'));
  assert.deepEqual(validateManifest(manifest).errors ?? [], []);
  assert.deepEqual(
    manifest.configuration.map((field: { key: string; kind: string; multiple?: boolean }) => [
      field.key,
      field.kind,
      field.multiple ?? false,
    ]),
    [
      ['botName', 'string', false],
      ['responsibility', 'string', false],
      ['coordinatorId', 'member', false],
      ['workerIds', 'member', true],
      ['threadIds', 'thread', true],
      ['activity', 'operation', false],
      ['pause', 'operation', false],
      ['recovery', 'operation', false],
    ],
  );
});
