import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import {
  encodeNativeMessage,
  NativeMessageDecoder,
} from '../plugins/cloud-cat-personal-host/native-host/native-framing.mjs';
import { callBridge } from '../plugins/tripo-studio/runtime/bridge-client.mjs';
import { VERSION } from '../plugins/tripo-studio/runtime/contract.mjs';
import { prepareHelper } from '../plugins/tripo-studio/runtime/install.mjs';
import { startNativeHost } from '../plugins/tripo-studio/runtime/native-host.mjs';
import { pluginPaths } from '../plugins/tripo-studio/runtime/paths.mjs';

test('native install closure starts privately, forwards only paired narrow operations, and disconnects honestly', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'tripo-home-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const receipt = await prepareHelper({ home, platform: 'darwin' });
  assert.equal(receipt.live.status, 'dormant');
  assert.equal((await stat(pluginPaths(home).record)).mode & 0o777, 0o600);
  const nativeManifest = JSON.parse(
    await readFile(
      join(home, 'Library/Application Support/Google/Chrome/NativeMessagingHosts/ai.catcafe.tripo_studio.json'),
    ),
  );
  assert.deepEqual(nativeManifest.allowed_origins, [`chrome-extension://${receipt.artifact.extensionId}/`]);
  const input = new PassThrough(),
    output = new PassThrough();
  const decoder = new NativeMessageDecoder();
  let replyVersion = VERSION;
  let replyError;
  output.on('data', (chunk) => {
    for (const request of decoder.push(chunk)) {
      if (request.op)
        input.write(
          encodeNativeMessage({
            v: 1,
            id: request.id,
            ...(replyError
              ? { error: replyError }
              : { result: { version: replyVersion, authorized: [], observations: [] } }),
          }),
        );
    }
  });
  const host = await startNativeHost(pluginPaths(home).record, { input, output });
  t.after(() => host.close());
  const response = await callBridge('status', { paths: pluginPaths(home) });
  assert.equal(response.version, VERSION);
  assert.equal((await callBridge('observe', { paths: pluginPaths(home) })).version, VERSION);
  for (const version of ['0.0.0', undefined]) {
    replyVersion = version;
    for (const op of ['status', 'observe'])
      await assert.rejects(callBridge(op, { paths: pluginPaths(home) }), /CHROME_VERSION_MISMATCH/);
  }
  replyError = 'HELPER_VERSION_MISMATCH';
  await assert.rejects(callBridge('status', { paths: pluginPaths(home) }), { code: 'CHROME_VERSION_MISMATCH' });
  await assert.rejects(callBridge('evaluate', { paths: pluginPaths(home) }), /INVALID_OPERATION/);
  await host.close();
  await assert.rejects(callBridge('status', { paths: pluginPaths(home) }), /DISCONNECTED/);
});

test('caller cancellation closes an outstanding native observation', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'tripo-bridge-cancel-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  await prepareHelper({ home, platform: 'darwin' });
  const input = new PassThrough(),
    output = new PassThrough();
  const decoder = new NativeMessageDecoder();
  let started;
  const running = new Promise((resolve) => {
    started = resolve;
  });
  output.on('data', (chunk) => {
    for (const request of decoder.push(chunk)) if (request.op) started();
  });
  const host = await startNativeHost(pluginPaths(home).record, { input, output });
  t.after(() => host.close());
  const controller = new AbortController();
  const outcome = callBridge('observe', { paths: pluginPaths(home), signal: controller.signal, timeoutMs: 200 });
  await running;
  controller.abort();
  await assert.rejects(outcome, /abort/i);
});
