import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import {
  definePlugin,
  definePluginModule,
  type FeatureActivation,
  type FeatureContext,
  operationRowAction,
  type PluginActionHandler,
  type PluginOwnerOperationContext,
  rowsResult,
} from '@clowder-ai/plugin-sdk';
import { z } from 'zod';
import { createFeishuMeetingCatchUpService } from './catch-up.js';
import { FeishuGatewayError } from './gateway.js';
import { createLarkCliFeishuArtifactInspector, parseFeishuMinutesReference } from './lark-cli-artifact-inspector.js';
import { createLarkCliFeishuPollingGateway } from './lark-cli-polling-gateway.js';
import { requirePollingAuthorization } from './lark-cli-polling-normalizer.js';
import { meetingListInput, meetingReadInput } from './native-methods.js';
import { configureOwnedLarkHome, createOwnedLarkCommand, type OwnedLarkCommand } from './owned-lark-command.js';
import { privateDirectory, readPrivate, writePrivate } from './private-files.js';
import { createMeetingRecordDelivery, type MeetingRecord } from './record-delivery.js';
import { createFeishuMeetingIntakeRuntime } from './runtime.js';
import { createMeetingSourcePublication } from './source-publication.js';
import { readMeetingSource } from './source-reader.js';
import { createFileMeetingIntakeStateStore, type MeetingIntakeStateStore } from './state-store.js';

