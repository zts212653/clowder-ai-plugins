import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createGitHubSettings } from './settings.js';
import { parse } from 'yaml';
import { validateManifest } from '@clowder-ai/plugin-contract';
import { createGitHubPluginModule } from './plugin-entrypoint.js';

for (const login of ['alice_acme', 'octo_admin']) test(`connection probe accepts an authenticated managed-user login (${login})`, async () => {
  const settings = createGitHubSettings({ secrets: { get: async () => undefined } },
    async () => ({ stdout: login }));
  try {
    const result = await settings.actions['github.connection.test']({ input: {} });
    assert.equal(result.ok, true); assert.equal(result.details?.login, login);
  } finally { await settings.dispose(); }
});
const manifest = parse(await readFile(new URL('../plugin.yaml', import.meta.url), 'utf8'));

test('ordinary settings omit internal policies and obsolete credentials without deleting their declarations', () => {
  assert.equal(validateManifest(manifest).valid, true);
  for (const key of ['mcpToken', 'setupNoiseBotLogins', 'cloudReviewerLogins']) {
    assert.equal(manifest.configuration.find((field: any) => field.key === key)?.hidden, true, key);
  }
  const visible = manifest.configuration.filter((field: any) => !field.hidden);
  assert.deepEqual(visible.map((field: { key: string }) => field.key), ['recoveryMode', 'migrationRecovery', 'token', 'notificationAllowlist', 'notificationBlocklist', 'webhookSecret', 'publishRepositories']);
  assert.deepEqual(visible.filter((field: { kind: string }) => field.kind === 'operation').map((field: { key: string }) => field.key),
    ['migrationRecovery'], 'publishing remains in the thread preview; only retained-state recovery has an owner operation');
  assert.equal(visible.filter((field: any) => field.kind === 'secret').length, 2);
  assert.ok(visible.every((field: any) => field.required === false));
  assert.ok(visible.every((field: any) => /[\u4e00-\u9fff]/u.test(field.label)));
  assert.equal(manifest.test.action.method, 'github.connection.test');
});

test('settings disposal cancels its gh probe and joins child cleanup', async t => {
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  let release!: () => void;
  let aborted = false;
  const settings = createGitHubSettings({ secrets: { get: async () => undefined } }, async (_file, _args, options) => {
    entered();
    return new Promise((_resolve, reject) => {
      release = () => reject(new Error('child cleaned up'));
      options.signal?.addEventListener('abort', () => { aborted = true; }, { once: true });
    });
  });
  t.after(() => release?.());
  const pending = settings.actions['github.connection.test']({ input: {} });
  await started;
  const disposing = settings.dispose();
  assert.equal(aborted, true, 'disposing settings must abort its provider child');
  let disposed = false;
  void disposing?.then(() => { disposed = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(disposed, false, 'disposal must join cleanup');
  release();
  await disposing;
  assert.equal((await pending).ok, false);
  await assert.rejects(settings.actions['github.connection.test']({ input: {} }), /disposed/);
});

test('loaded settings test gh auth without starting runtime or changing saved values', async () => {
  const calls: Array<string | undefined> = [];
  let fail = false;
  const values = { narratorCatId: 'cat-old', narratorThreadId: 'thread-old', setupNoiseBotLogins: 'old-bot', cloudReviewerLogins: 'review-bot' };
  const secrets = { token: 'saved-secret', mcpToken: 'legacy-secret', webhookSecret: 'webhook-secret' };
  const before = JSON.stringify({ values, secrets });
  const module = createGitHubPluginModule({ createProvider: () => { throw Error('settings must not activate runtime'); },
    settingsExecFileAsync: async (file, args, options) => {
      assert.equal(file, 'gh');
      assert.deepEqual(args, ['api', 'user', '--hostname', 'github.com', '--jq', '.login', '--include']);
      assert.equal(options.timeout, 10_000);
      assert.equal(options.env?.GH_TOKEN, undefined);
      calls.push(options.env?.GITHUB_TOKEN);
      if (fail) throw Error('provider echoed saved-secret and private data');
      return { stdout: 'HTTP/2.0 200 OK\r\ncontent-type: text/plain\r\n\r\nfixture-user\n' };
    },
  });
  const definition = module.create(manifest);
  assert.equal(typeof definition.settings, 'function');
  const settings = await definition.settings!({ pluginInstanceId: 'isolated-settings', dataPath: '/unused-isolated-settings',
    config: { get: async key => values[key as keyof typeof values] },
    secrets: { get: async key => secrets[key as keyof typeof secrets] },
    log() {}, storage: {} as any,
  });
  assert.ok(settings.actions['github.connection.test']);
  const run = settings.actions['github.connection.test']!;
  const saved = await run({ input: {} }) as any;
  assert.equal(saved.ok, true);
  assert.match(saved.message, /插件访问令牌/);
  assert.deepEqual(Object.keys(saved).sort(), ['details', 'message', 'ok']);
  const unsaved = await run({ input: { token: ' unsaved-secret ' } }) as any;
  assert.equal(unsaved.ok, true);
  const cli = await run({ input: { token: '' } }) as any;
  assert.match(cli.message, /本机 gh 登录/);
  assert.deepEqual(calls, ['saved-secret', 'unsaved-secret', undefined]);
  fail = true;
  const failure = await run({ input: {} }) as any;
  assert.equal(failure.ok, false);
  assert.doesNotMatch(JSON.stringify([saved, unsaved, cli, failure]), /saved-secret|unsaved-secret|private data|targetValues/);
  await settings.dispose?.();
  assert.equal(JSON.stringify({ values, secrets }), before);
});
