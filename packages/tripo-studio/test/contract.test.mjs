import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseModelPage,
  validateAssetUrl,
  validateObservation,
} from '../plugins/tripo-studio/runtime/contract.mjs';

const page = 'https://studio.tripo3d.ai/3d-model/train-11111111-1111-4111-8111-111111111111';
const asset = 'https://tripo-data-public.rg1.data.tripo3d.com/models/train.glb?signature=private';
test('binds a model to its exact Studio source; accepts only narrow HTTPS asset hosts', () => {
  assert.equal(parseModelPage(page).modelId, '11111111-1111-4111-8111-111111111111');
  assert.equal(validateAssetUrl(asset), asset);
  for (const url of [
    'http://127.0.0.1/a.glb',
    'https://evil.com/a.glb',
    'https://studio.tripo3d.ai@evil.com/a.glb',
    'https://tripo3d.ai.evil.com/a.glb',
    'file:///a.glb',
    'https://user:pass@tripo-data-public.rg1.data.tripo3d.com/a.glb',
  ]) {
    assert.throws(() => validateAssetUrl(url));
  }
  assert.throws(() => parseModelPage('https://studio.tripo3d.ai/generate'));
});
test('rejects switched pages, oversized results, unbound candidate IDs and missing focus evidence', () => {
  const state = { focusedWindowId: 7, activeTabs: [{ windowId: 7, tabId: 2 }] };
  const observation = {
    v: 1,
    pageUrl: page,
    title: 'Train',
    resources: [asset],
    before: state,
    after: state,
    observedAt: new Date().toISOString(),
  };
  assert.equal(validateObservation(observation, page).modelId, parseModelPage(page).modelId);
  assert.throws(() => validateObservation(observation, page.replace('train-', 'other-')));
  assert.throws(() => validateObservation({ ...observation, resources: Array(257).fill(asset) }, page));
  assert.throws(() => validateObservation({ ...observation, after: { ...state, focusedWindowId: 8 } }, page));
  assert.throws(() => validateObservation({ ...observation, before: null }, page));
});
