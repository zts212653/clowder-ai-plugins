// Explicit isolated consumer: node --import tsx test/packed-tracking-status.mjs <unpacked-package-root>
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse } from 'yaml';
import { memoryStorage } from './memory-storage.ts';

const root = await realpath(process.argv[2] ?? 'missing-explicit-artifact-root');
const load = name => import(pathToFileURL(join(root, 'dist', name)).href);
const { createGitHubPluginModule } = await load('plugin-entrypoint.js');
const { waitKey } = await load('typed-wait-record.js');
const manifest = parse(await readFile(join(root, 'plugin.yaml'), 'utf8'));
const tool = manifest.contributions.find(item => item.type === 'tool' && item.name === 'github_list_tracking');
const requireContract = createRequire(join(root, 'node_modules/@clowder-ai/plugin-contract/package.json'));
const Ajv = requireContract('ajv');
const validate = new Ajv().compile(tool.inputSchema);
assert.equal(manifest.version, '0.1.0-alpha.41');
assert.equal(validate({ repo: 'example/repo-1', catId: 'cat-1', limit: 5 }), true);
assert.equal(validate({ limit: 51 }), false);
assert.equal(validate({ subjectKey: 'pr:example/repo-1#1' }), false, 'observation reads keep their existing tool');
const inspect = manifest.contributions.find(item => item.type === 'tool' && item.name === 'github_inspect_subject');
assert.deepEqual(Object.keys(inspect.inputSchema.properties).sort(), ['fromSequence', 'limit', 'subjectKey']);
const storage = memoryStorage(); let providerReads = 0;
const unexpected = async () => { throw new Error('Unexpected external operation'); };
const host = { pluginInstanceId: 'isolated-packed-status', dataPath: '/unused-in-memory', storage,
  config: { get: async () => undefined }, secrets: { get: async () => undefined },
  tasks: { get: async () => null, list: async () => [], create: unexpected, update: unexpected },
  members: { list: async () => [], get: async () => null },
  threads: { get: async () => null, list: async () => [], readMessages: unexpected, getCats: unexpected,
    create: unexpected, update: unexpected, addParticipants: unexpected },
  messaging: { send: unexpected }, streams: { read: unexpected }, log: () => {} };
