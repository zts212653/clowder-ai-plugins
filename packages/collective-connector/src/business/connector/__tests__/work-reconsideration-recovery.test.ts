import { expect, it } from 'vitest';
import { readFile, writeFile, stat, symlink, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture } from './communication-work-custody.fixture.js';
import { createCollectiveWorkReconsiderationCaller } from '../../../collective-work-reconsideration.js';
import { COLLECTIVE_PUBLIC_METHODS } from '../../../public-native-methods.js';

async function prepared() {
  const f = await fixture();
  await f.connector.sync(f.connection.connectionId);
  await f.connector.adoptWorkPolicy(f.connection.connectionId, 'local-owner', 1);
  await f.connector.beginInboxRouting(f.connection.connectionId, f.source.eventId, 1);
  await f.connector.completeInboxRouting(f.connection.connectionId, f.source.eventId, 1, {
    kind: 'thread_message',
    messageId: 'original',
    threadId: 'channel',
    catId: f.source.catId,
  });
  const event = (await f.connector.listInbox(f.connection.connectionId))[0]!.event;
  const rows = new Map<string, any>([
    [
      'original',
      {
        id: 'original',
        userId: 'local-owner',
        threadId: 'channel',
        catId: null,
        content: event.body,
        mentions: [],
        timestamp: 1,
        sourceRevision: 'original:1',
        source: {
          connector: 'collective',
          label: 'Collective',
          icon: 'c',
          meta: { participation: f.source },
        },
      },
    ],
  ]);
  let final: 'queued' | 'processing' | 'failed' | 'handled' | 'missing' = 'queued';
  let custody: any;
  let sends = 0;
  const owner = {
    kind: 'owner-http-request' as const,
    userId: 'local-owner',
    pluginInstanceId: 'instance',
    operation: 'write' as const,
    signal: new AbortController().signal,
    assertCurrent: async () => {},
  };
  const request = {
    sourceEventId: f.source.eventId,
    catId: f.source.catId,
    grantRef: f.input.grantRef,
    grantRevision: 1,
    requestKind: f.input.requestKind,
  };
  const caller = createCollectiveWorkReconsiderationCaller({
    connector: f.connector,
    native: { contributionId: 'collective-native', methods: COLLECTIVE_PUBLIC_METHODS },
    messaging: {
      get: async (id) => structuredClone(rows.get(id) ?? null),
      send: async (threadId, draft) => {
        sends++;
        rows.set('second', {
          ...rows.get('original'),
          id: 'second',
          threadId,
          source: { connector: 'collective', label: 'Collective', icon: 'c', meta: draft.meta },
        });
        return { messageId: 'second', threadId };
      },
    },
    ownerThreads: {
      get: async () => ({ id: 'channel', createdBy: owner.userId, participants: [f.source.catId] }),
    },
    participantRoster: {
      listForNativeContribution: async () => [{ catId: f.source.catId, supported: true }],
    },
    sourceFacts: {
      readProgress: async () => ({
        ...rows.get('second'),
        extra: { pluginMessage: { instanceId: 'instance' } },
        ...(custody ? { queueCustody: structuredClone(custody) } : {}),
      }),
    },
    publicInvocations: {
      enqueue: async (input) => {
        custody =
          final === 'missing'
            ? undefined
            : {
                status: final === 'failed' || final === 'handled' ? 'terminal' : final,
                allTargetCats: [f.source.catId],
                handledByCatIds: final === 'handled' ? [f.source.catId] : [],
                failedByCatIds: final === 'failed' ? [f.source.catId] : [],
                seenByCatIds: final === 'failed' ? [f.source.catId] : [],
              };
        return { messageRef: input.messageRef, entryId: 'same-entry', status: 'queued' as const };
      },
    },
  });
  return {
    ...f,
    caller,
    request,
    owner,
    sends: () => sends,
    setFinal(value: typeof final) {
      final = value;
      custody = undefined;
    },
  };
}

it('new reconsideration receipt preserves the retained canonical state for an actual older parser and later recovery', async () => {
  const f = await prepared();
  try {
    const stale = await f.open();
    await f.caller.reconsider(f.connection.connectionId, f.request, f.owner);
    const path = join(f.root, 'connector', 'collective-connector.json');
    const raw = JSON.parse(await readFile(path, 'utf8'));
    const legacy = process.env.F202_LEGACY_STATE_PARSER;
    if (legacy) {
      const { parseConnectorState } = await import(legacy);
      parseConnectorState(raw);
    }
    expect(raw.connections[f.connection.connectionId].inbox[0]).not.toHaveProperty('workReconsiderations');
    const before = f.connector.findWorkReconsiderationSource('message:second');
    const relations = join(f.root, 'connector', 'collective-connector.reconsideration-sources.json');
    expect((await stat(relations)).mode & 0o777).toBe(0o600);
    await expect(
      stale.withWorkReconsiderationAuthority(f.connection.connectionId, f.owner.userId, f.request, (scope) =>
        stale.recordWorkReconsiderationSource(scope, {
          pluginInstanceId: 'instance',
          messageRef: 'message:second',
          native: { contributionId: 'collective-native', methods: COLLECTIVE_PUBLIC_METHODS },
        }),
      ),
    ).rejects.toMatchObject({ code: 'COLLECTIVE_STATE_STALE' });
    expect((await f.open()).findWorkReconsiderationSource('message:second')).toEqual(before);
    // An older package rewrites only its known canonical document; the new relation must survive.
    await writeFile(path, JSON.stringify(raw, null, 2) + '\n', { mode: 0o600 });
    expect((await f.open()).findWorkReconsiderationSource('message:second')).toEqual(before);
    expect(f.sends()).toBe(1);
    await unlink(relations);
    await symlink(path, relations);
    await expect(f.open()).rejects.toThrow(/private regular file/);
  } finally {
    await f.close();
  }
});

it('final custody rejects queued receipt that has already become terminal and unhandled', async () => {
  const f = await prepared();
  try {
    f.setFinal('failed');
    await expect(f.caller.reconsider(f.connection.connectionId, f.request, f.owner)).rejects.toMatchObject({
      code: 'WORK_RECONSIDERATION_ALREADY_STOPPED',
    });
  } finally {
    await f.close();
  }
});

it('final custody cannot disappear after an enqueue receipt', async () => {
  const f = await prepared();
  try {
    f.setFinal('missing');
    await expect(f.caller.reconsider(f.connection.connectionId, f.request, f.owner)).rejects.toMatchObject({
      code: 'WORK_RECONSIDERATION_CUSTODY_UNAVAILABLE',
    });
  } finally {
    await f.close();
  }
});

it('final handled custody determines completion even when the earlier receipt was queued', async () => {
  const f = await prepared();
  try {
    f.setFinal('handled');
    await expect(f.caller.reconsider(f.connection.connectionId, f.request, f.owner)).resolves.toMatchObject({
      disposition: 'already_classified',
    });
  } finally {
    await f.close();
  }
});
