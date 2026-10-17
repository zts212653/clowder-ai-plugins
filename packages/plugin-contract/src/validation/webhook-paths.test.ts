import assert from 'node:assert/strict';
import test from 'node:test';
import { validateManifest } from './manifest.js';

function fixture(routes: { path: string; methods: string[] }[]) {
  return { pluginId: 'dev.clowder.http-fixture', version: '1.0.0', contractVersion: '0.1.0-beta.33', name: 'HTTP fixture',
    runtime: { transport: 'builtin', entrypoint: 'dist/index.js' },
    contributions: routes.map((route, index) => ({ type: 'webhook', id: `route-${index}`, ...route, action: { method: `http.${index}` } })),
    features: [{ id: 'http', name: 'HTTP', resources: [], capabilities: [], contributions: routes.map((_, index) => ({ type: 'webhook', id: `route-${index}` })) }],
  };
}

test('static webhook fixture is otherwise valid', () => {
  assert.equal(validateManifest(fixture([{ path: 'github/events', methods: ['POST'] }])).valid, true);
});

test('webhooks accept PATCH and named single segments under a static namespace', () => {
  for (const route of [{ path: 'github/items/:id', methods: ['GET', 'PATCH'] }, { path: 'github/repositories/:repo/items/:item_id', methods: ['DELETE'] }]) {
    const result = validateManifest(fixture([route]));
    assert.equal(result.valid, true, JSON.stringify(result.errors));
  }
});

test('webhooks reject reserved namespaces and invalid or duplicate parameter declarations', () => {
  for (const path of ['config', 'test/child', 'enable/:id', 'disable', 'actions/:id', 'operations/:id', ':root/items', '/github/items',
    'github//items', 'github/:id?', 'github/*', 'github/:', 'github/:1id', 'github/pre:id', 'github/:id/:id', 'github/%3Aid', 'github/../items', 'github/items?x=y']) {
    assert.equal(validateManifest(fixture([{ path, methods: ['GET'] }])).valid, false, path);
  }
});

test('overlapping webhook templates with common methods are rejected but disjoint methods are legal', () => {
  for (const paths of [['github/items/:id', 'github/items/:name'], ['github/items/:id', 'github/items/latest'], ['github/:repo/items', 'github/repo/:kind'], ['github/items', 'github/items']]) {
    assert.equal(validateManifest(fixture(paths.map(path => ({ path, methods: ['GET'] })))).valid, false, paths.join(' vs '));
  }
  assert.equal(validateManifest(fixture([{ path: 'github/items/:id', methods: ['GET'] }, { path: 'github/items/:name', methods: ['PATCH'] }])).valid, true);
  assert.equal(validateManifest(fixture([{ path: 'github/items/:id', methods: ['GET'] }, { path: 'github/items/:id/comments', methods: ['GET'] }])).valid, true);
});
