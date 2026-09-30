import assert from 'node:assert/strict';
import test from 'node:test';

import { downloadMediaFromCdn, encryptAesEcb } from './weixin-cdn.js';

function recordingLogger() {
  const logs: unknown[] = [];
  return {
    logs,
    log: {
      info: (...args: readonly unknown[]) => { logs.push(args); },
      warn: (...args: readonly unknown[]) => { logs.push(args); },
      error: (...args: readonly unknown[]) => { logs.push(args); },
      debug: (...args: readonly unknown[]) => { logs.push(args); },
    },
  };
}

test('inbound CDN failures never expose the private locator or AES key in logs and errors', async () => {
  const { logs, log } = recordingLogger();
  const privateUrl = 'https://novac2c.cdn.weixin.qq.com/c2c/download?secret-locator=private';
  const aesKey = '00112233445566778899aabbccddeeff';
  await assert.rejects(downloadMediaFromCdn({
    platformKey: JSON.stringify({ fullUrl: privateUrl, aesKey }),
    cdnBaseUrl: 'https://novac2c.cdn.weixin.qq.com/c2c',
    log,
    fetchFn: async () => new Response('provider echoed secret-locator=private', { status: 500 }),
  }), (error: Error) => {
    assert.equal(error.message.includes('secret-locator'), false);
    assert.equal(error.message.includes(aesKey), false);
    return true;
  });
  const observable = JSON.stringify(logs);
  assert.equal(observable.includes('secret-locator'), false);
  assert.equal(observable.includes(aesKey), false);
  assert.equal(observable.includes(aesKey.slice(0, 8)), false, 'even an AES-key prefix is private');
});

test('successful inbound CDN downloads log only safe metadata', async () => {
  const { logs, log } = recordingLogger();
  const privateUrl = 'https://novac2c.cdn.weixin.qq.com/c2c/download?secret-locator=private';
  const aesKey = '00112233445566778899aabbccddeeff';
  const plaintext = Buffer.from('private-media-bytes');
  const ciphertext = encryptAesEcb(plaintext, Buffer.from(aesKey, 'hex'));

  const result = await downloadMediaFromCdn({
    platformKey: JSON.stringify({ fullUrl: privateUrl, aesKey }),
    cdnBaseUrl: 'https://novac2c.cdn.weixin.qq.com/c2c',
    log,
    fetchFn: async () => new Response(new Uint8Array(ciphertext), { status: 200 }),
  });

  assert.deepEqual(result, plaintext);
  const observable = JSON.stringify(logs);
  assert.equal(observable.includes('secret-locator'), false);
  assert.equal(observable.includes(aesKey), false);
  assert.equal(observable.includes(aesKey.slice(0, 8)), false, 'even an AES-key prefix is private');
});
