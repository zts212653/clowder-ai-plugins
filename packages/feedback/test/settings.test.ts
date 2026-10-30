import assert from 'node:assert/strict';
import test from 'node:test';
import plugin from '../src/index.js';

test('installed settings self-test returns the Host PluginTestResult contract', async () => {
  const settings = plugin.create().settings({config: {get: async () => undefined}});
  const result = await settings.actions['feedback.check']();
  assert.deepEqual(Object.keys(result).sort(), ['message', 'ok']);
  assert.equal(result.ok, true);
  assert.match(result.message, /目标配置有效/);
});
