import assert from 'node:assert/strict';
import test from 'node:test';
import { FoldedChatUnread } from '../src/chat-unread.mjs';

test('chat unread starts only after an opened call chat is folded', () => {
  const changes = [];
  const unread = new FoldedChatUnread(value => changes.push(value));
  unread.receive({ messageId: 'message-1', role: 'assistant' });
  assert.equal(unread.count, 0, 'an unopened chat does not invent an unread baseline');
  unread.open();
  unread.receive({ messageId: 'message-1', role: 'assistant' });
  unread.fold();
  unread.receiveMany([
    { messageId: 'self-voice', role: 'user' },
    { messageId: 'self-typed', role: 'user' },
    { messageId: 'message-2', role: 'assistant' },
    { messageId: 'message-2', role: 'assistant' },
    { messageId: 'message-3', role: 'assistant' },
  ]);
  assert.equal(unread.count, 2, 'stable message identity prevents duplicate polling increments');
  unread.open();
  assert.equal(unread.count, 0);
  assert.deepEqual(changes, [1, 2, 0]);
});

test('ending the call clears the folded-chat boundary', () => {
  const unread = new FoldedChatUnread();
  unread.open(); unread.fold(); unread.receive({ messageId: 'one', role: 'assistant' });
  unread.reset(); unread.receive({ messageId: 'two', role: 'assistant' });
  assert.equal(unread.count, 0);
});
