import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { ModulePluginHostShape, PluginActionContext, PluginOwnerOperationContext } from '@clowder-ai/plugin-sdk';
import { createMeetingPluginModule } from '../src/plugin-entrypoint.js';

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'meeting-shipped-journey-'));
  const config = new Map<string, unknown>([
    ['appId', 'cli_fixture'],
    ['notificationThreadId', 'thread'],
    ['minutesReference', 'minute1'],
  ]);
  const calls: string[][] = [],
    sends: unknown[] = [];
  let revoked = false,
    blocked = false,
    failCompletion = false,
    authVerified = true,
    statusFailure = false,
    authChecks = 0,
    expireAtCheck = Infinity,
    deviceExpiry = 240;
  const current = async () => {
    if (revoked) throw new Error('owner revoked');
  };
  const owner = (actionId: string, operationKey = 'account'): PluginOwnerOperationContext => ({
    kind: 'owner-operation',
    userId: 'owner',
    pluginInstanceId: 'installed-meeting',
    operationKey,
    actionId,
    requestId: actionId,
    signal: new AbortController().signal,
    assertCurrent: current,
  });
  const minute = {
    ok: true,
    data: { minute: { token: 'minute1', create_time: '1786381200000', title: 'Meeting title' } },
  };
  const scopes =
    'minutes:minutes.search:read minutes:minutes.basic:read vc:meeting.search:read vc:meeting.meetingevent:read vc:record:readonly';
  const host = {
    pluginInstanceId: 'installed-meeting',
    dataPath: directory,
    config: {
      async get(key: string) {
        return config.get(key);
      },
    },
    secrets: {
      async get() {
        return 'fixture-private-app-secret';
      },
    },
    storage: {},
    tasks: {},
    threads: {
      async get(id: string) {
        if (blocked) return null;
        return {
          id,
          deepLinkUrl: 'http://127.0.0.1/thread',
          title: null,
          createdAt: 1,
          lastActiveAt: 1,
          preferredCats: ['cat'],
          featureRefs: [],
        };
      },
    },
    streams: { read: async function* () {} },
    messaging: {
      get: async () => null,
      async send(input: { threadId: string }) {
        sends.push(input);
        return { messageId: 'notice', threadId: input.threadId };
      },
    },
    log() {},
  } as unknown as ModulePluginHostShape;
  const module = createMeetingPluginModule({
    command: () => async (args, signal, cwd) => {
      signal.throwIfAborted();
      calls.push([...args]);
      if (args[0] === 'auth' && args[1] === 'status') {
        authChecks++;
        if (statusFailure) throw new Error('Fixture provider timeout');
        return {
          appId: 'cli_fixture',
          identity: 'user',
          verified: authVerified && authChecks < expireAtCheck,
          identities: { user: { scope: scopes } },
        };
      }
      if (args[0] === 'auth' && args[1] === 'login' && !args.includes('--no-wait') && failCompletion)
        throw new Error('Token exchange result lost');
      if (args[0] === 'auth' && args[1] === 'login')
        return args.includes('--no-wait')
          ? {
              device_code: 'private-device-code',
              verification_url: 'https://accounts.feishu.cn/device?user_code=fixture',
              expires_in: deviceExpiry,
            }
          : { ok: true };
      if (args[0] === 'minutes' && args[1] === 'minutes') return minute;
      if (args[0] === 'minutes' && args[1] === '+detail') {
        await mkdir(join(cwd!, 'artifact'), { recursive: true });
        await writeFile(join(cwd!, 'artifact', 'transcript.txt'), 'Source transcript', { mode: 0o600 });
        return {
          data: { minutes: [{ minute_token: 'minute1', artifacts: { transcript_file: 'artifact/transcript.txt' } }] },
        };
      }
      throw new Error('Unexpected fixture command');
    },
  });
  const manifest = JSON.parse(await readFile(new URL('../manifest.json', import.meta.url), 'utf8'));
  let active = await module.create(manifest).start(host);
  const native: PluginActionContext = {
    userId: 'owner',
    threadId: 'thread',
    catId: 'cat',
    invocationId: 'invocation',
    assertCurrent: current,
  };
  const input = (body: Record<string, unknown> = {}) => ({ input: { ...Object.fromEntries(config), ...body } });
  return {
    directory,
    get active() {
      return active;
    },
    async restart() {
      await active.stop({ reason: 'test' });
      active = await module.create(manifest).start(host);
    },
    native,
    input,
    owner,
    config,
    calls,
    sends,
    loseCompletion() {
      failCompletion = true;
    },
    expireAuth() {
      authVerified = false;
    },
    restoreAuth() {
      authVerified = true;
      statusFailure = false;
      expireAtCheck = Infinity;
    },
    loseStatus() {
      statusFailure = true;
    },
    expireAfterChecks(count: number) {
      expireAtCheck = authChecks + count;
    },
    shortDeviceAttempt() {
      deviceExpiry = 1;
    },
    revoke() {
      revoked = true;
    },
    block() {
      blocked = true;
    },
    async close() {
      await active.stop({ reason: 'test' });
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test('actual Settings → device authorization → retained notification → native read survives module restart', async () => {
  const f = await fixture();
  try {
    assert.equal(f.calls.length, 0);
    const challenge = await f.active.actions['meeting.connect']!(
      f.input(),
      undefined,
      f.owner('connect', 'authorization'),
    );
    assert.ok(!JSON.stringify(challenge).includes('private-device-code'));
    const pending = (await f.active.actions['meeting.status']!(f.input(), undefined, f.owner('status'))) as {
      data: { auth: string; collectionIntent: string };
    };
    assert.equal(pending.data.auth, 'pending');
    assert.equal(pending.data.collectionIntent, 'disabled');
    await f.active.actions['meeting.complete']!(f.input(), undefined, f.owner('complete', 'authorization'));
    await f.active.actions['meeting.import']!(f.input(), undefined, f.owner('import', 'manualImport'));
    assert.equal(f.sends.length, 1);
    const page = (await f.active.actions['meeting.records.list']!({}, f.native)) as { records: { id: string }[] };
    assert.equal(page.records.length, 1);
    const read = (await f.active.actions['meeting.records.read']!({ recordId: page.records[0]!.id }, f.native)) as {
      text: string;
      generationRevision: string;
      textSha256: string;
    };
    assert.equal(read.text, 'Source transcript');
    assert.equal(read.generationRevision, '1786381200000');
    assert.match(read.textSha256, /^[a-f0-9]{64}$/);
    await f.active.actions['meeting.import']!(f.input(), undefined, f.owner('import', 'manualImport'));
    assert.equal(f.sends.length, 1, 'delivered record is retained and never notified twice');
    const prior = f.calls.length;
    await f.restart();
    assert.equal(f.calls.length, prior, 'restart remains control-only');
    const retained = (await f.active.actions['meeting.records.list']!({}, f.native)) as { records: { id: string }[] };
    assert.equal(retained.records[0]?.id, page.records[0]!.id);
    const publication = {
      publicationId: 'fixture-publication',
      serviceInstanceId: 'svc-fixture',
      collectiveId: 'col-fixture',
      connectionId: 'con-fixture',
      humanId: 'human-owner',
      roadmapId: 'roadmap-fixture',
      channelId: 'general',
      sourceEventId: 'evt_fixture',
      provider: 'feishu',
      sourceId: retained.records[0]!.id,
    };
    const publicRead = (action: 'publish' | 'read') =>
      f.active.actions['meeting.sourceMaterial']!(
        {
          ...f.input({ operation: { action, publication } }),
          operationState: { currentAction: 'invoke', updatedAt: 1 },
        },
        undefined,
        f.owner('invoke', 'sourceMaterial'),
      ) as Promise<{ render: string; data: { status: string; material?: { clauses: { text: string }[] } } }>;
    assert.equal((await publicRead('read')).data.status, 'unavailable');
    const published = await publicRead('publish');
    assert.equal(published.render, 'status');
    assert.equal(published.data.material?.clauses[0]?.text, 'Source transcript');
    await f.restart();
    assert.equal((await publicRead('read')).data.status, 'available');
    f.expireAuth();
    assert.equal((await publicRead('read')).data.status, 'unavailable');
    f.restoreAuth();
    await assert.rejects(
      () =>
        f.active.actions['meeting.records.read']!(
          { recordId: page.records[0]!.id, userId: 'owner' },
          f.native,
        ) as Promise<unknown>,
    );
    await assert.rejects(
      () =>
        f.active.actions['meeting.records.read']!(
          { recordId: page.records[0]!.id },
          { ...f.native, threadId: 'foreign' },
        ) as Promise<unknown>,
      /thread|unavailable/,
    );
    f.block();
    await assert.rejects(
      () =>
        f.active.actions['meeting.import']!(
          f.input(),
          undefined,
          f.owner('import', 'manualImport'),
        ) as Promise<unknown>,
      /thread.*unavailable/,
    );
    assert.equal(f.sends.length, 1);
    f.revoke();
    await assert.rejects(
      () => f.active.actions['meeting.status']!(f.input(), undefined, f.owner('status')) as Promise<unknown>,
      /revoked/,
    );
  } finally {
    await f.close();
  }
});

test('native action rejects owner/ordinary calls and Settings refuses body identity or naked input', async () => {
  const f = await fixture();
  try {
    await assert.rejects(() => f.active.actions['meeting.records.list']!({}) as Promise<unknown>, /native invocation/);
    await assert.rejects(
      () =>
        f.active.actions['meeting.status']!(
          { input: { userId: 'owner' } },
          undefined,
          f.owner('status'),
        ) as Promise<unknown>,
    );
    await assert.rejects(
      () => f.active.actions['meeting.status']!({}, undefined, f.owner('status')) as Promise<unknown>,
    );
    assert.equal(f.calls.length, 0);
    assert.equal(f.sends.length, 0);
  } finally {
    await f.close();
  }
});

test('interrupted authorization retains unknown truth and never blindly repeats token exchange', async () => {
  const f = await fixture();
  try {
    await f.active.actions['meeting.connect']!(f.input(), undefined, f.owner('connect', 'authorization'));
    f.loseCompletion();
    await assert.rejects(
      () =>
        f.active.actions['meeting.complete']!(
          f.input(),
          undefined,
          f.owner('complete', 'authorization'),
        ) as Promise<unknown>,
      /result lost/,
    );
    const unknown = (await f.active.actions['meeting.status']!(f.input(), undefined, f.owner('status'))) as {
      data: { auth: string };
    };
    assert.equal(unknown.data.auth, 'unknown');
    const calls = f.calls.length;
    await assert.rejects(
      () =>
        f.active.actions['meeting.complete']!(
          f.input(),
          undefined,
          f.owner('complete', 'authorization'),
        ) as Promise<unknown>,
      /verification/,
    );
    assert.equal(f.calls.length, calls, 'no second exchange');
    await f.restart();
    await f.active.actions['meeting.verify']!(f.input(), undefined, f.owner('verify', 'verifyAccount'));
    const status = (await f.active.actions['meeting.status']!(f.input(), undefined, f.owner('status'))) as {
      data: { auth: string; collectionIntent: string };
    };
    assert.equal(status.data.auth, 'connected');
    assert.equal(status.data.collectionIntent, 'disabled');
  } finally {
    await f.close();
  }
});

test('every account-validation consumer persists explicit expired truth before rejecting', async () => {
  const f = await fixture();
  try {
    await f.active.actions['meeting.verify']!(f.input(), undefined, f.owner('verify', 'verifyAccount'));
    await f.active.actions['meeting.import']!(f.input(), undefined, f.owner('import', 'manualImport'));
    const page = (await f.active.actions['meeting.records.list']!({}, f.native)) as { records: { id: string }[] };
    const checks = [
      () => f.active.actions['meeting.verify']!(f.input(), undefined, f.owner('verify', 'verifyAccount')),
      () => f.active.actions['meeting.start']!(f.input(), undefined, f.owner('start', 'collection')),
      () => f.active.actions['meeting.poll']!(f.input(), undefined, f.owner('poll', 'collectNow')),
      () => f.active.actions['meeting.import']!(f.input(), undefined, f.owner('import', 'manualImport')),
      () => f.active.actions['meeting.records.list']!({}, f.native),
      () => f.active.actions['meeting.records.read']!({ recordId: page.records[0]!.id }, f.native),
    ];
    for (const invoke of checks) {
      f.restoreAuth();
      await f.active.actions['meeting.verify']!(f.input(), undefined, f.owner('verify', 'verifyAccount'));
      f.expireAuth();
      await assert.rejects(invoke as () => Promise<unknown>, /not verified/);
      const status = (await f.active.actions['meeting.status']!(f.input(), undefined, f.owner('status'))) as {
        data: { auth: string };
      };
      assert.equal(status.data.auth, 'expired');
    }
    assert.equal(f.sends.length, 1, 'negative verification cannot produce another notification');
    await f.restart();
    const retained = (await f.active.actions['meeting.status']!(f.input(), undefined, f.owner('status'))) as {
      data: { auth: string };
    };
    assert.equal(retained.data.auth, 'expired', 'negative account truth survives restart');
    f.restoreAuth();
    await f.active.actions['meeting.records.list']!({}, f.native);
    const recovered = (await f.active.actions['meeting.status']!(f.input(), undefined, f.owner('status'))) as {
      data: { auth: string };
    };
    assert.equal(recovered.data.auth, 'connected', 'a fresh successful native account check restores truth');
  } finally {
    await f.close();
  }
});

test('provider uncertainty becomes unknown and background auth-negative is separate from degraded live state', async () => {
  const f = await fixture();
  try {
    await f.active.actions['meeting.verify']!(f.input(), undefined, f.owner('verify', 'verifyAccount'));
    f.loseStatus();
    await assert.rejects(
      () =>
        f.active.actions['meeting.verify']!(
          f.input(),
          undefined,
          f.owner('verify', 'verifyAccount'),
        ) as Promise<unknown>,
      /provider timeout/,
    );
    const unknown = (await f.active.actions['meeting.status']!(f.input(), undefined, f.owner('status'))) as {
      data: { auth: string };
    };
    assert.equal(unknown.data.auth, 'unknown');
    f.restoreAuth();
    await f.active.actions['meeting.verify']!(f.input(), undefined, f.owner('verify', 'verifyAccount'));
    f.expireAfterChecks(2); // start verifies successfully; the first background check explicitly refuses.
    await f.active.actions['meeting.start']!(f.input(), undefined, f.owner('start', 'collection'));
    let status: { data: { auth: string; live: string; collectionIntent: string } } | undefined;
    for (let i = 0; i < 20; i++) {
      status = (await f.active.actions['meeting.status']!(f.input(), undefined, f.owner('status'))) as typeof status;
      if (status?.data.live === 'degraded') break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.deepEqual(status?.data, { auth: 'expired', collectionIntent: 'enabled', live: 'degraded' });
    assert.equal(f.sends.length, 0);
  } finally {
    await f.close();
  }
});

test('expired device challenge records unknown account truth without repeating the exchange', async () => {
  const f = await fixture();
  try {
    f.shortDeviceAttempt();
    await f.active.actions['meeting.connect']!(f.input(), undefined, f.owner('connect', 'authorization'));
    await new Promise((resolve) => setTimeout(resolve, 1050));
    const before = f.calls.length;
    await assert.rejects(
      () =>
        f.active.actions['meeting.complete']!(
          f.input(),
          undefined,
          f.owner('complete', 'authorization'),
        ) as Promise<unknown>,
      /verification/,
    );
    const status = (await f.active.actions['meeting.status']!(f.input(), undefined, f.owner('status'))) as {
      data: { auth: string };
    };
    assert.equal(status.data.auth, 'unknown', 'expired challenge does not prove old account credentials are expired');
    assert.equal(f.calls.length, before);
    await assert.rejects(
      () =>
        f.active.actions['meeting.complete']!(
          f.input(),
          undefined,
          f.owner('complete', 'authorization'),
        ) as Promise<unknown>,
    );
    assert.equal(f.calls.length, before, 'no blind exchange retry');
  } finally {
    await f.close();
  }
});
