import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isWorkspaceUrl,
  validateWorkspaceRequest,
} from '../plugins/tripo-studio/runtime/workspace-contract.mjs';

test('workspace bridge exposes a bounded operation set, never caller scripts or arbitrary URLs', () => {
  assert.equal(
    isWorkspaceUrl('https://studio.tripo3d.ai/workspace/generate'),
    true,
  );
  for (const url of [
    'https://studio.tripo3d.ai.evil.example/workspace/generate',
    'https://user:pass@studio.tripo3d.ai/workspace/generate',
    'http://studio.tripo3d.ai/workspace/generate',
    'https://studio.tripo3d.ai/3d-model/test',
  ])
    assert.equal(isWorkspaceUrl(url), false);
  for (const value of [
    { kind: 'evaluate', code: 'alert(1)' },
    { kind: 'inspect', url: 'http://localhost' },
    { kind: 'configure', mode: 'Smart Mesh', views: 4, privacy: 'Default' },
    { kind: 'upload', data: 'x'.repeat(1024 * 1024) },
  ])
    assert.throws(() => validateWorkspaceRequest(value));
  assert.equal(
    validateWorkspaceRequest({
      kind: 'configure',
      mode: 'Smart Mesh',
      views: 4,
      privacy: 'Private',
      topology: 'Triangle',
      polycount: 5000,
    }).privacy,
    'Private',
  );
});
