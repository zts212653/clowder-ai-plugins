import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CollectiveConnector } from '../src/business/connector/connector.js';
import {
  type CollectiveAccountabilityAttentionItem,
  collectiveAccountabilityAttentionActionRef,
  collectiveAccountabilityAttentionSubjectRef,
} from '../src/business/contracts/index.js';
import { readCollectiveAccountabilityAttentionSource } from '../src/accountability-attention.js';
import { createAccountabilityAttentionAction } from '../src/accountability-owner-action.js';
import type { PluginOwnerOperationContext } from '@clowder-ai/plugin-sdk';
import { readFile } from 'node:fs/promises';
import YAML from 'yaml';
import { collectiveOwnerOperationInput } from '../src/owner-operation-input.js';

const ownerUserId = 'owner-user';

test('owner envelope separates only known Manager fields without mutating input or dropping operation arguments', () => {
  const input = {input: {servicePort: '5813', connectionId: 'connection', expectedRevision: 7},
    operationState: {currentAction: 'sync', updatedAt: 123}};
  const before = structuredClone(input);
  assert.deepEqual(collectiveOwnerOperationInput(input), {input: {connectionId: 'connection', expectedRevision: 7}});
  assert.deepEqual(input, before);
  for (const bad of [{...input, userId: 'forged'}, {...input, operationState: {...input.operationState, userId: 'forged'}},
    {...input, operationState: {currentAction: 'sync', updatedAt: -1}}])
    assert.throws(() => collectiveOwnerOperationInput(bad));
});
const serviceInstanceId = 'svc_aaaaaaaa';
const collectiveId = 'col_aaaaaaaa';
const sourceSnapshot = `sha256:${'a'.repeat(64)}`;

function caller(assertCurrent: () => Promise<void> = async () => {}): PluginOwnerOperationContext {
  return { kind: 'owner-operation', pluginInstanceId: 'installed', userId: ownerUserId,
    operationKey: 'accountability', actionId: 'attention', requestId: 'request',
    signal: new AbortController().signal, assertCurrent };
}

test('ordinary owner action declares the exact Dot coordinates and refuses other callers', async () => {
  const manifest = YAML.parse(await readFile(new URL('../plugin.yaml', import.meta.url), 'utf8'));
  const operation = manifest.configuration.find((row: {key: string}) => row.key === 'accountability');
  assert.equal(operation.actions[0].id, 'attention');
  assert.equal(operation.actions[0].action.method, 'collective.owner.accountability-attention');
  let reads = 0;
  const action = createAccountabilityAttentionAction({ async listConnections() { reads += 1; return []; } } as unknown as CollectiveConnector, () => {});
  for (const authority of [undefined, { ...caller(), actionId: 'other' }, { ...caller(), operationKey: 'other' }])
    await assert.rejects(async () => action({input: {}}, undefined, authority), /authenticated owner operation/);
  assert.equal(reads, 0);
  const result = await action({input: {}}, undefined, caller()) as {render: string; data: {items: unknown[]; state: {status: string; exhaustiveness: string}}};
  assert.equal(result.render, 'status', 'owner operation must have the formal rendering envelope');
  assert.deepEqual(Object.keys(result).sort(), ['data', 'render']);
  assert.deepEqual(result.data.items, []);
  assert.equal(result.data.state.status, 'available');
  assert.equal(result.data.state.exhaustiveness, 'complete');
  assert.equal(reads, 1);
});

test('owner expiry during a read cannot disclose rows or become empty-complete', async () => {
  let expired = false;
  const action = createAccountabilityAttentionAction({async listConnections() { expired = true; return []; }} as unknown as CollectiveConnector, () => {});
  await assert.rejects(async () => action({input: {}}, undefined, caller(async () => {if(expired) throw new Error('owner expired');})), /owner expired/);
});

test('abort or deactivation during attention read cannot return a result envelope', async () => {
  for (const revoke of ['abort', 'deactivate']) {
    const controller = new AbortController();
    let active = true;
    const action = createAccountabilityAttentionAction({async listConnections() {
      if (revoke === 'abort') controller.abort(new Error('owner request aborted'));
      else active = false;
      return [];
    }} as unknown as CollectiveConnector, () => {if (!active) throw new Error('plugin deactivated');});
    await assert.rejects(async () => action({input: {}}, undefined, {...caller(), signal: controller.signal}),
      /owner request aborted|plugin deactivated/);
  }
});

