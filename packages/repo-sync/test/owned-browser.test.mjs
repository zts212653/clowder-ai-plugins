import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { launchOwnedBrowser } from './owned-browser.mjs';

function fixture({ exits = true, connectFails = false, closeHangs = false } = {}) {
  const child = Object.assign(new EventEmitter(), { exitCode: null, signalCode: null });
  const destroyed = new Set();
  let finishPipes;
  const pipesClosed = new Promise((resolve) => {
    finishPipes = resolve;
  });
  for (const name of ['stdin', 'stdout', 'stderr'])
    child[name] = {
      destroy() {
        destroyed.add(name);
        if (destroyed.size === 3) finishPipes();
      },
    };
  const debugPipes = new Set();
  child.stdio = [
    child.stdin,
    child.stdout,
    child.stderr,
    ...['debug-read', 'debug-write'].map((name) => ({
      destroy() {
        debugPipes.add(name);
      },
    })),
  ];
  let disconnected = false,
    closed = false,
    killed = false,
    clientCreated = false;
  const server = {
    process: () => child,
    wsEndpoint: () => 'ws://test.invalid/browser',
    async close() {
      closed = true;
      if (closeHangs) return new Promise((done) => child.once('exit', done));
      if (!exits) return;
      child.exitCode = 0;
      child.emit('exit', 0, null);
      await pipesClosed;
    },
    async kill() {
      if (clientCreated)
        assert.equal(disconnected, true, 'the client must disconnect before the owned browser process is killed');
      killed = true;
      if (exits) {
        child.signalCode = 'SIGKILL';
        child.emit('exit', null, 'SIGKILL');
      }
    },
  };
  const browser = {
    close: async () => {
      disconnected = true;
    },
  };
  return {
    child,
    destroyed,
    debugPipes,
    isDisconnected: () => disconnected,
    wasClosed: () => closed,
    wasKilled: () => killed,
    type: {
      launchServer: async () => server,
      connect: async (endpoint) => {
        assert.equal(endpoint, server.wsEndpoint());
        if (connectFails) throw new Error('fixture connect failure');
        clientCreated = true;
        return browser;
      },
    },
  };
}

test('owned browser releases inherited pipes only after confirmed process exit and awaits both public closes', async () => {
  const f = fixture(),
    owner = await launchOwnedBrowser(f.type);
  assert.equal(f.destroyed.size, 0, 'a running browser must retain its streams');
  await owner.close();
  assert.equal(f.destroyed.size, 3);
  assert.equal(f.debugPipes.size, 2, 'Chromium remote-debugging fd3/fd4 are public child stdio streams too');
  assert.equal(f.isDisconnected(), true);
  assert.equal(f.wasClosed(), true, 'graceful server close should be preferred');
  await owner.close();
});

test('owned cleanup cannot report success while its browser process is still running', async () => {
  const f = fixture({ exits: false }),
    owner = await launchOwnedBrowser(f.type);
  await assert.rejects(owner.close(), /before its process exited/);
  assert.equal(f.destroyed.size, 0);
});

test('failed browser connection cleans up its own BrowserServer and preserves the failure', async () => {
  const f = fixture({ connectFails: true });
  await assert.rejects(launchOwnedBrowser(f.type), /fixture connect failure/);
  assert.equal(f.wasKilled(), true);
  assert.equal(f.destroyed.size, 3);
});

test('a stuck graceful browser close kills only the owned server and verifies its exit', async () => {
  const f = fixture({ closeHangs: true });
  const owner = await launchOwnedBrowser(f.type, { closeTimeoutMs: 10 });
  await owner.close();
  assert.equal(f.wasClosed(), true);
  assert.equal(f.wasKilled(), true);
  assert.equal(f.destroyed.size, 3);
});
