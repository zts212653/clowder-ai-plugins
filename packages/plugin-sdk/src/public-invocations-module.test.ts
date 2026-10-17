import assert from 'node:assert/strict';
import test from 'node:test';
import { definePlugin, type FeatureContext, FeatureContextRevokedError } from './feature-context.js';
import { definePluginModule } from './module-plugin.js';
import type { ModulePluginHostShape } from './module-host.js';

function input() { return { messageRef: 'message:source', targetCatId: 'cat',
  native: { contributionId: 'native', methods: ['native.reply', 'native.read'] },
  authority: { ref: 'event:1', revision: 'route:3' } }; }
function receipt(status = 'queued') { return { messageRef: 'message:source', entryId: 'entry', status }; }
async function fixture(port?: unknown, capabilities = ['thread.readContent', 'messaging.send']) {
  let context!: FeatureContext;
  const manifest = { pluginId: 'dev.public-admission-fixture', version: '0.1.0', contractVersion: '0.1.0-beta.36', name: 'Admission fixture',
    runtime: { transport: 'builtin', entrypoint: 'dist/index.js' }, features: [{ id: 'admission', name: 'Admission', resources: [], capabilities }] };
  const module = definePluginModule(value => definePlugin({ manifest: value, activate: { admission: value => { context = value; return { actions: {} }; } } }));
  const host = { config: { get: async () => undefined }, secrets: { get: async () => undefined }, storage: {}, tasks: {}, threads: {},
    messaging: {}, media: {}, log() {}, ...(port === undefined ? {} : { publicInvocations: port }) } as unknown as ModulePluginHostShape;
  const activation = await module.create(manifest as never).start(host);
  const api = (context as unknown as { publicInvocations?: { enqueue(input: unknown): Promise<ReturnType<typeof receipt>> } }).publicInvocations;
  return { context, activation, api };
}