test('attention status envelope preserves unavailable source data for Dot', async (t) => {
  t.mock.method(Date, 'now', () => 123456);
  const connector = {async listConnections() {throw new Error('index unavailable');}} as unknown as CollectiveConnector;
  const expected = await readCollectiveAccountabilityAttentionSource(connector, ownerUserId);
  const action = createAccountabilityAttentionAction(connector, () => {});
  const result = await action({input: {servicePort: '5813'}, operationState: {currentAction: 'attention', updatedAt: 123}}, undefined, caller()) as {render: string; data: unknown};
  assert.equal(result.render, 'status');
  assert.deepEqual(result.data, expected);
  assert.deepEqual(Object.keys(result).sort(), ['data', 'render']);
});

test('missing plugin and failed connection index remain unknown and unavailable', async () => {
  for (const connector of [undefined, {async listConnections() {throw new Error('index unavailable');}} as unknown as CollectiveConnector]) {
    const read = await readCollectiveAccountabilityAttentionSource(connector, ownerUserId);
    assert.equal(read.state.status, 'unavailable');
    assert.equal(read.state.exhaustiveness, 'unknown');
  }
});

function connection(connectionId: string, humanId: string) {
  return {
    serviceUrl: 'http://collective.test',
    canonicalClientAnchor: {
      kind: 'collective-client',
      serviceUrl: 'http://collective.test',
      clientBuildId: 'test',
      serviceInstanceId,
      collectiveId,
      connectionId,
    },
    serviceInstanceId,
    collectiveId,
    connectionId,
    endpointId: `ep_${connectionId.slice(4)}`,
    authorizedHumanId: humanId,
    endpointLabel: connectionId,
    authorityStatus: 'connected' as const,
    liveStatus: 'online' as const,
    lastAckedSequence: 0,
    outbox: { queued: 0, accepted: 0 },
    route: { configured: true, revision: 1 },
    inbox: { persisted: 0, pending: 0, routed: 0, failed: 0 },
  };
}

function route(localOwnerUserId: string) {
  return {
    localOwnerUserId,
    defaultIngressThreadId: 'thread-public',
    humanNotificationThreadId: 'thread-public',
    agentRoutes: {},
    standingInterests: {},
    revision: 1,
    updatedAt: '2026-10-18T12:00:00.000Z',
  };
}

function item(connectionId = 'con_owned0000', workRevision = 4): CollectiveAccountabilityAttentionItem {
  const identity = {
    serviceInstanceId,
    collectiveId,
    connectionId,
    workId: 'work_aaaaaaaa',
    accountabilityRequestId: 'accountability_aaaaaaaa',
  };
  return {
    producerId: 'f290.collective_work_accountability_request',
    subjectRef: collectiveAccountabilityAttentionSubjectRef(identity),
    ...identity,
    workRevision,
    expectedProducerRevision: workRevision,
    targetHumanId: 'human_owned0000',
    targetDisplayName: 'Owner Human',
    requestedByHumanId: 'human_requester0',
    requestedByDisplayName: 'Requester',
    requestEventId: 'evt_request0000',
    requestedAt: '2026-10-18T12:00:00.000Z',
    status: 'pending',
    roadmapId: 'roadmap_aaaaaaaa',
    projectTitle: 'Shared Project',
    channelId: 'general',
    workSourceEventId: 'evt_source00000',
    workTitle: 'Named responsibility',
    actionRef: collectiveAccountabilityAttentionActionRef({
      ...identity,
      workRevision,
      channelId: 'general',
      roadmapId: 'roadmap_aaaaaaaa',
    }),
  };
}

test('reads every page only from connections owned by this Host principal', async () => {
  const owned = connection('con_owned0000', 'human_owned0000');
  const foreign = connection('con_foreign000', 'human_foreign00');
  const calls: string[] = [];
  const connector = {
    async listConnections() {
      return [owned, foreign];
    },
    async getHostRoute(connectionId: string) {
      return connectionId === owned.connectionId ? route(ownerUserId) : route('another-owner');
    },
    async getProjection(connectionId: string) {
      return connectionId === owned.connectionId ? owned : foreign;
    },
    async readPendingAccountabilityRequests(connectionId: string, readOwner: string, page: { offset: number }) {
      calls.push(connectionId);
      assert.equal(readOwner, ownerUserId);
      assert.equal(connectionId, owned.connectionId);
      return {
        identity: {
          serviceInstanceId,
          collectiveId,
          connectionId,
          authorizedHumanId: owned.authorizedHumanId,
        },
        items: page.offset === 0 ? [item()] : [],
        page: {
          offset: page.offset,
          limit: 100,
          hasMore: page.offset === 0,
          snapshot: sourceSnapshot,
          totalCount: 1,
        },
      };
    },
  } as unknown as CollectiveConnector;

  const read = await readCollectiveAccountabilityAttentionSource(connector, ownerUserId);
  assert.deepEqual(calls, [owned.connectionId, owned.connectionId]);
  assert.equal(read.state.status, 'available');
  assert.equal(read.state.exhaustiveness, 'complete');
  assert.deepEqual(read.items, [item()]);
  assert.deepEqual(read.reasons, []);
});

