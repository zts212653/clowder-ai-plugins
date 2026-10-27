import type { MusicInput } from './types.js';

export const MUSIC_PRICE_SOURCE = 'https://cloud.google.com/vertex-ai/generative-ai/pricing';
export const musicEstimate = (input: MusicInput) => input.model === 'lyria-3-pro-preview' ? 0.08 : 0.04;
export function musicProvenance(input: {
  operationId: string; music: MusicInput; timestamp: string; project: string; estimatedUsd: number;
  bytes: number; sha256: string; responseId?: string; modelVersion?: string; recovered?: boolean;
}) {
  return {
    schemaVersion: 1 as const, provider: 'google-cloud-vertex-ai' as const, operationId: input.operationId,
    model: input.music.model, prompt: input.music.prompt,
    requested: { instrumental: input.music.instrumental,
      ...(input.music.durationSeconds === undefined ? {} : { durationSeconds: input.music.durationSeconds }),
      ...(input.music.bpm === undefined ? {} : { bpm: input.music.bpm }) },
    timestamp: input.timestamp, requestCount: 1 as const, status: 'succeeded' as const,
    authentication: { type: 'oauth' as const, source: 'plugin-manager' as const, quotaProjectId: input.project },
    cost: { estimatedUsd: input.estimatedUsd, actualChargedUsd: null, creditDeductionVerified: false as const, sourceUrl: MUSIC_PRICE_SOURCE },
    audio: { mimeType: 'audio/mpeg' as const, bytes: input.bytes, sha256: input.sha256 },
    ...(input.responseId === undefined ? {} : { providerResponseId: input.responseId }),
    ...(input.modelVersion === undefined ? {} : { modelVersion: input.modelVersion }),
    ...(input.recovered ? { recoveredFromRetainedAudio: true as const } : {}),
  };
}
