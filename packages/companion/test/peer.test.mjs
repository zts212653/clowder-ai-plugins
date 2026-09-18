import assert from 'node:assert/strict';
import { test } from 'node:test';
import { VoicePeer } from '../src/peer.mjs';

test('surface audio requests carry no SDP or media object and only consume Host events', async () => {
  const calls = [], events = [];
  let receive;
  const client = {
    subscribe: cb => { receive = cb; return () => calls.push('unsubscribe'); },
    connectAudio: async () => calls.push('connect'), closeAudio: async () => calls.push('close'),
    muteMicrophone: async muted => calls.push(['microphone', muted]),
    muteSpeaker: async muted => calls.push(['speaker', muted]),
  };
  const peer = new VoicePeer(event => events.push(event), client);
  peer.muteMic(true); peer.muteSpeaker(true); await peer.connect();
  receive({ kind: 'audio', type: 'connected' });
  receive({ kind: 'audio', type: 'transcript', role: 'assistant', text: 'A real source' });
  await peer.close(); receive({ kind: 'audio', type: 'connected' });
  assert.deepEqual(calls, [['microphone', true], ['speaker', true], 'connect', 'unsubscribe', 'close']);
  assert.equal(events.length, 2); assert.equal(events[1].text, 'A real source');
  assert.equal('pc' in peer, false); assert.equal('channel' in peer, false);
});
test('Host audio failure remains visible and closing prevents another attempt', async () => {
  let attempts = 0;
  const peer = new VoicePeer(() => {}, {
    subscribe: () => () => {}, connectAudio: async () => { attempts++; throw new Error('denied'); }, closeAudio: async () => {},
  });
  await assert.rejects(peer.connect()); await peer.close(); await peer.connect();
  assert.equal(attempts, 1);
});