const stateSchema = z
  .object({
    v: z.literal(1),
    ownerUserId: z.string().min(1).optional(),
    instanceId: z.string().min(1).optional(),
    auth: z.enum(['not_configured', 'pending', 'connected', 'expired', 'unknown']),
    collectionIntent: z.enum(['disabled', 'enabled']),
    attempt: z
      .object({
        state: z.enum(['pending', 'unknown']),
        deviceCode: z.string().min(1).max(4096).optional(),
        url: z.string().max(4096).optional(),
        expiresAt: z.number().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
type AccountState = z.infer<typeof stateSchema>;
export interface MeetingModuleOptions {
  readonly command?: (home: string, assertCurrent: () => Promise<void>) => OwnedLarkCommand;
}
const empty = z.object({}).strict();
const envelope = <T>(value: unknown, schema: z.ZodType<T>) => {
  const { input } = z
    .object({ input: z.record(z.unknown()), operationState: z.unknown().optional() })
    .strict()
    .parse(value);
  // Canonical Host merges current non-secret settings into every operation.
  // These values are display input, never identity or replacement config authority.
  const { appId, notificationThreadId, minutesReference, ...body } = input;
  for (const setting of [appId, notificationThreadId, minutesReference])
    if (setting !== undefined && typeof setting !== 'string') throw new Error('Invalid meeting setting input');
  return schema.parse(body);
};
const publicStatus = (state: AccountState, live: string) => ({
  render: 'status',
  label: `Last account check: ${state.auth} · Collection: ${state.collectionIntent} · Live: ${live}`,
  data: { auth: state.auth, collectionIntent: state.collectionIntent, live },
});

async function activate(context: FeatureContext, options: MeetingModuleOptions): Promise<FeatureActivation> {
  const root = context.dataPath,
    home = join(root, 'account'),
    path = join(root, 'control.json');
  // Start is control-only: no credentials, config secrets, CLI or provider activity.
  const lifetime = new AbortController();
  let stopped = false,
    live = 'stopped',
    tail = Promise.resolve(),
    collection: AbortController | undefined;
  const active = async () => {
    if (stopped) throw new Error('Meeting module is stopped');
    void context.dataPath;
    lifetime.signal.throwIfAborted();
  };
  let current: () => Promise<void> = active;
  let currentSignal: AbortSignal = lifetime.signal;
  const command = (options.command ?? createOwnedLarkCommand)(home, () => current());
  const load = async (): Promise<AccountState> => {
    const bytes = await readPrivate(path);
    if (!bytes) return { v: 1, auth: 'not_configured', collectionIntent: 'disabled' };
    try {
      return stateSchema.parse(JSON.parse(bytes.toString('utf8')));
    } catch {
      throw new Error('Meeting control state is invalid: recovery required');
    }
  };
  const save = async (state: AccountState) => writePrivate(path, JSON.stringify(stateSchema.parse(state)), current);
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = tail.then(fn);
    tail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };
  const owned = (state: AccountState, owner: PluginOwnerOperationContext): AccountState => {
    if (state.ownerUserId && (state.ownerUserId !== owner.userId || state.instanceId !== owner.pluginInstanceId))
      throw new Error('Meeting account belongs to another owner or instance');
    return { ...state, ownerUserId: owner.userId, instanceId: owner.pluginInstanceId };
  };
  const ownerAction =
    (fn: (input: unknown, owner: PluginOwnerOperationContext) => Promise<unknown>): PluginActionHandler =>
    (input, native, caller) =>
      serial(async () => {
        if (native || caller?.kind !== 'owner-operation')
          throw new Error('Meeting Settings requires the authenticated owner operation');
        currentSignal = AbortSignal.any([lifetime.signal, caller.signal]);
        current = async () => {
          await active();
          currentSignal.throwIfAborted();
          await caller.assertCurrent();
          await active();
          currentSignal.throwIfAborted();
        };
        try {
          await current();
          owned(await load(), caller);
          const value = await fn(input, caller);
          await current();
          return value;
        } finally {
          current = active;
          currentSignal = lifetime.signal;
        }
      });
  const configure = async () => {
    const appId = await context.config.get('appId'),
      appSecret = await context.secrets.get('appSecret');
    await current();
    if (typeof appId !== 'string' || !appSecret) throw new Error('Save the Feishu app ID and secret in Settings first');
    await configureOwnedLarkHome(home, appId, appSecret, current);
    return appId;
  };
  const verify = async () => {
    const appId = await configure();
    try {
      const result = (await command(['auth', 'status', '--json', '--verify'], currentSignal)) as {
        appId?: string;
        identity?: string;
      };
      await current();
      requirePollingAuthorization(result);
      if (result.appId !== appId || result.identity !== 'user')
        throw new Error('The configured Feishu user account is unavailable');
      const state = await load();
      if (state.auth !== 'connected') await save({ ...state, auth: 'connected' });
      return result;
    } catch (error) {
      // Persist the fresh account observation before surfacing the failure in any
      // owner, native or background consumer. Lost/uncertain checks do not prove
      // credential expiry. Revoke/currentness refusal cannot commit a new state.
      await current();
      const auth = error instanceof FeishuGatewayError && error.code === 'AUTH_EXPIRED' ? 'expired' : 'unknown';
      await save({ ...(await load()), auth });
      throw error;
    }
  };
  const target = async (): Promise<string> => {
    const value = await context.config.get('notificationThreadId');
    await current();
    if (typeof value !== 'string' || !value.trim() || value.length > 500 || value.trim() !== value)
      throw new Error('Select a meeting notification thread in Settings');
    const thread = await context.threads.get(value);
    await current();
    if (!thread) throw new Error('Meeting notification thread is unavailable');
    return value;
  };
  const records = async () => {
    const state = await load();
    if (!state.instanceId) throw new Error('Authorize the meeting account first');
    return createMeetingRecordDelivery(join(root, 'records'), { pluginInstanceId: state.instanceId });
  };
  const deliver = async (record: MeetingRecord) => {
    await verify();
    if ((await target()) !== record.notification.input.threadId)
      throw new Error('Restore the original notification destination before retrying');
    return (await records()).deliver(
      record.id,
      async (input) => {
        await current();
        if ((await target()) !== input.threadId) throw new Error('Notification destination changed');
        const receipt = await context.messaging.send(input.threadId, {
          idempotencyKey: input.idempotencyKey,
          payload: input.payload,
        });
        await current();
        return receipt;
      },
      { assertCurrent: () => current() },
    );
  };
  const store = createFileMeetingIntakeStateStore(join(root, 'intake-state.json'));
  // The preserved state machine must honor the current operation at every async
  // boundary, including cursor/ack writes after an interrupted source read.
  const fencedStore = new Proxy(store, {
    get(target, key) {
      const member = target[key as keyof MeetingIntakeStateStore];
      if (typeof member !== 'function') return member;
      return async (...args: unknown[]) => {
        await current();
        const result = await Reflect.apply(member, target, args);
        await current();
        return result;
      };
    },
  }) as MeetingIntakeStateStore;
  const gateway = createLarkCliFeishuPollingGateway({
    homeDirectory: home,
    runCommand: (args, signal) => command(args, signal),
  });
  const runtime = createFeishuMeetingIntakeRuntime({
    gateway,
    store: fencedStore,
    publisher: {
      async publish(value) {
        const event = value as {
          occurredAt: string;
          payload: {
            artifactId: string;
            artifactKind: 'minute' | 'note';
            revision: string;
            generatedAt: string;
            title?: string;
            meetingId?: string;
          };
        };
        const { artifactKind, ...descriptor } = event.payload;
        const record = await (await records()).record(
          { ...descriptor, generatedAt: event.occurredAt, kind: artifactKind },
          await target(),
          { assertCurrent: () => current() },
        );
        return deliver(record);
      },
    },
  });
  const catchUp = createFeishuMeetingCatchUpService({ detector: gateway, scanner: gateway, store: fencedStore });
  const showRecords = async () =>
    rowsResult(
      (await (await records()).list({ limit: 32 })).records.map((record) => ({
        key: record.id,
        label: (record.descriptor.title ?? record.descriptor.artifactId).slice(0, 200),
        detail: record.notification.state,
        actions:
          record.notification.state === 'delivered' ? [] : [operationRowAction('retry', { recordId: record.id })],
      })),
      { empty: 'No retained meeting records' },
    );
  const poll = async () => {
    await verify();
    await target();
    const result = await runtime.pollOnce(currentSignal);
    await current();
    return result;
  };
  const startCollection = () => {
    if (collection) return;
    const controller = new AbortController();
    collection = controller;
    live = 'running';
    const run = async () => {
      while (!controller.signal.aborted && !stopped) {
        try {
          await serial(async () => {
            currentSignal = AbortSignal.any([controller.signal, lifetime.signal]);
            current = async () => {
              await active();
              currentSignal.throwIfAborted();
              if ((await load()).collectionIntent !== 'enabled') throw new Error('Collection paused');
            };
            try {
              await poll();
            } finally {
              current = active;
              currentSignal = lifetime.signal;
            }
          });
          await new Promise<void>((resolve) => {
            const done = () => {
              clearTimeout(timer);
              controller.signal.removeEventListener('abort', done);
              resolve();
            };
            const timer = setTimeout(done, 30_000);
            controller.signal.addEventListener('abort', done, { once: true });
            if (controller.signal.aborted) done();
          });
        } catch {
          if (!controller.signal.aborted && !stopped) live = 'degraded';
          break;
        }
      }
      if (collection === controller) {
        collection = undefined;
        if (controller.signal.aborted) live = 'stopped';
      }
    };
    void run();
  };
  const sourcePublication = createMeetingSourcePublication({
    directory: join(root, 'source-publications'),
    getRecord: async (id) => (await records()).get(id),
    readSource: async (record) => {
      await verify();
      const descriptor =
        record.descriptor.kind === 'minute'
          ? await createLarkCliFeishuArtifactInspector({ homeDirectory: home, runCommand: command })(
              { kind: 'minute', artifactId: record.descriptor.artifactId },
              currentSignal,
            )
          : record.descriptor;
      const source = await readMeetingSource(descriptor, command, home, currentSignal);
      await current();
      return { ...source, ...(descriptor.title ? { title: descriptor.title } : {}) };
    },
  });
  const actions: Record<string, PluginActionHandler> = {
    'meeting.sourceMaterial': ownerAction(async (input, owner) => {
      if (owner.operationKey !== 'sourceMaterial' || owner.actionId !== 'invoke')
        throw new Error('Authenticated meeting source operation required');
      const { operation } = envelope(input, z.object({ operation: z.unknown().optional() }).strict());
      if (operation === undefined)
        return {
          render: 'status',
          data: { kind: 'project_source_sharing' },
          label:
            'Share a meeting source explicitly from a Collective Project. Private meeting notifications remain private.',
        };
      return { render: 'status', data: await sourcePublication(operation, owner) };
    }),
    'meeting.status': ownerAction(async (input) => {
      envelope(input, empty);
      return publicStatus(await load(), live);
    }),
    'meeting.connect': ownerAction(async (input, owner) => {
      envelope(input, empty);
      const state = owned(await load(), owner);
      if (state.attempt)
        throw new Error(
          'Existing authorization attempt: check authorization or verify the account before starting again',
        );
      await configure();
      await save({ ...state, auth: 'unknown', attempt: { state: 'unknown' } });
      const value = (await command(
        [
          'auth',
          'login',
          '--no-wait',
          '--json',
          '--scope',
          'minutes:minutes.search:read minutes:minutes.basic:read minutes:minutes.artifacts:read vc:meeting.search:read vc:meeting.meetingevent:read vc:record:readonly vc:note:read docx:document:readonly',
        ],
        currentSignal,
      )) as Record<string, unknown>;
      await current();
      const parsed = z
        .object({
          device_code: z.string().min(1).max(4096),
          verification_url: z.string().max(4096),
          expires_in: z.number().int().min(1).max(3600),
        })
        .passthrough()
        .parse(value);
      const url = new URL(parsed.verification_url);
      if (
        url.protocol !== 'https:' ||
        !/(^|\.)feishu\.cn$/.test(url.hostname) ||
        url.port ||
        url.username ||
        url.password
      )
        throw new Error('Invalid Feishu device authorization URL');
      await save({
        ...state,
        auth: 'pending',
        attempt: {
          state: 'pending',
          deviceCode: parsed.device_code,
          url: url.href,
          expiresAt: Date.now() + parsed.expires_in * 1000,
        },
      });
      return {
        render: 'status',
        label: `Authorize at ${url.href}, then select Check authorization`,
        data: { authorizationUrl: url.href },
      };
    }),
    'meeting.complete': ownerAction(async (input, owner) => {
      envelope(input, empty);
      const state = owned(await load(), owner);
      if (state.attempt?.state === 'pending' && (state.attempt.expiresAt ?? 0) < Date.now()) {
        // Device challenge expiry does not prove any existing account is expired.
        // Keep its evidence and require a fresh account check instead of replay.
        await save({ ...state, auth: 'unknown', attempt: { ...state.attempt, state: 'unknown' } });
        throw new Error('Authorization attempt needs account verification before retry');
      }
      if (state.attempt?.state !== 'pending' || !state.attempt.deviceCode)
        throw new Error('Authorization attempt needs account verification before retry');
      await configure();
      await save({ ...state, auth: 'unknown', attempt: { ...state.attempt, state: 'unknown' } });
      await command(['auth', 'login', '--device-code', state.attempt.deviceCode, '--json'], currentSignal);
      await verify();
      const { attempt: _, ...base } = state;
      await save({ ...base, auth: 'connected' });
      return publicStatus(await load(), live);
    }),
    'meeting.reset': ownerAction(async (input, owner) => {
      envelope(input, empty);
      collection?.abort();
      const state = owned(await load(), owner);
      // An interrupted exchange remains possibly effective. Preserve its private
      // evidence; only an explicit owner decision abandons it, never a timeout retry.
      await writePrivate(
        join(root, 'authorization-history', randomUUID() + '.json'),
        JSON.stringify(state),
        current,
        true,
      );
      const { attempt: _, ...base } = state;
      await save({ ...base, auth: 'unknown', collectionIntent: 'disabled' });
      live = 'stopped';
      return {
        render: 'status',
        label: 'Prior attempt retained; collection paused. Verify the account or explicitly authorize again.',
      };
    }),
    'meeting.verify': ownerAction(async (input, owner) => {
      envelope(input, empty);
      const state = owned(await load(), owner);
      await verify();
      const { attempt: _, ...base } = state;
      await save({ ...base, auth: 'connected' });
      return publicStatus(await load(), live);
    }),
    'meeting.start': ownerAction(async (input, owner) => {
      envelope(input, empty);
      const state = owned(await load(), owner);
      await verify();
      await target();
      await save({ ...state, auth: 'connected', collectionIntent: 'enabled' });
      startCollection();
      return publicStatus(await load(), live);
    }),
    'meeting.pause': ownerAction(async (input) => {
      envelope(input, empty);
      collection?.abort();
      await save({ ...(await load()), collectionIntent: 'disabled' });
      live = 'stopped';
      return publicStatus(await load(), live);
    }),
    'meeting.poll': ownerAction(async (input) => {
      envelope(input, empty);
      const result = await poll();
      return {
        render: 'status',
        label: result.blocked
          ? 'Historical sources need your preview decision'
          : `${result.discovered} sources observed; ${result.published} notifications settled`,
        data: result,
      };
    }),
    'meeting.list': ownerAction(async (input) => {
      envelope(input, empty);
      return showRecords();
    }),
    'meeting.import': ownerAction(async (input) => {
      const body = envelope(input, z.object({ reference: z.string().min(1).max(2048).optional() }).strict());
      const reference = body.reference ?? (await context.config.get('minutesReference'));
      if (typeof reference !== 'string') throw new Error('Save the Minutes reference in Settings');
      await verify();
      await target();
      const result = await runtime.importArtifact(parseFeishuMinutesReference(reference), currentSignal);
      return {
        render: 'status',
        label: `${result.discovered} source recorded; ${result.published} notification settled. Open Meeting records to read or retry.`,
      };
    }),
    'meeting.retry': ownerAction(async (input) => {
      const { recordId } = envelope(input, z.object({ recordId: z.string().regex(/^[a-f0-9]{64}$/) }).strict());
      const record = await (await records()).get(recordId);
      if (!record) throw new Error('Meeting record not found');
      await deliver(record);
      return showRecords();
    }),
  };
  for (const method of ['preview', 'future', 'replay'] as const)
    actions['meeting.catchup.' + method] = ownerAction(async (input) => {
      await verify();
      await target();
      if (method === 'preview') {
        envelope(input, empty);
        await catchUp.detect(currentSignal);
        const preview = await catchUp.preview(currentSignal);
        return rowsResult([
          {
            key: preview.fingerprint,
            label: 'Missed meeting sources',
            detail: `${preview.candidateCount} sources`,
            actions: [
              operationRowAction('future', { fingerprint: preview.fingerprint }),
              operationRowAction('replay', { fingerprint: preview.fingerprint }),
            ],
          },
        ]);
      }
      const { fingerprint } = envelope(input, z.object({ fingerprint: z.string().regex(/^[a-f0-9]{64}$/) }).strict());
      const result =
        method === 'future' ? await catchUp.futureOnly(fingerprint) : await catchUp.replay(fingerprint, currentSignal);
      return {
        render: 'status',
        label: `${result.candidateCount} previewed historical sources: ${result.action}`,
        data: result,
      };
    });
  for (const method of ['list', 'read'] as const)
    actions['meeting.records.' + method] = (input, native, caller) =>
      serial(async () => {
        if (!native || caller) throw new Error('Meeting records require the authenticated native invocation');
        current = async () => {
          // This second context is issued by the declared native action carrier.
          // Its assertCurrent rechecks invocation, active instance, digest and grants.
          // Authenticated human-requested MCP reads use this injected context.
          await active();
          await native.assertCurrent();
          const state = await load();
          if (state.ownerUserId !== native.userId) throw new Error('Meeting account belongs to another owner');
          await active();
        };
        try {
          await current();
          if (method === 'list') {
            const parsed = meetingListInput.parse(input),
              page = await (await records()).list({
                limit: parsed.limit ?? 32,
                ...(parsed.after ? { after: parsed.after } : {}),
              });
            await current();
            await verify();
            await current();
            return {
              records: page.records
                .filter((record) => record.notification.input.threadId === native.threadId)
                .map((record) => ({
                  id: record.id,
                  descriptor: record.descriptor,
                  source: record.source,
                  notification: record.notification.state,
                })),
              ...(page.next ? { next: page.next } : {}),
            };
          }
          const parsed = meetingReadInput.parse(input),
            record = await (await records()).get(parsed.recordId);
          await current();
          if (!record || record.notification.input.threadId !== native.threadId)
            throw new Error('Meeting record is unavailable in this thread');
          await verify();
          const source = await readMeetingSource(record.descriptor, command, home, currentSignal);
          await current();
          const { text } = source;
          const offset = parsed.offset ?? 0,
            limit = parsed.limit ?? 16_000;
          return {
            recordId: record.id,
            source: record.source.handle,
            generationRevision: source.generationRevision,
            textSha256: source.textSha256,
            readAt: source.readAt,
            text: text.slice(offset, offset + limit),
            ...(offset + limit < text.length ? { nextOffset: offset + limit } : {}),
            untrusted: true,
          };
        } finally {
          current = active;
          currentSignal = lifetime.signal;
        }
      });
  return {
    actions,
    async dispose() {
      stopped = true;
      lifetime.abort(new Error('Meeting module is stopped'));
      collection?.abort();
      await tail;
      await gateway.close();
    },
  };
}
export function createMeetingPluginModule(options: MeetingModuleOptions = {}) {
  return definePluginModule((manifest) =>
    definePlugin({ manifest, activate: { 'generated-meeting-artifacts': (context) => activate(context, options) } }),
  );
}
export default createMeetingPluginModule();
