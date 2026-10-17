import assert from 'node:assert/strict';
import test from 'node:test';
import { createCustodyClient, guardPredicateVerifier, type PluginPredicateVerifierContext, type PluginPredicateVerifier } from './custody.js';
import { definePlugin } from './feature-context.js';
import { definePluginModule } from './module-plugin.js';
import type { ModulePluginHostShape } from './module-host.js';
const digest = 'b'.repeat(64), headSha = 'a'.repeat(40);
const input = { actionFamily: 'review', subjectRef: 'pr:org/repo#1', predicate: { kind: 'review_delivered', subjectRef: 'pr:org/repo#1', identityKey: 'review_delivered\u001fpr:org/repo#1', freshnessKey: `head:${headSha}`, digest, headSha } } as const;
const completion = { ...input, leaseId: 'lease', generation: 1, evidenceRefs: ['github:exact'] };
function context(phase: 'freshness' | 'completion' = 'freshness'): PluginPredicateVerifierContext {
  const base = { tenantScope: 'owner', installationProjectRoot: '/project', binding: {
    pluginInstanceId: 'instance', packageDigest: 'package', featureId: 'review', contributionId: 'review', freshnessMethod: 'fresh', completionMethod: 'complete', grantRevision: 1, lifecycleRevision: 1, tenantScope: 'owner', installationProjectRoot: '/project' },
    assignment: { holderCatIds: ['cat'], holderThreadId: 'thread' }, signal: new AbortController().signal, assertCurrent: async () => {} };
  return phase === 'freshness' ? { ...base, phase, principal: { catId: 'cat', threadId: 'thread', userId: 'owner' } }
    : { ...base, phase, principal: { catId: 'cat', threadId: 'thread', userId: 'owner', invocationId: 'inv' } };
}
const freshResult = { status: 'verified', evidenceRef: 'provider:head', freshnessKey: input.predicate.freshnessKey, ownerCatId: 'cat', holderThreadId: 'thread' } as const;
const completeResult = { status: 'verified', evidenceRef: 'github:exact', predicateDigest: digest, freshnessKey: input.predicate.freshnessKey } as const;
function manifest() { return { pluginId: 'dev.example.custody', version: '1.0.0', contractVersion: '0.1.0', name: 'Custody',
  features: [{ id: 'review', name: 'Review', resources: [], contributions: [{ type: 'terminal-predicate-provider', id: 'review' }], capabilities: ['custody.verify', 'custody.invoke'] }],
  contributions: [{ type: 'terminal-predicate-provider', id: 'review', actionFamily: 'review', predicateKind: 'review_delivered', subjectNamespace: 'pr', freshnessMethod: 'fresh', completionMethod: 'complete' }],
  runtime: { transport: 'builtin', entrypoint: 'dist/index.js' } }; }
function moduleWith(handlers: Record<string, PluginPredicateVerifier>, m = manifest(), actions = {}) {
  return definePluginModule(candidate => definePlugin({ manifest: candidate, activate: { review: () => ({ actions, predicateVerifiers: handlers }) } })).create(m);
}
const host = {} as ModulePluginHostShape; // No unused Host service is replaced with successful behavior.
test('verifier rejects extra authority fields before invoking handler', async t => {
  for (const phase of ['freshness', 'completion'] as const) {
    const mutations: Array<(ctx: any) => void> = [
      ctx => { ctx.completeLease = async () => {}; },
      ctx => { ctx.principal.completeLease = async () => {}; },
      ctx => { ctx.assignment.delegate = 'other'; },
      ctx => { Object.defineProperty(ctx, 'hidden', { value: () => {} }); },
      ctx => { ctx[Symbol('authority')] = () => {}; },
      ctx => { Object.setPrototypeOf(ctx.principal, { completeLease: () => {} }); },
      ctx => { Object.defineProperty(ctx.principal, 'catId', { get() { throw new Error('must not evaluate getter'); } }); },
      ctx => { ctx.binding.completeLease = () => {}; },
      ctx => { ctx.assignment.holderCatIds = ['cat', () => {}]; },
      ctx => { ctx.principal.catId = ''; },
    ];
    if (phase === 'freshness') mutations.push(ctx => { ctx.principal.invocationId = 'forbidden'; });
    else mutations.push(ctx => { delete ctx.principal.invocationId; });
    for (const [index, mutate] of mutations.entries()) await t.test(`${phase} invalid context ${index}`, async () => {
      let calls = 0;
      const ctx = context(phase); mutate(ctx);
      const wrapped = guardPredicateVerifier(phase, async () => { calls++; return phase === 'freshness' ? freshResult : completeResult; }, () => {});
      await assert.rejects(wrapped(phase === 'freshness' ? input : completion, ctx), /context/i);
      assert.equal(calls, 0);
    });
  }
});

