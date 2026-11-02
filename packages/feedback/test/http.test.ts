import assert from 'node:assert/strict';
import test from 'node:test';
import plugin from '../dist/index.js';
import {fixture} from './service-fixture.js';

test('packed entry uses a declared HTTP handler for business and reserves the UI command for mounting', async () => {
  const f = fixture();
  const activation = await plugin.create().start(f.host);
  assert.equal(typeof activation.actions['feedback.http'], 'function');
  const response = await activation.actions['feedback.http']({request:{method:'POST',path:'feedback',body:{op:'bootstrap'}}},undefined,f.ctx);
  assert.equal(response.status,200);
  assert.equal(response.headers['content-type'],'application/json; charset=utf-8');
  const chunks = await Array.fromAsync(response.body);
  assert.ok(Array.isArray(JSON.parse(Buffer.concat(chunks.map(chunk=>Buffer.from(chunk))).toString()).targets));
  const panel = await activation.actions['feedback.panel']({op:'open'},undefined,f.ctx);
  assert.equal(panel.kind,'plugin-panel');
  await assert.rejects(activation.actions['feedback.panel']({op:'bootstrap'},undefined,f.ctx),/挂载|mount/);
});