test('public admission reaches the module feature with detached input and all custody statuses', async () => {
  const calls: unknown[] = []; let status = 'queued'; const result = receipt();
  const { api, activation } = await fixture({ async enqueue(value: unknown) { calls.push(value); result.status = status; return result; } });
  assert.ok(api, 'Missing module publicInvocations port');
  for (status of ['queued', 'processing', 'terminal']) {
    const value = input(), got = await api.enqueue(value);
    assert.deepEqual(got, receipt(status)); assert.ok(Object.isFrozen(got)); assert.notEqual(got, result);
    const captured = calls.at(-1) as ReturnType<typeof input>;
    assert.notEqual(captured, value); assert.ok(Object.isFrozen(captured.native.methods));
    assert.deepEqual(captured, value); // Host sorts methods; SDK accepts its unsorted input ABI.
    value.native.methods.push('late'); value.authority.revision = 'mutated';
    assert.deepEqual(captured.native.methods, ['native.reply', 'native.read']); assert.equal(captured.authority.revision, 'route:3');
  }
  await activation.stop();
});
test('older carriers keep admission absent while incomplete supplied ports fail closed', async () => {
  const { api, activation } = await fixture(); assert.equal(api, undefined); await activation.stop();
  await assert.rejects(fixture({}), /public invocation port/);
});
test('admission checks both existing grants before calling Host', async () => {
  let calls = 0;
  for (const capabilities of [[], ['thread.readContent'], ['messaging.send']]) {
    const { api, activation } = await fixture({ async enqueue() { calls++; return receipt(); } }, capabilities);
    assert.ok(api); await assert.rejects(() => api.enqueue(input()), /not granted/); await activation.stop();
  }
  assert.equal(calls, 0);
});
test('admission refuses body identities, Host coordinates and malformed authority before effects', async () => {
  let calls = 0; const { api, activation } = await fixture({ async enqueue() { calls++; return receipt(); } }); assert.ok(api);
  const invalid = [null, { ...input(), userId: 'owner' }, { ...input(), pluginInstanceId: 'instance' }, { ...input(), sourceRevision: 1 },
    { ...input(), authority: { ref: 'r', revision: 3 } }, { ...input(), authority: { ref: '', revision: 'v' } },
    { ...input(), native: { contributionId: 'n', methods: [] } }, { ...input(), native: { contributionId: 'n', methods: ['x', 'x'] } },
    { ...input(), native: { contributionId: 'n', methods: ['host.public-invocation.assert-current'] } },
    { ...input(), messageRef: 'message:a b' }, { ...input(), messageRef: 'message:a\n' }, { ...input(), targetCatId: ' cat' }];
  for (const value of invalid) await assert.rejects(() => api.enqueue(value), TypeError);
  assert.equal(calls, 0); await activation.stop();
});
test('admission does not invoke getters or forward prototypes, symbols and sparse arrays', async () => {
  let calls = 0, reads = 0; const { api, activation } = await fixture({ async enqueue() { calls++; return receipt(); } }); assert.ok(api);
  const accessor = { ...input(), get targetCatId() { reads++; return 'cat'; } };
  const methods: string[] = []; methods.length = 1;
  for (const value of [accessor, Object.assign(Object.create({ owner: 'x' }), input()), { ...input(), [Symbol('identity')]: 'x' },
    { ...input(), native: { contributionId: 'native', methods } }]) await assert.rejects(() => api.enqueue(value), TypeError);
  assert.equal(reads, 0); assert.equal(calls, 0); await activation.stop();
});
test('admission preserves opaque UTF16 coordinates and Host message non-whitespace bound', async () => {
  let calls = 0; const { api, activation } = await fixture({ async enqueue(value: ReturnType<typeof input>) { calls++; return { ...receipt(), messageRef: value.messageRef }; } }); assert.ok(api);
  const valid = { ...input(), messageRef: `message:${'😀'.repeat(256)}`, targetCatId: 'cat id', authority: { ref: 'r', revision: 'opaque revision' } };
  assert.equal((await api.enqueue(valid)).messageRef, valid.messageRef);
  await assert.rejects(() => api.enqueue({ ...valid, messageRef: `message:${'😀'.repeat(257)}` }), TypeError);
  await assert.rejects(() => api.enqueue({ ...input(), native: { contributionId: 'x'.repeat(257), methods: ['x'] } }), TypeError);
  assert.equal(calls, 1); await activation.stop();
});
test('admission preserves Host refusal and never retries ambiguous writes', async () => {
  const refusal = new Error('Business authority changed'); let calls = 0;
  const { api, activation } = await fixture({ async enqueue() { calls++; throw refusal; } }); assert.ok(api);
  await assert.rejects(() => api.enqueue(input()), error => error === refusal); assert.equal(calls, 1); await activation.stop();
});
test('admission rejects a late receipt after stop without claiming Host effects were rolled back', async () => {
  let finish!: (value: ReturnType<typeof receipt>) => void; let calls = 0;
  const { api, activation } = await fixture({ async enqueue() { calls++; return new Promise(resolve => { finish = resolve; }); } }); assert.ok(api);
  const pending = api.enqueue(input()); await activation.stop(); finish(receipt('processing'));
  await assert.rejects(pending, FeatureContextRevokedError);
  await assert.rejects(() => api.enqueue(input()), FeatureContextRevokedError); assert.equal(calls, 1);
});
test('admission rejects widened or mismatched receipts and never exposes business delivery truth', async () => {
  let value: unknown; const { api, activation } = await fixture({ async enqueue() { return value; } }); assert.ok(api);
  for (value of [{ ...receipt(), authority: {} }, { ...receipt(), status: 'delivered' }, { ...receipt(), messageRef: 'message:other' },
    { ...receipt(), entryId: '' }, { ...receipt(), entryId: 'entry\n' }]) await assert.rejects(() => api.enqueue(input()), TypeError);
  await activation.stop();
});
