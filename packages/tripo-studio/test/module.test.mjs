import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { parse } from 'yaml';

const root = new URL('../', import.meta.url);
const manifest = parse(await readFile(new URL('plugin.yaml', root), 'utf8'));

test('the declared module loads without starting MCP or touching Chrome', async () => {
  assert.equal(typeof manifest.runtime.entrypoint, 'string', 'Settings needs a loadable module entrypoint');
  const { createTripoPluginModule } = await import(new URL(manifest.runtime.entrypoint, root));
  let probes = 0;
  const entry = createTripoPluginModule({ probe: async () => {
    probes++;
    return { artifact: { version: manifest.version }, auth: { status: 'unverified' }, live: { status: 'dormant' } };
  } });
  const module = entry.create(manifest);
  const settings = await module.settings({});
  const runtime = await module.start({});
  assert.equal(probes, 0, 'install, settings and enable are passive');
  const action = manifest.configuration[0].actions[0].action.method;
  const result = await settings.actions[action]({ input: {} });
  assert.equal(result.render, 'status');
  assert.equal(result.data.auth.status, 'unverified');
  assert.match(result.label, /未连接/);
  assert.equal(probes, 1);
  await settings.dispose();
  await runtime.stop({ reason: 'disabled' });
  await assert.rejects(settings.actions[action]({}), /TRIPO_MODULE_STOPPED/);
  const restarted = await module.start({});
  await restarted.actions[action]({});
  assert.equal(probes, 2, 're-enable gets a fresh action lifetime');
  await restarted.stop({ reason: 'disabled' });
});

test('settings disposal and owner cancellation abort probes and fence late results', async () => {
  assert.equal(typeof manifest.runtime.entrypoint, 'string', 'Settings needs a loadable module entrypoint');
  const { createTripoPluginModule } = await import(new URL(manifest.runtime.entrypoint, root));
  let release;
  let observedSignal;
  const entry = createTripoPluginModule({ probe: ({ signal }) => {
    observedSignal = signal;
    return new Promise(resolve => { release = resolve; });
  } });
  const module = entry.create(manifest);
  const action = manifest.configuration[0].actions[0].action.method;
  for (const cancelOwner of [false, true]) {
    const settings = await module.settings({});
    const owner = new AbortController();
    const pending = settings.actions[action]({}, undefined, { signal: owner.signal });
    if (cancelOwner) owner.abort(new Error('OWNER_CANCELLED'));
    else await settings.dispose();
    assert.equal(observedSignal.aborted, true);
    release({ live: { status: 'connected' } });
    await assert.rejects(pending, cancelOwner ? /OWNER_CANCELLED/ : /TRIPO_MODULE_STOPPED/);
    await settings.dispose();
  }
});
