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

test('PDL panel returns structured conflicts over its authenticated HTTP frame route', async () => {
  const f = fixture();
  const activation = await plugin.create().start(f.host);
  const input = { op: 'save', feedbackId: 'pdl-draft', targetId: 'clowder', report: { title: 'Draft', body: 'First', attachments: [] } };
  const request = { request: { method: 'POST', path: 'feedback/panel', body: { input } } };
  const action = activation.actions['feedback.panel'];
  const first = await action(request, undefined, f.ctx);
  const decode = async (body: string | AsyncIterable<Uint8Array | string>) =>
    JSON.parse(typeof body === 'string' ? body : Buffer.concat((await Array.fromAsync(body)).map(chunk => Buffer.from(chunk))).toString());
  assert.equal(first.status, 200);
  assert.equal((await decode(first.body)).result.journal.report.body, 'First');

  const conflict = await action(request, undefined, f.ctx);
  assert.equal(conflict.status, 200);
  assert.equal((await decode(conflict.body)).code, 'revision_conflict');
  await assert.rejects(action(request, undefined, { ...f.ctx, pluginInstanceId: 'other' }), /通过左栏反馈入口/);

  const legacy = await action({ request: { ...request.request, body: input } }, undefined, f.ctx);
  assert.equal(legacy.status, 400);
  assert.equal((await decode(legacy.body)).code, 'revision_conflict');
});
