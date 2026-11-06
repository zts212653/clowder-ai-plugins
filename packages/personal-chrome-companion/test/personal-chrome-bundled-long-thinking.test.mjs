import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import { fixture } from './helpers/long-thinking-fixture.mjs';

it('the actually bundled content script retains its exact helper context for a 31-minute answer', async (context) => {
  const f = fixture({ modern: true });
  const listeners = [], observed = [];
  const chrome = {
    runtime: {
      onMessage: { addListener: (listener) => listeners.push(listener), removeListener() {} },
      sendMessage: async (message) => { observed.push(message); return { accepted: true }; },
    },
  };
  const source = await readFile(new URL('../extension/content-script.js', import.meta.url), 'utf8');
  context.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    runInNewContext(source, { chrome, document: f.document, location: f.dom.window.location, MutationObserver: f.dom.window.MutationObserver, setTimeout, clearTimeout, TextEncoder, URL });
    const receipt = await new Promise((resolve) => listeners[0]({
      v: 2, kind: 'append_message_v2', requestId: 'bundle-long-request', conversationId: 'conversation-7', text: 'sanitized long source', idempotencyKey: 'bundle-source',
      expectedRevisions: { helper: `sha512:${'0'.repeat(128)}`, extension: '0.2.13', pageAdapter: '2026-11-06.1' },
    }, {}, resolve));
    assert.equal(receipt.status, 'host_observed');
    context.mock.timers.tick(31 * 60_000);
    await Promise.resolve(); await Promise.resolve();
    assert(!observed.some((message) => message.kind === 'assistant_observation_failed'));
    const turn = f.document.createElement('article');
    turn.dataset.testid = 'conversation-turn-late-answer';
    const answer = f.document.createElement('div');
    answer.dataset.messageAuthorRole = 'assistant';
    answer.textContent = 'actual bundled late answer';
    turn.append(answer);
    f.document.querySelector('main').append(turn);
    await Promise.resolve();
    context.mock.timers.tick(751);
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    const final = observed.find((message) => message.kind === 'assistant_final_observed');
    assert(final, 'late answer must survive the content-script helper context retention');
    assert.equal(final.idempotencyKey, 'bundle-source');
    assert.equal(final.content, 'actual bundled late answer');
    assert.equal(f.sends, 1);
  } finally { context.mock.timers.reset(); f.dom.window.close(); }
});
