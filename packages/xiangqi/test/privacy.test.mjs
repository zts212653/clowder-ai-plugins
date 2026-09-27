import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

function texts(root) {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    return entry.isDirectory() ? texts(path) : [readFileSync(path, 'utf8')];
  });
}

test('public plugin code and fixtures contain no private target or path', () => {
  const root = new URL('../', import.meta.url).pathname;
  const value = texts(join(root, 'src')).concat(texts(join(root, 'test'))).join('\n');
  for (const privatePattern of [
    /thread_mu[a-z0-9]+/i,
    /codex[-]astra/i,
    /uncle[-]0[12]/i,
    /\/Users\/lysander\//,
    /default[-]user/i,
    /127[.]0[.]0[.]1:3002/,
  ]) assert.doesNotMatch(value, privatePattern);
});