const active = await createGitHubPluginModule({ pollIntervalMs: 0,
  createProvider: () => ({ read: async () => { providerReads++; return unexpected(); }, selfLogin: () => undefined }),
}).create(manifest).start(host);
try {
  const hash = value => createHash('sha256').update(value).digest('hex');
  for (let i = 0; i < 300; i++) {
    const task = { id: `packed-${i}`, kind: 'pr_tracking', subjectKey: `pr:example/repo-${i % 3}#${i + 1}`,
      userId: 'isolated-owner', ownerCatId: `cat-${i % 4}`, threadId: `thread-${i % 5}`,
      title: 'Synthetic', why: '', status: 'doing', createdBy: 'system', createdAt: 1, updatedAt: 1,
      automationState: { await: { generation: 7 } } };
    await storage.set(waitKey(task.id), { schemaVersion: 1, task, recovery: {
      v: 1, scope: hash(task.id), revision: 9, failures: 5, nextPollAt: 0, index: 'github-pr-waits',
      disposition: 'needs_attention', reasonCode: 'github_observation_failed',
      notices: Object.fromEntries(Array.from({ length: 100 }, (_, j) => [`notice-${j}`, { state: 'delivered', history: 'x'.repeat(500) }])) } });
  }
  const before = JSON.stringify(await storage.list());
  const caller = { userId: 'isolated-owner', catId: 'cat-1', threadId: 'thread-1', invocationId: 'isolated-packed', assertCurrent: async () => {} };
  const run = async input => { assert.equal(validate(input), true); return active.actions[tool.action.method](input, caller); };
  const query = { repo: 'example/repo-1', catId: 'cat-1', limit: 5 };
  const seen = new Set(); let cursor, pages = 0, maximumBytes = 0;
  do {
    const result = await run({ ...query, ...(cursor ? { cursor } : {}) });
    maximumBytes = Math.max(maximumBytes, Buffer.byteLength(JSON.stringify(result)));
    assert.ok(result.data.tracking.length <= 5);
    for (const task of result.data.tracking) {
      assert.equal(task.ownerCatId, 'cat-1'); assert.match(task.subjectKey, /:example\/repo-1#/);
      assert.equal(task.automationState.await.generation, 7); assert.ok(!seen.has(task.id)); seen.add(task.id);
      const facts = result.data.recoveryOwners.typed.find(row => row.taskId === task.id).recovery;
      assert.equal(facts.scope, hash(task.id)); assert.equal(facts.revision, 9); assert.equal(facts.noticeSummary.total, 100);
    }
    cursor = result.data.page.nextCursor; assert.ok(++pages < 100);
  } while (cursor);
  assert.equal(seen.size, 25); assert.ok(maximumBytes <= 65_536);
  assert.equal(JSON.stringify(await storage.list()), before); assert.equal(providerReads, 0);
  const selectedKey = waitKey('packed-1'), selected = (await storage.get(selectedKey)).value;
  const error = { name: 'Error', message: 'GitHub command failed', code: 1,
    stderr: 'gh: Forbidden (HTTP 403); ghp_IsolatedFixtureToken123',
    cause: { name: 'Error', message: 'upstream permission denied ghp_IsolatedFixtureToken123' } };
  selected.recovery.lastError = error; selected.task.title = 't'.repeat(900);
  selected.task.automationState.retainedPayload = 'x'.repeat(9000);
  await storage.set(selectedKey, selected);
  await storage.set('github.tracking-diagnostics.v1.' + hash('packed-error'), {
    requestKey: hash('packed-error'), subject: selected.task.subjectKey, catId: 'cat-1', threadId: 'thread-1',
    at: 1, attempts: 1, phase: 'read_github', status: 'failed', code: 'provider_read_failed', error });
  const diagnosticBefore = JSON.stringify(await storage.list());
  const diagnostics = await run({ view: 'diagnostics', repo: 'example/repo-1' });
  const recovery = await run({ view: 'recovery', repo: 'example/repo-1', catId: 'cat-1', threadId: 'thread-1' });
  const recovered = recovery.data.recoveryOwners.typed.find(row => row.taskId === 'packed-1');
  for (const result of [diagnostics, recovery]) {
    assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 65_536);
    assert.ok(!JSON.stringify(result).includes('ghp_IsolatedFixtureToken123'));
  }
  for (const exposed of [diagnostics.data.diagnostics[0].error, recovered.recovery.lastError]) {
    assert.match(exposed.stderr, /Forbidden \(HTTP 403\)/); assert.match(exposed.cause.message, /permission denied/);
  }
  assert.ok(recovery.data.tracking.find(task => task.id === 'packed-1').omittedFields.includes('title'));
  assert.equal(JSON.stringify(await storage.list()), diagnosticBefore); assert.equal(providerReads, 0);
  console.log(JSON.stringify({ artifactRoot: root, version: manifest.version, declaredTool: tool.name,
    fixtureSubscriptions: 300, matched: seen.size, pages, maximumResponseBytes: maximumBytes,
    diagnosticStderrRetained: true, causeExcerptRetained: true, titleOmissionRetained: true,
    diagnosticResponseBytes: Buffer.byteLength(JSON.stringify(diagnostics)), recoveryResponseBytes: Buffer.byteLength(JSON.stringify(recovery)),
    storageUnchanged: true, providerReads, consumer: 'isolated bundled module with manifest input validation',
    productionInstallation: 'not changed or accepted' }, null, 2));
} finally { await active.stop({ reason: 'isolated-packed-status-complete' }); }
