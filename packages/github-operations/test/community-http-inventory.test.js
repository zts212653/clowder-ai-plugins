import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parse } from 'yaml';
import { validateManifest } from '@clowder-ai/plugin-contract';
import { createCommunityHttpRouter } from '../src/community-http-router.js';
import { CommunityProjectionOperations } from '../src/business/domains/community/community-projector.js';
import { memoryStorage } from './memory-storage.js';

const manifest = parse(readFileSync(new URL('../plugin.yaml', import.meta.url), 'utf8'));
const handler = 'github.community.http';
const retiredPath = 'github/community-issue-drafts/from-frustration-issue/:issueId';

test('every declared owner Community route reaches the real router', async t => {
  const declarations = manifest.contributions.filter(c => c.type === 'webhook' && c.action.method === handler);
  assert.ok(declarations.length > 0);
  assert.equal(declarations.some(c => c.path === retiredPath), false);
  assert.ok(declarations.every(c => c.verificationSecretRef === undefined &&
    manifest.features.some(f => f.contributions.some(r => r.type === 'webhook' && r.id === c.id))));
  assert.equal(manifest.contributions.some(c => c.type === 'tool' && c.action.method === handler), false);
  const validation = validateManifest(manifest);
  assert.equal(validation.valid, true, JSON.stringify(validation.errors));
  const router = await createCommunityHttpRouter({
    storage: memoryStorage(),
    threads: { get: async () => null, create: async () => { throw new Error('Unexpected thread creation'); } },
    projectionOperations: new CommunityProjectionOperations(), issues: {},
    drafts: { createDraft: async () => { throw new Error('Unexpected draft creation'); },
      publisher: { create: async () => { throw new Error('Unexpected external publication'); }, find: async () => null },
      config: { defaultRepo: 'org/repo', repoAllowlist: ['org/repo'] } },
  });
  t.after(() => router.stop());
  for (const declaration of declarations) for (const method of declaration.methods) {
    const path = declaration.path.replace(/:[A-Za-z]+/g, 'missing');
    const response = await router.forwardOwner({ principal: { kind: 'owner', id: 'owner' },
      method, path, query: { repo: 'org/repo' }, ...(method === 'GET' ? {} : { body: {} }) });
    assert.notEqual(response.body?.code, 'FST_ERR_NOT_FOUND', `${method} ${path} has no runtime route`);
    assert.doesNotMatch(String(response.body?.message ?? ''), /^Route .* not found$/, `${method} ${path}`);
  }
  const removed = await router.forwardOwner({ principal: { kind: 'owner', id: 'owner' },
    method: 'POST', path: retiredPath.replace(':issueId', 'missing'), body: {} });
  assert.equal(removed.status, 404);
});
