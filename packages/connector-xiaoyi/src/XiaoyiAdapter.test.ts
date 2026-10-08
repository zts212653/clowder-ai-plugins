import assert from 'node:assert/strict';
import test from 'node:test';

import { XiaoyiAdapter } from './XiaoyiAdapter.js';
import type { ConnectorLogger } from './types.js';

const noop = () => undefined;
const logger: ConnectorLogger = { info: noop, warn: noop, error: noop, debug: noop };

function inbound(taskId: string, sessionId: string, text: string, agentId = 'agent-1'): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    method: 'message/stream',
    agentId,
    params: {
      id: taskId,
      sessionId,
      message: { role: 'user', parts: [{ kind: 'text', text }] },
    },
  });
}

interface AdapterInternals {
  ws: { send(source: string, payload: string): void };
  onMsg: ((message: { chatId: string; text: string; messageId: string; senderId: string }) => Promise<void>) | null;
  handleInbound(raw: string, source: string): void;
}

function internals(adapter: XiaoyiAdapter): AdapterInternals {
  return adapter as unknown as AdapterInternals;
}

function detail(frame: string): Record<string, any> {
  return JSON.parse(JSON.parse(frame).msgDetail) as Record<string, any>;
}

test('inbound task uses Host-routable external identity and closes only after delivery settles', async t => {
  const subject = new XiaoyiAdapter(logger, { agentId: 'agent-1', ak: 'access', sk: 'secret' });
  t.after(() => subject.stopStream());
  const state = internals(subject);
  const sent: string[] = [];
  const received: Array<{
    chatId: string;
    text: string;
    messageId: string;
    taskId?: string;
    senderId: string;
  }> = [];
  state.ws.send = (_source, payload) => sent.push(payload);
  state.onMsg = async message => {
    received.push(message);
  };

  state.handleInbound(inbound('task-1', 'session-1', 'hello'), 'primary');
  assert.deepEqual(received, [{
    chatId: 'agent-1:session-1',
    text: 'hello',
    messageId: 'task-1',
    taskId: 'task-1',
    senderId: 'owner:agent-1',
  }]);

  await subject.sendReply('agent-1:session-1', 'answer');
  const artifact = detail(sent[0] ?? '');
  assert.equal(artifact.result.kind, 'artifact-update');
  assert.equal(artifact.result.append, false);
  assert.equal(artifact.result.final, false);

  sent.length = 0;
  await subject.onDeliveryBatchDone('agent-1:session-1', true);
  const close = detail(sent[0] ?? '');
  assert.equal(close.result.kind, 'status-update');
  assert.equal(close.result.status.state, 'completed');
  assert.equal(close.result.final, true);
});

test('duplicate tasks and frames for another agent never dispatch twice', async t => {
  const subject = new XiaoyiAdapter(logger, { agentId: 'agent-1', ak: 'access', sk: 'secret' });
  t.after(() => subject.stopStream());
  const state = internals(subject);
  state.ws.send = () => undefined;
  const received: string[] = [];
  state.onMsg = async message => {
    received.push(message.messageId);
  };

  state.handleInbound(inbound('task-1', 'session-1', 'first'), 'primary');
  state.handleInbound(inbound('task-1', 'session-1', 'duplicate'), 'backup');
  state.handleInbound(inbound('task-2', 'session-2', 'wrong', 'other-agent'), 'primary');
  assert.deepEqual(received, ['task-1']);
});

test('append accumulation preserves provider task ordering without streaming deltas', async t => {
  const subject = new XiaoyiAdapter(logger, { agentId: 'agent-1', ak: 'access', sk: 'secret' });
  t.after(() => subject.stopStream());
  const state = internals(subject);
  const sent: string[] = [];
  state.ws.send = (_source, payload) => sent.push(payload);
  state.onMsg = async () => undefined;
  state.handleInbound(inbound('task-1', 'session-1', 'go'), 'primary');

  await subject.sendReply('agent-1:session-1', 'Cat A');
  await subject.sendReply('agent-1:session-1', 'Cat B');
  const artifacts = sent.map(detail);
  assert.equal(artifacts[0]?.result.append, false);
  assert.equal(artifacts[0]?.result.artifact.parts[0].text, 'Cat A');
  assert.equal(artifacts[1]?.result.append, true);
  assert.equal(artifacts[1]?.result.artifact.parts[0].text, '\n\n---\n\nCat B');
  assert.notEqual(artifacts[0]?.result.artifact.artifactId, artifacts[1]?.result.artifact.artifactId);
});
