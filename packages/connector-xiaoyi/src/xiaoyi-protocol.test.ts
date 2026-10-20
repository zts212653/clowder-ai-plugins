import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';

import {
  agentResponse,
  artifactUpdate,
  envelope,
  generateXiaoyiSignature,
  statusUpdate,
} from './xiaoyi-protocol.js';

test('signature is the provider HMAC over timestamp only', () => {
  const expected = createHmac('sha256', 'secret').update('1234567890').digest('base64');
  assert.equal(generateXiaoyiSignature('secret', '1234567890'), expected);
});

test('provider envelopes preserve the A2A finality contract', () => {
  assert.deepEqual(JSON.parse(envelope('agent-1', 'heartbeat')), {
    msgType: 'heartbeat',
    agentId: 'agent-1',
  });
  const artifact = artifactUpdate('task-1', 'artifact-1', 'hello', {
    append: false,
    lastChunk: true,
  }) as Record<string, any>;
  assert.equal(artifact.result.kind, 'artifact-update');
  assert.equal(artifact.result.final, false);
  assert.equal(artifact.result.artifact.parts[0].text, 'hello');

  const working = statusUpdate('task-1', 'working') as Record<string, any>;
  const completed = statusUpdate('task-1', 'completed') as Record<string, any>;
  assert.equal(working.result.final, false);
  assert.equal(completed.result.final, true);

  const response = JSON.parse(agentResponse('agent-1', 'session-1', 'task-1', completed));
  assert.equal(response.taskId, 'task-1');
  assert.deepEqual(JSON.parse(response.msgDetail), completed);
});
