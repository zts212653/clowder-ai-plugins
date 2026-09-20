import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createInteraction } from '../preview/interaction.mjs';

test('resting and passing the pointer leave only the cat; only a deliberate tap opens actions', () => {
  const pet = createInteraction();
  assert.equal(pet.state.panel, 'none');
  pet.dispatch({ type: 'pointer-leave' });
  assert.equal(pet.state.panel, 'none');
  pet.dispatch({ type: 'tap' });
  assert.equal(pet.state.panel, 'actions');
  assert.equal(pet.state.call, 'idle');
  pet.dispatch({ type: 'pointer-leave' });
  assert.equal(pet.state.panel, 'actions', 'crossing the gap to an action must not dismiss it');
});
test('two body taps and dragging never grant a simulated microphone', () => {
  const pet = createInteraction();
  pet.dispatch({ type: 'tap' }); pet.dispatch({ type: 'tap' });
  pet.dispatch({ type: 'drag' });
  assert.equal(pet.state.call, 'idle');
  assert.equal(pet.state.panel, 'none');
});
test('dismiss preserves draft and call; stop removes both call and sharing indicators', () => {
  const pet = createInteraction();
  pet.dispatch({ type: 'begin' }); pet.dispatch({ type: 'connected' });
  pet.dispatch({ type: 'share' }); pet.dispatch({ type: 'write' });
  pet.dispatch({ type: 'draft', text: '雨后一起看新芽 831' });
  pet.dispatch({ type: 'dismiss' });
  assert.equal(pet.state.call, 'talking');
  assert.equal(pet.state.sharing, true);
  pet.dispatch({ type: 'write' });
  assert.equal(pet.state.draft, '雨后一起看新芽 831');
  pet.dispatch({ type: 'stop' });
  assert.equal(pet.state.call, 'idle'); assert.equal(pet.state.sharing, false);
  assert.equal(pet.state.panel, 'none');
});
test('typing works without opening a voice session and remains available after panel dismissal', () => {
  const pet = createInteraction(); pet.dispatch({ type: 'write' });
  pet.dispatch({ type: 'draft', text: '  桌边月光 sentinel 913  ' }); pet.dispatch({ type: 'send' });
  assert.deepEqual(pet.state.messages, [{ role: 'user', text: '桌边月光 sentinel 913' }]);
  assert.equal(pet.state.call, 'idle'); assert.equal(pet.state.draft, '');
  pet.dispatch({ type: 'dismiss' }); pet.dispatch({ type: 'history' });
  assert.equal(pet.state.panel, 'chat'); assert.equal(pet.state.messages.length, 1);
});
test('a late connection callback cannot revive a stopped or hidden cat', () => {
  const pet = createInteraction(); pet.dispatch({ type: 'begin' }); pet.dispatch({ type: 'stop' });
  pet.dispatch({ type: 'connected' }); assert.equal(pet.state.call, 'idle');
  pet.dispatch({ type: 'begin' }); pet.dispatch({ type: 'hide' }); pet.dispatch({ type: 'connected' });
  assert.equal(pet.state.hidden, true); assert.equal(pet.state.call, 'idle');
  pet.dispatch({ type: 'restore' }); assert.equal(pet.state.panel, 'none');
});
test('failure leaves explicit retry but never starts it when the cat is tapped', () => {
  const pet = createInteraction(); pet.dispatch({ type: 'begin' }); pet.dispatch({ type: 'failed' });
  assert.equal(pet.state.call, 'failed'); assert.equal(pet.state.panel, 'actions');
  pet.dispatch({ type: 'dismiss' }); pet.dispatch({ type: 'tap' });
  assert.equal(pet.state.call, 'failed');
  pet.dispatch({ type: 'begin' }); assert.equal(pet.state.call, 'connecting');
});
