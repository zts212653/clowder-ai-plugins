import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exportLegacySource, legacyReadPlan, readOperatorConfig } from './operational-source-cli.js';
import { operatorConfigSchema, type OperatorConfig } from './operational-source-policy.js';
import { openLegacyReadPort } from './operational-source-redis.js';

const run = promisify(execFile);
const cli =
  process.env.GITHUB_TEST_REDIS_CLI ??
  (process.platform === 'darwin' ? '/opt/homebrew/bin/redis-cli' : '/usr/bin/redis-cli');
const serverPath =
  process.env.GITHUB_TEST_REDIS_SERVER ??
  (process.platform === 'darwin' ? '/opt/homebrew/bin/redis-server' : '/usr/bin/redis-server');

test('independent read-only producer exports an isolated legacy backend and preserves pending receipt ambiguity', async (t) => {
  // Optional system executable, never a production connection. CI has Redis
  // executables in PATH; local overrides are test-only, not operator discovery.
  try {
    await run(cli, ['--version']);
    await run(serverPath, ['--version']);
  } catch {
    t.skip('isolated Redis executables unavailable');
    return;
  }
  const directory = await mkdtemp(join(tmpdir(), 'github-readonly-source-')),
    socket = join(directory, 'redis.sock');
  const server = spawn(
    serverPath,
    [
      '--port',
      '0',
      '--unixsocket',
      socket,
      '--unixsocketperm',
      '700',
      '--save',
      '',
      '--appendonly',
      'no',
      '--dir',
      directory,
    ],
    { stdio: 'ignore' },
  );
  const finished = new Promise<void>((resolve) => server.once('exit', () => resolve()));
  const admin = async (...args: string[]) =>
    JSON.parse((await run(cli, ['--json', '-s', socket, ...args])).stdout) as unknown;
  try {
    for (let i = 0; ; i++) {
      try {
        if ((await admin('PING')) === 'PONG') break;
      } catch {}
      if (i === 100) throw new Error('Isolated Redis did not start');
      await new Promise((r) => setTimeout(r, 20));
    }
    await admin(
      'ACL',
      'SETUSER',
      'github-reader',
      'on',
      '>fixture-secret',
      '~fixture:*',
      '+ping',
      '+acl|whoami',
      '+select',
      '+zcard',
      '+zrange',
      '+hmget',
      '+hget',
      '+hexists',
      '+get',
      '+scard',
      '+smembers',
      '+scan',
      '+sscan',
    );
    const p = 'fixture:',
      task = {
        id: 'old-pr',
        kind: 'pr_tracking',
        threadId: 'thread',
        subjectKey: 'pr:example/project#12',
        userId: 'owner',
        ownerCatId: 'cat',
        title: 'Task title stays private',
        why: 'Task context stays private',
        createdBy: 'historical',
        createdAt: '1',
        updatedAt: '2',
        status: 'doing',
        automationState: JSON.stringify({
          await: {
            v: 1,
            generation: 27,
            subjectRef: 'pr:example/project#12',
            ownerFence: { kind: 'containing_task', generation: 27 },
            baseline: { capturedAt: 1, headSha: 'old' },
            continuation: { when: [{ kind: 'pr_head_changed' }], then: 'Continue' },
            createdAt: 1,
          },
        }),
        typedWaitRegistration: 'PRIVATE AUTHORITY BODY',
        invocationLease: 'PRIVATE LEASE',
      };
    const setHash = async (key: string, value: Record<string, string>) =>
      admin('HSET', p + key, ...Object.entries(value).flat());
    await setHash('task:old-pr', task);
    await admin('ZADD', p + 'tasks:kind:pr_tracking', '1', 'old-pr');
    await setHash('thread:thread', { createdBy: 'owner' });
    await setHash('community:repo-config:example/project', {
      repo: 'example/project',
      guardThreadId: 'thread',
      guardCatId: 'cat',
      reviewMode: 'observe_only',
      cloudReviewPolicy: 'optional',
      createdAt: '1',
      updatedAt: '2',
    });
    await setHash('connector-binding:github-repo-event:example/project', {
      connectorId: 'github-repo-event',
      externalChatId: 'example/project',
      threadId: 'thread',
      userId: 'owner',
    });
    await admin('SADD', p + 'community:repo-configs:index', 'example/project');
    await admin('SET', p + 'f141:baseline:example/project', '1');
    await admin('SET', p + 'f141:notified:example/project#pr-12', '1');
    await admin('SADD', p + 'community:events:seen', 'comment:example/project#12:7');
    await admin('SET', p + 'community:repo-comment:cursor:example/project', '2026-10-21T00:00:00.000Z');
    await setHash('msg:unrelated', { content: 'PRIVATE CHAT BODY' });
    const config: OperatorConfig = {
      v: 1,
      redisCli: cli,
      redisCliSha256: createHash('sha256')
        .update(await readFile(cli))
        .digest('hex'),
      connection: { kind: 'unix', socket },
      database: 0,
      username: 'github-reader',
      passwordEnv: 'GITHUB_RECOVERY_FIXTURE_PASSWORD',
      scope: {
        ownerUserId: 'owner',
        keyPrefix: p,
        repositories: ['example/project'],
        excludedTaskIds: ['parent-work'],
        sourceRef: 'fixture:read-only',
        oldWriterProofRef: 'fixture:no-writer',
      },
    };
    const previous = process.env.GITHUB_RECOVERY_FIXTURE_PASSWORD;
    process.env.GITHUB_RECOVERY_FIXTURE_PASSWORD = 'fixture-secret';
    t.after(() => {
      if (previous === undefined) delete process.env.GITHUB_RECOVERY_FIXTURE_PASSWORD;
      else process.env.GITHUB_RECOVERY_FIXTURE_PASSWORD = previous;
    });
    const configFile = join(directory, 'operator.json');
    await writeFile(configFile, JSON.stringify(config), { mode: 0o600 });
    assert.deepEqual(await readOperatorConfig(configFile), config);
    const plan = legacyReadPlan(config),
      output = join(directory, 'frozen.json');
    const snapshot = async () => {
      const keys = (await admin('KEYS', p + '*')) as string[];
      return Promise.all(keys.sort().map(async (k) => [k, await admin('DUMP', k)]));
    };
    const before = await snapshot();
    const entrypoint = process.env.GITHUB_TEST_OPERATOR_ENTRYPOINT;
    const result = JSON.parse(
      (
        await run(
          process.execPath,
          [
            ...(entrypoint
              ? [entrypoint]
              : ['--import', 'tsx', fileURLToPath(new URL('./operational-source-cli.ts', import.meta.url))]),
            '--config',
            configFile,
            '--execute-plan',
            plan.planDigest,
            '--output',
            output,
          ],
          { timeout: 30000 },
        )
      ).stdout,
    );
    assert.deepEqual(await snapshot(), before);
    assert.equal((await stat(output)).mode & 0o777, 0o600);
    const bytes = await readFile(output, 'utf8'),
      frozen = JSON.parse(bytes);
    assert.equal(frozen.snapshot.tasks[0].automationState.await.generation, 27);
    assert.equal(frozen.snapshot.repositories[0].progress['f141:notified:example/project#pr-12'], '1');
    assert.equal(result.readOnlyProof.writeCommands, 0);
    assert.ok(
      !bytes.includes('PRIVATE AUTHORITY') && !bytes.includes('PRIVATE LEASE') && !bytes.includes('PRIVATE CHAT'),
    );
    await assert.rejects(exportLegacySource(config, plan.planDigest, output, AbortSignal.timeout(1000)), /EEXIST/);
    await assert.rejects(
      exportLegacySource(config, 'wrong', join(directory, 'wrong'), AbortSignal.timeout(1000)),
      /changed/,
    );
    const port = await openLegacyReadPort(config, AbortSignal.timeout(10000));
    for (const [command, ...args] of [
      ['SET', p + 'task:old-pr', 'x'],
      ['HMGET', p + 'msg:unrelated', 'content'],
      ['HMGET', p + 'task:old-pr', 'typedWaitRegistration'],
      ['SCAN', '0', 'MATCH', '*', 'COUNT', '256'],
      ['HGETALL', p + 'task:old-pr'],
    ])
      await assert.rejects(port.reader.read(command!, ...args));
    assert.throws(() =>
      operatorConfigSchema.parse({ ...config, connection: { kind: 'tcp', host: 'localhost', port: 6399, tls: false } }),
    );
    // A known message without its notified marker must not be deemed settled.
    await admin('SET', p + 'msg:idem:owner:thread:github-repo-event:reconciliation-issue-example/project#99', 'msg99');
    const gap = join(directory, 'gap.json');
    await exportLegacySource(config, plan.planDigest, gap, AbortSignal.timeout(30000));
    assert.equal(JSON.parse(await readFile(gap, 'utf8')).snapshot.unresolvedRepositoryDeliveries, 1);
    const pending = {
      v: 1,
      generation: 27,
      subjectRef: task.subjectKey,
      ownerFence: { kind: 'containing_task', generation: 27 },
      outcomeId: 'outcome',
      at: 800,
      reason: 'matched',
      delivery: 'pending',
      matched: [{ kind: 'pr_head_changed', delta: 'original fact', sourceRef: 'github:original' }],
    };
    await setHash('task:old-pr', { status: 'done', automationState: JSON.stringify({ waitOutcome: pending }) });
    const receiptFile = join(directory, 'unclaimed.json');
    await exportLegacySource(config, plan.planDigest, receiptFile, AbortSignal.timeout(30000));
    assert.equal(
      JSON.parse(await readFile(receiptFile, 'utf8')).snapshot.receipts[0].disposition,
      'not-delivered',
      'terminal unclaimed delivery is included, not dropped',
    );
    await setHash('task:old-pr', {
      automationState: JSON.stringify({ waitOutcome: { ...pending, publishClaimedAt: 801 } }),
    });
    await admin('SET', p + 'msg:idem:owner:thread:github-wait:old-pr:outcome', 'pending-message');
    await setHash('msg:pending-message', {
      id: 'pending-message',
      threadId: 'thread',
      userId: 'owner',
      mentions: JSON.stringify(['cat']),
      deliveryStatus: 'delivered',
      content: 'PRIVATE PENDING BODY',
      source: 'PRIVATE PROVIDER META',
    });
    const ambiguous = join(directory, 'ambiguous.json');
    await exportLegacySource(config, plan.planDigest, ambiguous, AbortSignal.timeout(30000));
    assert.equal(
      JSON.parse(await readFile(ambiguous, 'utf8')).snapshot.receipts[0].disposition,
      'ambiguous',
      'visible History alone is not wake admission',
    );
    await admin('HSET', p + 'queue:{thread}:messages', 'pending-message', JSON.stringify(['entry']));
    const settled = join(directory, 'settled.json');
    await exportLegacySource(config, plan.planDigest, settled, AbortSignal.timeout(30000));
    assert.equal(JSON.parse(await readFile(settled, 'utf8')).snapshot.receipts[0].disposition, 'delivered');
    assert.ok(
      !(await readFile(settled, 'utf8')).includes('PRIVATE PENDING') &&
        !(await readFile(settled, 'utf8')).includes('PRIVATE PROVIDER'),
    );
    await admin('ZADD', p + 'tasks:kind:pr_tracking', '2', 'parent-work');
    await assert.rejects(
      exportLegacySource(config, plan.planDigest, join(directory, 'excluded'), AbortSignal.timeout(30000)),
      /Excluded Task/,
    );
  } finally {
    server.kill('SIGTERM');
    await finished;
    await rm(directory, { recursive: true, force: true });
  }
});
