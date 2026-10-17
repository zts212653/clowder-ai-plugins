import { expect, it } from 'vitest';
import { fixture } from './communication-work-custody.fixture.js';
import { createOwnerControlHttp } from '../../../owner-control-http.js';
import { createCollectivePublicSourceCaller } from '../../../collective-public-source.js';
import { createCollectivePublicNativeActions } from '../../../collective-public-native-context.js';
import { openCollectiveContextReferences } from '../../../collective-context-refs.js';
import { COLLECTIVE_PUBLIC_METHODS } from '../../../public-native-methods.js';

it('reconsiders through one durable purpose binding and verifier reentry after releasing the original connection fence', async () => {
  const f = await fixture();
  try {
    await f.connector.sync(f.connection.connectionId);
    await f.connector.adoptWorkPolicy(f.connection.connectionId, 'local-owner', 1);
    await f.connector.beginInboxRouting(f.connection.connectionId, f.source.eventId, 1);
    await f.connector.completeInboxRouting(f.connection.connectionId, f.source.eventId, 1, {
      kind: 'thread_message',
      messageId: 'original',
      threadId: 'channel',
      catId: f.source.catId,
    });
    const module = await import('../../../collective-work-reconsideration.js');
    expect(typeof module.createCollectiveWorkReconsiderationCaller).toBe('function');
    const event = (await f.connector.listInbox(f.connection.connectionId)).find(
      (x) => x.event.eventId === f.source.eventId,
    )!.event;
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
    const keys = new Map<string, string>();
    let sends = 0,
      admissions = 0;
    let status: 'queued' | 'terminal' = 'queued';
    let handled: string[] = [];
    let loseResponse = true;
    const request = {
      sourceEventId: f.source.eventId,
      catId: f.source.catId,
      grantRef: f.input.grantRef,
      grantRevision: 1,
      requestKind: f.input.requestKind,
    };
    const native = { contributionId: 'collective-native', methods: COLLECTIVE_PUBLIC_METHODS };
    let caller: ReturnType<typeof module.createCollectiveWorkReconsiderationCaller>;
    caller = module.createCollectiveWorkReconsiderationCaller({
      connector: f.connector,
      native,
      messaging: {
        get: async (id) => structuredClone(rows.get(id) ?? null),
        send: async (threadId, draft) => {
          sends++;
          const id = keys.get(draft.idempotencyKey) ?? 'second';
          keys.set(draft.idempotencyKey, id);
          if (!rows.has(id))
            rows.set(id, {
              id,
              threadId,
              userId: 'local-owner',
              catId: null,
              content: (draft.payload.elements[0]!.payload as { text: string }).text,
              mentions: [],
              timestamp: 2,
              sourceRevision: 'second:1',
              source: { connector: 'collective', label: 'Collective', icon: 'c', meta: draft.meta },
            });
          expect(draft.wake).toBeUndefined();
          return { messageId: id, threadId };
        },
      },
      ownerThreads: {
        get: async () => ({ id: 'channel', createdBy: 'local-owner', participants: [f.source.catId] }),
      },
      participantRoster: {
        listForNativeContribution: async () => [{ catId: f.source.catId, supported: true }],
      },
      sourceFacts: {
        readProgress: async ({ messageRef }) => ({
          ...rows.get(messageRef.slice(8)),
          extra: { pluginMessage: { instanceId: 'instance' } },
          queueCustody: {
            status,
            handledByCatIds: handled,
            failedByCatIds: [],
            allTargetCats: [f.source.catId],
            seenByCatIds: [],
          },
        }),
      },
      publicInvocations: {
        enqueue: async (input) => {
          admissions++;
          const binding = await caller.readCurrent(input.messageRef, async () => {});
          expect(binding?.authority).toEqual(input.authority);
          rows.get('second').deliveryStatus = 'queued';
          if (loseResponse) {
            loseResponse = false;
            throw new Error('Actual fixture Queue receipt lost');
          }
          return { messageRef: input.messageRef, entryId: 'same-entry', status };
        },
      },
    });
    const owner = {
      kind: 'owner-http-request' as const,
      userId: 'local-owner',
      pluginInstanceId: 'instance',
      operation: 'write' as const,
      signal: new AbortController().signal,
      assertCurrent: async () => {},
    };
    const control = createOwnerControlHttp({
      connector: f.connector,
      reconsideration: caller.reconsider,
      binding: { parentOrigin: 'http://localhost:5172', assertCurrent: async () => {} } as never,
      assertActive() {},
      status: () => {
        throw new Error('Unused');
      },
      launch: async () => {
        throw new Error('Unused');
      },
    });
    const invoke = () =>
      control(
        {
          request: {
            method: 'POST',
            path: `connections/${f.connection.connectionId}/work/reconsider`,
            headers: { origin: 'http://localhost:5172' },
            principal: { kind: 'owner', id: owner.userId },
            body: request,
          },
        },
        undefined,
        owner,
      );
    expect((await invoke()).status).toBe(409);
    expect(admissions).toBe(1);
    const reopened = await f.open();
    expect(reopened.findWorkReconsiderationSource('message:second')).toEqual(
      f.connector.findWorkReconsiderationSource('message:second'),
    );
    const second = await invoke();
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({ disposition: 'already_queued' });
    expect(sends).toBe(1);
    expect(admissions).toBe(2);
    rows.get('original').deliveryStatus = 'queued';
    const queuedOriginal = await invoke();
    expect(queuedOriginal.status).toBe(200);
    expect(queuedOriginal.body).toMatchObject({ disposition: 'already_queued' });
    expect(sends).toBe(1);
    expect(admissions).toBe(3);
    expect((await f.connector.listInbox(f.connection.connectionId))[0]!.publicSource).toBeUndefined();
    const binding = f.connector.findWorkReconsiderationSource('message:second')!;
    const auth = {
      userId: owner.userId,
      threadId: 'channel',
      catId: f.source.catId,
      invocationId: 'native',
      originTriggerMessageId: 'second',
      source: { ...rows.get('second'), extra: { pluginMessage: { instanceId: 'instance' } } },
    };
    const sourceCaller = createCollectivePublicSourceCaller({
      connector: f.connector,
      native,
      messaging: {} as never,
      reconsideration: caller,
      nativeContext: { current: async () => auth },
      ownerThreads: {
        get: async () => ({ id: 'channel', createdBy: owner.userId, participants: [f.source.catId] }),
      } as never,
    });
    const action = { ...auth, assertCurrent: async () => {} };
    const resolved = await sourceCaller.resolveNative(action, 'collective.context.current');
    expect(resolved.binding.messageRef).toBe('message:second');
    await resolved.revalidate();
    const references = await openCollectiveContextReferences(f.root, () => {});
    const actions = createCollectivePublicNativeActions({ connector: f.connector, sourceCaller, references });
    const context = (await actions['collective.context.current']!({}, action)) as {
      contextRef: string;
      workDecision: { grants: { grantRef: string; requestKinds: string[] }[] };
    };
    expect(
      context.workDecision.grants.every(
        (grant) =>
          grant.grantRef === request.grantRef &&
          JSON.stringify(grant.requestKinds) === JSON.stringify([request.requestKind]),
      ),
    ).toBe(true);
    await expect(
      actions['collective.work.accept']!(
        {
          contextRef: context.contextRef,
          grantRef: 'other-grant',
          grantRevision: 1,
          requestKind: request.requestKind,
          title: 'Other',
          intendedOutcome: 'Other',
        },
        action,
      ),
    ).rejects.toMatchObject({ code: 'WORK_AUTHORITY_REQUIRED' });
    await expect(
      sourceCaller.publicInvocationVerifier(
        {
          source: { messageRef: binding.messageRef },
          authority: binding.authority,
          native: binding.native,
          targetCatId: f.source.catId,
        } as never,
        { signal: owner.signal, assertCurrent: async () => {} } as never,
      ),
    ).resolves.toEqual({ current: true });
    status = 'terminal';
    expect((await invoke()).body).toMatchObject({ code: 'WORK_RECONSIDERATION_ALREADY_STOPPED' });
    expect(admissions).toBe(3);
    handled = [f.source.catId];
    expect((await invoke()).body).toMatchObject({ disposition: 'already_classified' });
    await f.connector.withWorkReconsiderationAuthority(
      f.connection.connectionId,
      owner.userId,
      request,
      async (scope) => {
        await expect(
          f.connector.recordWorkReconsiderationSource(scope, {
            pluginInstanceId: 'instance',
            messageRef: 'message:competing',
            native,
          }),
        ).rejects.toMatchObject({ code: 'WORK_RECONSIDERATION_SOURCE_UNAVAILABLE' });
      },
    );
    const original = rows.get('original');
    rows.get('second').source.meta.reconsideration.grantRef = 'other-grant';
    await expect(sourceCaller.resolveNative(action, 'collective.context.current')).rejects.toMatchObject({
      code: 'PUBLIC_SOURCE_CHANGED',
    });
    expect((await invoke()).body).toMatchObject({ code: 'WORK_RECONSIDERATION_SOURCE_UNAVAILABLE' });
    rows.get('second').source.meta.reconsideration.grantRef = request.grantRef;
    rows.delete('original');
    await expect(caller.readCurrent('message:second', async () => {})).rejects.toMatchObject({
      code: 'WORK_RECONSIDERATION_SOURCE_UNAVAILABLE',
    });
    expect(await caller.readCurrent('message:unknown', async () => {})).toBeUndefined();
    rows.set('original', original);
    await f.connector.revokeWorkGrants(f.connection.connectionId, owner.userId, [request.grantRef]);
    await expect(caller.readCurrent('message:second', async () => {})).rejects.toBeInstanceOf(Error);
    await expect(resolved.revalidate()).rejects.toBeInstanceOf(Error);
  } finally {
    await f.close();
  }
}, 10000);
