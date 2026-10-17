import assert from 'node:assert/strict';
import test from 'node:test';
import * as contract from '../index.js';
function check(name: string, value: unknown) {
  const fn = (contract as unknown as Record<string, unknown>)[name];
  assert.equal(typeof fn, 'function', `Missing source DTO validator ${name}`);
  (fn as (value: unknown) => void)(value);
}
const fact = { id: 'origin', userId: 'owner', threadId: 'thread', catId: null, content: 'source body',
  source: { connector: 'neutral', meta: { participation: { revision: 3 }, values: [null, true, 4] } },
  extra: { pluginMessage: { instanceId: 'instance' } } };
test('source DTO retains only the actual public source subset and nullable cat', () => {
  check('assertPluginSourceFact', fact);
  check('assertPluginSourceFact', { ...fact, catId: 'cat', source: { connector: 'neutral' } });
  for (const value of [{ ...fact, task: {} }, { ...fact, extra: { ...fact.extra, receipt: {} } },
    { ...fact, source: { ...fact.source, privateBinding: {} } }, { ...fact, catId: undefined }]) {
    assert.throws(() => check('assertPluginSourceFact', value), /Invalid PluginSourceFact/);
  }
});
test('source input mirrors Host codepoint limit and rejects authority or control fields', () => {
  check('assertPluginSourceFactsReadInput', { messageRef: 'message:' + '😀'.repeat(500) });
  for (const value of [{ messageRef: 'message:' }, { messageRef: 'message:' + '😀'.repeat(501) },
    { messageRef: 'message:a\n' }, { messageRef: 'message:a\u0000' }, { messageRef: 'message:a\u007f' },
    { messageRef: 'message:a', ownerUserId: 'forged' }, { messageRef: 'message:a', taskRef: 'task:x' }]) {
    assert.throws(() => check('assertPluginSourceFactsReadInput', value), /Invalid PluginSourceFactsReadInput/);
  }
});
test('native DTO requires actual exact-origin fields and excludes private Work binding', () => {
  const context = { userId: 'owner', threadId: 'thread', catId: 'cat', invocationId: 'inv', originTriggerMessageId: 'origin', source: fact };
  check('assertPluginNativeContext', context);
  for (const value of [{ ...context, originTriggerMessageId: undefined }, { ...context, binding: {} },
    { ...context, source: { kind: 'adopted_hold', sourceMessageId: 'other' } }]) {
    assert.throws(() => check('assertPluginNativeContext', value), /Invalid PluginNativeContext/);
  }
});
test('source metadata is plain own JSON, never getters, functions, symbols, cycles or deep aliases', () => {
  let reads = 0;
  const getter = Object.defineProperty({}, 'x', { enumerable: true, get() { reads++; return 1; } });
  const cycle: Record<string, unknown> = {}; cycle.self = cycle;
  let deep: Record<string, unknown> = {}; for (let i = 0; i < 34; i++) deep = { x: deep };
  for (const meta of [getter, cycle, deep, { x: Infinity }, { x: undefined }, { x: () => 1 },
    { [Symbol('authority')]: 1 }, { x: new Date() }, { x: new Array(2) }]) {
    assert.throws(() => check('assertPluginSourceFact', { ...fact, source: { connector: 'neutral', meta } }), /Invalid PluginSourceFact/);
  }
  assert.equal(reads, 0);
});

test('native wrapper preserves the Host source snapshot nesting allowance', () => {
  let meta: unknown = null; for (let i = 0; i < 30; i++) meta = { x: meta };
  const nested = { ...fact, source: { connector: 'neutral', meta } };
  check('assertPluginSourceFact', nested);
  check('assertPluginNativeContext', { userId: 'owner', threadId: 'thread', catId: 'cat', invocationId: 'inv', originTriggerMessageId: 'origin', source: nested });
});

test('Task opt-in accepts v1 absence and bounded v2 Host entry facts without business authority', () => {
  const task = { taskRef: 'task:work:task', taskRevision: 2, admissionRef: 'message:first',
    executionRef: 'message:execution', sourceRevision: 1 };
  const context = { userId: 'owner', threadId: 'private-thread', catId: 'cat', invocationId: 'inv',
    originTriggerMessageId: 'trigger', source: fact, task };
  check('assertPluginNativeTaskContext', context);
  for (const kind of ['initial', 'owner_resume', 'source_continuation'])
    for (const firstAdmissionKind of ['owner_http_write', 'owner_operation_write', 'native_exact_origin', 'installed_plugin_policy'])
      for (const requestKind of ['owner_http_write', 'owner_operation_write', 'native_exact_origin', 'installed_plugin_policy'])
        check('assertPluginNativeTaskContext', { ...context, task: { ...task,
          execution: { kind, firstAdmissionKind, requestKind } } });
  // The enum product describes a bounded data shape; only the Host authenticates
  // the protected receipt and permitted phase/provenance combination.
  const execution = { kind: 'initial', firstAdmissionKind: 'owner_http_write', requestKind: 'owner_http_write' };
  let reads = 0;
  const getter = Object.defineProperty({ ...execution }, 'kind', { enumerable: true,
    get() { reads++; return 'initial'; } });
  for (const value of [null, {}, { ...execution, kind: 'completed' },
    { ...execution, firstAdmissionKind: 'manual_owner_write' }, { ...execution, requestKind: 'standing_grant' },
    { ...execution, requestKind: undefined }, { ...execution, request: { body: 'secret' } },
    { ...execution, bearer: 'secret' }, { ...execution, executionAuthorityRevision: 1 }, getter,
    Object.assign(Object.create({ businessBasis: 'standing_grant' }), execution)]) {
    assert.throws(() => check('assertPluginNativeTaskContext', { ...context, task: { ...task, execution: value } }), TypeError);
  }
  assert.equal(reads, 0);
  assert.throws(() => check('assertPluginNativeContext', context), TypeError);
});