test('verifier receives an isolated phase-specific context snapshot', async () => {
  for (const phase of ['freshness', 'completion'] as const) {
    const ctx = context(phase);
    const wrapped = guardPredicateVerifier(phase, async (_request, received) => {
      assert.notEqual(received, ctx);
      assert.deepEqual(Reflect.ownKeys(received).sort(), Reflect.ownKeys(ctx).sort());
      assert.equal('invocationId' in received.principal, phase === 'completion');
      assert.ok(Object.isFrozen(received));
      assert.ok(Object.isFrozen(received.principal));
      assert.ok(Object.isFrozen(received.assignment.holderCatIds));
      (ctx.principal as any).catId = 'changed';
      (ctx.assignment.holderCatIds as string[]).push('other');
      assert.equal(received.principal.catId, 'cat');
      assert.deepEqual(received.assignment.holderCatIds, ['cat']);
      return phase === 'freshness' ? freshResult : completeResult;
    }, () => {});
    await wrapped(phase === 'freshness' ? input : completion, ctx);
  }
});

test('verifier captures only the current-check callback and discards its return authority', async () => {
  const ctx = context(); let checks = 0;
  const check = Object.assign(async () => {
    checks++;
    (ctx as any).assertCurrent = async () => { throw new Error('replacement callback'); };
    return { completeLease: () => {} };
  }, { completeLease: () => {} });
  (ctx as any).assertCurrent = check;
  const wrapped = guardPredicateVerifier('freshness', async (_input, received) => {
    assert.equal('completeLease' in received.assertCurrent, false);
    assert.equal(await received.assertCurrent(), undefined);
    return freshResult;
  }, () => {});
  await wrapped(input, ctx);
  assert.equal(checks, 3);
});

