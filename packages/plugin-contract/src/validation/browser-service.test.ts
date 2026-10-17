import assert from 'node:assert/strict';
import test from 'node:test';
import { validateManifest } from './manifest.js';
const contribution = { type: 'browser-service', id: 'api', action: { method: 'api.http' },
  routes: [{ method: 'GET', path: '/api/meta', browser: 'service', local: 'omit-origin' }], credentials: { bearer: true, cookies: [] } };
const manifest = { pluginId: 'example.browser-service', name: 'Browser', version: '1.0.0', contractVersion: '0.1.0',
  features: [{ id: 'main', name: 'Main', resources: [], capabilities: [], contributions: [{ type: 'browser-service', id: 'api' }] }],
  runtime: { transport: 'builtin', entrypoint: 'dist/index.js' }, contributions: [contribution] };
test('admits the exact scoped browser-service declaration', () => assert.equal(validateManifest(manifest).valid, true));
for (const path of ['/api//meta', '/api/../meta', '/api/%2fmeta', '/api/%2emeta', '/api/meta?x', '/api/\\meta'])
  test(`rejects ambiguous literal route ${path}`, () => assert.equal(validateManifest({ ...manifest, contributions: [{ ...contribution,
    routes: [{ method: 'GET', path, browser: 'service' }] }] }).valid, false));
test('rejects duplicate route and lane-less route', () => {
  assert.equal(validateManifest({ ...manifest, contributions: [{ ...contribution, routes: [...contribution.routes, ...contribution.routes] }] }).valid, false);
  assert.equal(validateManifest({ ...manifest, contributions: [{ ...contribution, routes: [{ method: 'GET', path: '/api/meta' }] }] }).valid, false);
});
test('private HTTP action cannot double as a Manager action', () => assert.equal(validateManifest({ ...manifest,
  configuration: [{ key: 'control', label: 'Control', kind: 'operation', actions: [{ id: 'go', label: 'Go', render: 'button', action: { method: 'api.http' } }] }] }).valid, false));
