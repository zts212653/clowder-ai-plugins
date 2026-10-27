import { expect, it } from 'vitest';
import { createConfiguredTranscriber } from './local-transcriber.js';

it('has no implicit speech service and refuses a partial or nonlocal configuration before any audio read', () => {
  expect(createConfiguredTranscriber({ WHISPER_URL: 'http://127.0.0.1:9876' })).toBeUndefined();
  expect(() => createConfiguredTranscriber({ COLLECTIVE_STT_MODEL: 'whisper-small' })).toThrow('both');
  for (const url of [
    'https://speech.example',
    'http://127.0.0.1:3002',
    'http://user:secret@127.0.0.1:9876',
    'http://127.0.0.1:9876/other',
  ])
    expect(() =>
      createConfiguredTranscriber({ COLLECTIVE_STT_URL: url, COLLECTIVE_STT_MODEL: 'whisper-small' }),
    ).toThrow('loopback');
});

it('a canceled model read does not probe the configured endpoint or open the derivative', async () => {
  const controller = new AbortController();
  controller.abort(new Error('Owner read canceled'));
  const transcribe = createConfiguredTranscriber({
    COLLECTIVE_STT_URL: 'http://127.0.0.1:9876',
    COLLECTIVE_STT_MODEL: 'whisper-small',
  });
  await expect(transcribe!({ audioPath: '/deliberately-absent', signal: controller.signal })).rejects.toThrow(
    'canceled',
  );
});
