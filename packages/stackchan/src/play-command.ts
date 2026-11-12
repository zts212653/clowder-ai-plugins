import type { StackChanAdapterConfig } from './runtime-config.js';
import { readSecretFile } from './secret-file.js';
import { parseStackChanPlayScene } from './play-controller.js';

/** Local owner command: uses the paired adapter so play shares its physical activity slot. */
export async function requestStackChanPlay(
  config: Pick<StackChanAdapterConfig, 'apiKeyPath' | 'limbEndpointUrl'>,
  scene: string | undefined,
): Promise<unknown> {
  if (scene !== 'status') parseStackChanPlayScene({ scene });
  const apiKey = await readSecretFile(config.apiKeyPath, { required: true });
  const response = await fetch(`${config.limbEndpointUrl}/${scene === 'status' ? 'health' : 'play'}`, {
    method: scene === 'status' ? 'GET' : 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
    },
    ...(scene === 'status' ? {} : { body: JSON.stringify({ scene }) }),
    signal: AbortSignal.timeout(60_000),
  });
  const result: unknown = await response.json();
  if (!response.ok) {
    const reason = typeof result === 'object' && result !== null && 'error' in result
      && typeof result.error === 'string' ? result.error : `HTTP ${response.status}`;
    throw new Error(reason);
  }
  return result;
}
