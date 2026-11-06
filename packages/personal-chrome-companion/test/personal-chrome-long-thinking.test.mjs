import assert from 'node:assert/strict';
import { it } from 'node:test';
import { fixture } from './helpers/long-thinking-fixture.mjs';
import { createChatGptPageAdapter } from '../extension/chatgpt-page-adapter.mjs';
import { safeAdapterDiagnostic } from '../native-host/native-results.mjs';

const request = { requestId: 'long-request', conversationId: 'conversation-7', text: 'sanitized long-thinking source', idempotencyKey: 'source-long' };

it('recognizes the actual user-bubble marker while requiring a stable provider turn ID', async () => {
  const f = fixture({ modern: true });
  try {
    const adapter = createChatGptPageAdapter({ document: f.document, location: f.dom.window.location, MutationObserver: f.dom.window.MutationObserver, observationTimeoutMs: 20 });
    const receipt = await adapter.appendMessage(request);
    assert.equal(receipt.hostMessageId, 'conversation-turn-user-1');
    assert.equal(f.sends, 1);
  } finally { f.dom.window.close(); }
});

it('reports post-submit uncertainty without inventing an ID or sending again', async () => {
  const f = fixture({ modern: true, stableId: false });
  try {
    const adapter = createChatGptPageAdapter({ document: f.document, location: f.dom.window.location, MutationObserver: f.dom.window.MutationObserver, observationTimeoutMs: 20 });
    await assert.rejects(adapter.appendMessage(request), (error) => {
      assert.equal(error.code, 'HOST_MESSAGE_NOT_OBSERVED');
      assert.equal(error.diagnostic?.fingerprint.phase, 'submitted_waiting_receipt');
      assert.equal(safeAdapterDiagnostic(error.diagnostic)?.fingerprint.phase, 'submitted_waiting_receipt');
      return true;
    });
    assert.equal(f.sends, 1);
  } finally { f.dom.window.close(); }
});

it('does not attribute an answer after another modern user bubble to the old source', async () => {
  const f = fixture({ modern: true });
  const returns = [], failures = [];
  try {
    const adapter = createChatGptPageAdapter({ document: f.document, location: f.dom.window.location, MutationObserver: f.dom.window.MutationObserver, onAssistantFinal: (value) => returns.push(value), onAssistantObservationFailure: (value) => failures.push(value) });
    await adapter.appendMessage(request);
    const other = f.document.createElement('article');
    other.innerHTML = '<div data-user-message-bubble="true">another actual user turn</div>';
    f.document.querySelector('main').append(other);
    const later = f.document.createElement('article');
    later.dataset.testid = 'conversation-turn-other-answer';
    later.innerHTML = '<div data-message-author-role="assistant">must not return for the old source</div>';
    f.document.querySelector('main').append(later);
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    assert.equal(returns.length, 0);
    assert.equal(failures.length, 1);
  } finally { f.dom.window.close(); }
});

it('accepts the causal answer after 31 minutes without changing delivery or resending', async (context) => {
  const f = fixture();
  const failures = [], returns = [];
  context.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const adapter = createChatGptPageAdapter({ document: f.document, location: f.dom.window.location, MutationObserver: f.dom.window.MutationObserver, onAssistantFinal: (value) => returns.push(value), onAssistantObservationFailure: (value) => failures.push(value) });
    const receipt = await adapter.appendMessage(request);
    assert.equal(receipt.hostMessageId, 'conversation-turn-user-1');
    context.mock.timers.tick(31 * 60_000);
    await Promise.resolve(); await Promise.resolve();
    assert.deepEqual(failures, [], 'model thinking time cannot expire after two minutes');
    const turn = f.document.createElement('article');
    turn.dataset.testid = 'conversation-turn-assistant-2';
    const answer = f.document.createElement('div');
    answer.dataset.messageAuthorRole = 'assistant';
    answer.textContent = 'late exact answer';
    turn.append(answer);
    f.document.querySelector('main').append(turn);
    await Promise.resolve();
    context.mock.timers.tick(751);
    await Promise.resolve(); await Promise.resolve();
    assert.equal(returns.length, 1);
    assert.equal(returns[0].idempotencyKey, request.idempotencyKey);
    assert.equal(returns[0].content, 'late exact answer');
    assert.equal(f.sends, 1);
  } finally { context.mock.timers.reset(); f.dom.window.close(); }
});
