import assert from 'node:assert/strict';
import test from 'node:test';
import plugin from '../dist/index.js';
import {fixture} from './service-fixture.js';

test('packed entry serves HTML and business operations through declared HTTP handlers', async () => {
  const f = fixture();
  const activation = await plugin.create().start(f.host);
  assert.equal(typeof activation.actions['feedback.http'], 'function');
  const response = await activation.actions['feedback.http']({request:{method:'POST',path:'feedback',body:{op:'bootstrap'}}},undefined,f.ctx);
  assert.equal(response.status,200);
  assert.equal(response.headers['content-type'],'application/json; charset=utf-8');
  const chunks = await Array.fromAsync(response.body);
  assert.ok(Array.isArray(JSON.parse(Buffer.concat(chunks.map(chunk=>Buffer.from(chunk))).toString()).targets));
  const panel = await activation.actions['feedback.panel']({request:{method:'GET',path:'panel'}},undefined,{...f.ctx,operation:'read'});
  assert.equal(panel.status,200);
  assert.match(panel.headers['content-type'],/text\/html/);
  assert.match(panel.body,/<!doctype html>/i);
  await assert.rejects(activation.actions['feedback.panel']({request:{method:'POST',path:'panel'}},undefined,f.ctx),/GET/);
  const save={op:'save',feedbackId:'conflict',targetId:'clowder',report:{title:'first',body:'body',attachments:[]}};
  await activation.actions['feedback.http']({request:{method:'POST',path:'feedback',body:save}},undefined,f.ctx);
  const conflict=await activation.actions['feedback.http']({request:{method:'POST',path:'feedback',body:save}},undefined,f.ctx);
  assert.equal(conflict.status,409);
  assert.equal(conflict.body.code,'revision_conflict');
});