test('module exposes only declared private verifiers and revokes them at stop', async () => {
  const active = await moduleWith({ fresh: async () => freshResult, complete: async () => completeResult }).start(host);
  assert.deepEqual(Object.keys(active.actions), []);
  assert.deepEqual(Object.keys(active.predicateVerifiers!), ['fresh', 'complete']);
  assert.deepEqual(await active.predicateVerifiers!.fresh!(input, context()), freshResult);
  await assert.rejects(active.predicateVerifiers!.fresh!(input, context('completion')), /context/);
  await active.stop(); await assert.rejects(active.predicateVerifiers!.fresh!(input, context()), /revoked/);
});
test('module rejects missing, extra and public verifier handlers', async () => {
  const handlers = { fresh: async () => freshResult, complete: async () => completeResult };
  await assert.rejects(moduleWith({ fresh: handlers.fresh }).start(host), /exactly/);
  await assert.rejects(moduleWith({ ...handlers, extra: handlers.fresh }).start(host), /exactly/);
  await assert.rejects(moduleWith(handlers, manifest(), { fresh: handlers.fresh }).start(host), /not declared/);
  const inherited = manifest(); inherited.contributions[0]!.freshnessMethod = 'constructor';
  await assert.rejects(moduleWith({ complete: handlers.complete }, inherited).start(host), /exactly/);
  const m = manifest(); m.contributions = []; m.features[0]!.contributions = [];
  await assert.rejects(moduleWith(handlers, m).start(host), /exactly/);
});
test('verifier cannot mutate input or return foreign evidence, identity or candidate fields', async () => {
  const wrapped = guardPredicateVerifier('completion', async request => {
    assert.ok(Object.isFrozen(request)); assert.ok(Object.isFrozen(request.predicate));
    assert.throws(() => { (request.predicate as any).headSha = 'c'.repeat(40); });
    return completeResult;
  }, () => {});
  assert.deepEqual(await wrapped(completion, context('completion')), completeResult);
  for (const extra of [{ tenantScope: 'other' }, { candidateRevision: 2 }, { evidenceRef: 'github:other' }, { predicateDigest: 'c'.repeat(64) }]) {
    const bad = guardPredicateVerifier('completion', async () => ({ ...completeResult, ...extra }), () => {});
    await assert.rejects(bad(completion, context('completion')));
  }
  assert.equal(input.predicate.headSha, headSha);
});
test('verifier rejects cancellation and lost Host fence after IO', async () => {
  for (const mode of ['abort', 'stale', 'stop'] as const) {
    let active = true, live = true; const controller = new AbortController();
    const ctx = { ...context(), signal: controller.signal, assertCurrent: async () => { if (!live) throw new Error('stale'); } };
    const wrapped = guardPredicateVerifier('freshness', async () => {
      if (mode === 'abort') controller.abort(); else if (mode === 'stale') live = false; else active = false;
      return freshResult;
    }, () => { if (!active) throw new Error('stopped'); });
    await assert.rejects(wrapped(input, ctx));
  }
});
test('custody client rejects identity input before transport and lost authority after transport', async () => {
  let calls = 0, active = true;
  const client = createCustodyClient({
    canonicalize: async () => { calls++; return { digest }; },
    preflight: async () => { calls++; return { ok: true, reason: 'active' }; },
    complete: async request => { calls++; assert.ok(Object.isFrozen(request.evidenceRefs)); active = false; return { outcome: 'committed', leaseId: request.leaseId, generation: request.generation }; },
  }, () => { if (!active) throw new Error('revoked'); });
  await assert.rejects(client.complete({ leaseId: 'lease', generation: 1, evidenceRefs: ['github:exact'], catId: 'forged' } as never));
  assert.equal(calls, 0);
  assert.deepEqual(await client.preflight({ leaseId: 'lease', generation: 1, terminalPredicateDigest: digest }), { ok: true, reason: 'active' });
  await assert.rejects(client.complete({ leaseId: 'lease', generation: 1, evidenceRefs: ['github:exact'] }), /revoked/);
  assert.equal(calls, 2);
  await assert.rejects(createCustodyClient(undefined, () => {}).preflight({ leaseId: 'lease', generation: 1, terminalPredicateDigest: digest }), /unavailable/);
});

test('feature custody requires its own invoke grant before touching Host', async () => {
  for (const granted of [false, true]) {
    let calls = 0;
    const m = manifest(); m.features[0]!.capabilities = granted ? ['custody.verify', 'custody.invoke'] : ['custody.verify'];
    const module = definePluginModule(candidate => definePlugin({ manifest: candidate, activate: { review: async ctx => {
      const call = ctx.custody.canonicalize({ actionFamily: 'review', subjectRef: input.subjectRef, predicate: { kind: 'review_delivered', headSha } });
      if (granted) assert.deepEqual(await call, { digest }); else await assert.rejects(call, /custody.invoke/);
      return { predicateVerifiers: { fresh: async () => freshResult, complete: async () => completeResult } };
    } } }));
    const active = await module.create(m).start({ ...host, custody: { canonicalize: async () => { calls++; return { digest }; }, preflight: async () => { throw new Error('unused'); }, complete: async () => { throw new Error('unused'); } } });
    assert.equal(calls, granted ? 1 : 0); await active.stop();
  }
});
