import {
  isCatchUp,
  isCursor,
  requireTimestamp,
  type MeetingIntakeCatchUp,
  type MeetingIntakeState,
} from './state-model.js';

export interface RefreshEmptyCatchUpPreviewInput {
  readonly expectedCursor: string | null;
  readonly expectedFromCursor: string | null;
  readonly expectedThroughCursor: string;
  readonly expectedFingerprint: string;
  readonly throughCursor: string;
  readonly detectedAt: number;
}

export function refreshedEmptyCatchUpPreviewState(
  state: MeetingIntakeState,
  input: RefreshEmptyCatchUpPreviewInput,
): MeetingIntakeState {
  if (!isCursor(input.throughCursor)) throw new TypeError('invalid Feishu catch-up window');
  requireTimestamp(input.detectedAt, 'catch-up detection timestamp');
  const preview = state.catchUp;
  if (
    state.cursor !== input.expectedCursor ||
    preview.status !== 'previewed' ||
    preview.fromCursor !== input.expectedFromCursor ||
    preview.throughCursor !== input.expectedThroughCursor ||
    preview.candidateCount !== 0 ||
    preview.fingerprint !== input.expectedFingerprint
  ) {
    throw new Error('Feishu catch-up preview changed');
  }
  const catchUp: MeetingIntakeCatchUp = {
    status: 'needs-owner',
    fromCursor: preview.fromCursor,
    throughCursor: input.throughCursor,
    detectedAt: input.detectedAt,
  };
  if (!isCatchUp(catchUp)) throw new TypeError('invalid Feishu catch-up state');
  return {
    ...state,
    catchUp,
    health: { ...state.health, status: 'degraded', code: 'CATCH_UP_REQUIRED' },
  };
}