test('keeps successful rows but marks the source partial when any owned connection fails', async (t) => {
  t.mock.method(Date, 'now', () => 123456);
  const first = connection('con_owned0000', 'human_owned0000');
  const second = connection('con_owned0001', 'human_owned0001');
  const routes = new Map([
    [first.connectionId, route(ownerUserId)],
    [second.connectionId, route(ownerUserId)],
  ]);
  const connector = {
    async listConnections() {
      return [first, second];
    },
    async getHostRoute(connectionId: string) {
      return routes.get(connectionId);
    },
    async getProjection(connectionId: string) {
      return connectionId === first.connectionId ? first : second;
    },
    async readPendingAccountabilityRequests(connectionId: string) {
      if (connectionId === second.connectionId) throw new Error('second Service unavailable');
      return {
        identity: {
          serviceInstanceId,
          collectiveId,
          connectionId,
          authorizedHumanId: first.authorizedHumanId,
        },
        items: [item(first.connectionId)],
        page: { offset: 0, limit: 100, hasMore: false, snapshot: sourceSnapshot, totalCount: 1 },
      };
    },
  } as unknown as CollectiveConnector;

  const read = await readCollectiveAccountabilityAttentionSource(connector, ownerUserId);
  assert.equal(read.state.status, 'available');
  assert.equal(read.state.exhaustiveness, 'partial');
  assert.deepEqual(read.items, [item(first.connectionId)]);
  assert.ok(read.reasons.includes('collective_accountability_connection_read_failed'));
  const action = createAccountabilityAttentionAction(connector, () => {});
  const result = await action({input: {}}, undefined, caller()) as {render: string; data: unknown};
  assert.equal(result.render, 'status');
  assert.deepEqual(result.data, read);
});

test('drops a late response when the endpoint Human or Host route changes before projection', async () => {
  const before = connection('con_owned0000', 'human_owned0000');
  const after = { ...before, authorizedHumanId: 'human_rebound000' };
  let projectionReads = 0;
  const connector = {
    async listConnections() {
      return [before];
    },
    async getHostRoute() {
      return projectionReads > 0 ? { ...route(ownerUserId), revision: 2 } : route(ownerUserId);
    },
    async getProjection() {
      projectionReads += 1;
      return after;
    },
    async readPendingAccountabilityRequests() {
      return {
        identity: {
          serviceInstanceId,
          collectiveId,
          connectionId: before.connectionId,
          authorizedHumanId: before.authorizedHumanId,
        },
        items: [item()],
        page: { offset: 0, limit: 100, hasMore: false, snapshot: sourceSnapshot, totalCount: 1 },
      };
    },
  } as unknown as CollectiveConnector;

  const read = await readCollectiveAccountabilityAttentionSource(connector, ownerUserId);
  assert.deepEqual(read.items, []);
  assert.equal(read.state.exhaustiveness, 'partial');
  assert.ok(read.reasons.includes('collective_accountability_authority_changed'));
});

test('does not report complete coverage when a later Service page loses its source snapshot', async () => {
  const owned = connection('con_owned0000', 'human_owned0000');
  let reads = 0;
  const connector = {
    async listConnections() {
      return [owned];
    },
    async getHostRoute() {
      return route(ownerUserId);
    },
    async getProjection() {
      return owned;
    },
    async readPendingAccountabilityRequests(
      connectionId: string,
      readOwner: string,
      page: { offset: number; snapshot?: string },
    ) {
      assert.equal(connectionId, owned.connectionId);
      assert.equal(readOwner, ownerUserId);
      reads += 1;
      if (reads === 2) {
        assert.equal(page.snapshot, sourceSnapshot);
        throw Object.assign(new Error('pending source changed'), { statusCode: 409 });
      }
      return {
        identity: {
          serviceInstanceId,
          collectiveId,
          connectionId,
          authorizedHumanId: owned.authorizedHumanId,
        },
        items: [item()],
        page: { offset: 0, limit: 100, hasMore: true, snapshot: sourceSnapshot, totalCount: 101 },
      };
    },
  } as unknown as CollectiveConnector;

  const read = await readCollectiveAccountabilityAttentionSource(connector, ownerUserId);
  assert.equal(read.items.length, 0);
  assert.equal(read.state.status, 'unavailable');
  assert.equal(read.state.exhaustiveness, 'partial');
  assert.ok(read.reasons.includes('collective_accountability_connection_read_failed'));
});
