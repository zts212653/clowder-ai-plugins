import assert from 'node:assert/strict';
import test from 'node:test';
import { FoldedChatUnread } from '../src/chat-unread.mjs';

test('chat unread starts only after an opened call chat is folded', () => {
  const changes = [];
  const unread = new FoldedChatUnread(value => changes.push(value));
  unread.receive('message-1');
  assert.equal(unread.count, 0, 'an unopened chat does not invent an unread baseline');
  unread.open();
  unread.receive('message-1');
  unread.fold();
  unread.receive('message-2');
  unread.receive('message-2');
  unread.receive('message-3');
  assert.equal(unread.count, 2, 'stable message identity prevents duplicate polling increments');
  unread.open();
  assert.equal(unread.count, 0);
  assert.deepEqual(changes, [1, 2, 0]);
});

test('ending the call clears the folded-chat boundary', () => {
  const unread = new FoldedChatUnread();
  unread.open(); unread.fold(); unread.receive('one');
  unread.reset(); unread.receive('two');
  assert.equal(unread.count, 0);
});
