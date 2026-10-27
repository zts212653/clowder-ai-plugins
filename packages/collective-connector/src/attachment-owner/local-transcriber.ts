import { readFile } from 'node:fs/promises';
import type { CollectiveAudioTranscriber } from './message-model-av.js';

/** Optional existing local ASR, using the same health/model/backend and multipart contract as the Host. */
export function createConfiguredTranscriber(env: NodeJS.ProcessEnv): CollectiveAudioTranscriber | undefined {
  const endpoint = env.COLLECTIVE_STT_URL?.trim(),
    model = env.COLLECTIVE_STT_MODEL?.trim();
  if (!endpoint && !model) return undefined;
  if (!endpoint || !model || model.length > 200)
    throw new Error('Set both COLLECTIVE_STT_URL and COLLECTIVE_STT_MODEL');
  const url = new URL(endpoint);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash ||
    ['3001', '3002'].includes(url.port)
  )
    throw new Error('COLLECTIVE_STT_URL must be a loopback root URL on a non-reserved port');
  if (url.hostname === 'localhost') url.hostname = '127.0.0.1';
  const backend = model.includes('Qwen3-ASR')
    ? 'mlx-audio'
    : model.startsWith('mlx-community/whisper-')
      ? 'mlx-whisper'
      : 'faster-whisper';
  return async (request) => {
    request.signal.throwIfAborted();
    const transport = (path: string, init?: RequestInit) =>
      fetch(new URL(path, url), {
        ...init,
        credentials: 'omit',
        redirect: 'error',
        signal: AbortSignal.any([request.signal, AbortSignal.timeout(path === '/health' ? 3_000 : 18_000)]),
      });
    try {
      const health = await readSmallJson(await transport('/health'), 8 * 1024);
      if (health.status !== 'ok' || health.model !== model || health.backend !== backend) return undefined;
      const bytes = await readFile(request.audioPath);
      request.signal.throwIfAborted();
      const body = new FormData();
      body.append('file', new Blob([bytes], { type: 'audio/wav' }), 'audio.wav');
      body.append('model', model);
      const result = await readSmallJson(
        await transport('/v1/audio/transcriptions', { method: 'POST', body }),
        256 * 1024,
      );
      request.signal.throwIfAborted();
      return typeof result.text === 'string' ? { text: result.text, provider: 'whisper-local' } : undefined;
    } catch {
      request.signal.throwIfAborted();
      return undefined;
    }
  };
}

async function readSmallJson(response: Response, limit: number): Promise<Record<string, unknown>> {
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new Error('Local speech service is unavailable');
  }
  const reader = response.body.getReader(),
    chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) throw new Error('Local speech response exceeds its budget');
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const result: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('Invalid speech response');
  return result as Record<string, unknown>;
}
