import { createHash } from 'node:crypto';

import type { EventsPublishInput } from '@clowder-ai/plugin-contract';

import { normalizeGeneratedArtifact } from './artifact.js';
import { FeishuCatchUpRequiredError, type FeishuCatchUpScanner } from './gateway.js';
import type { MeetingIntakeState, MeetingIntakeStateStore } from './state-store.js';

export interface FeishuMeetingCatchUpPreview {
  readonly fromCursor: string | null;
  readonly throughCursor: string;
  readonly candidateCount: number;
  readonly fingerprint: string;
}

export interface FeishuMeetingCatchUpService {
  preview(signal: AbortSignal): Promise<FeishuMeetingCatchUpPreview>;
  futureOnly(fingerprint: string): Promise<{ readonly action: 'future-only'; readonly candidateCount: number }>;
  replay(
    fingerprint: string,
    signal: AbortSignal,
  ): Promise<{ readonly action: 'replay'; readonly candidateCount: number }>;
}

export interface FeishuMeetingCatchUpServiceOptions {
  readonly scanner: FeishuCatchUpScanner;
  readonly store: MeetingIntakeStateStore;
  readonly now?: () => number;
}

function decisionWindow(state: MeetingIntakeState) {
  if (state.catchUp.status !== 'needs-owner' && state.catchUp.status !== 'previewed') {
    throw new Error('Feishu catch-up does not have a previewable owner decision window');
  }
  return state.catchUp;
}

function fingerprint(events: readonly EventsPublishInput[]): string {
  return createHash('sha256').update(JSON.stringify(events)).digest('hex');
}

export function createFeishuMeetingCatchUpService(
  options: FeishuMeetingCatchUpServiceOptions,
): FeishuMeetingCatchUpService {
  const now = options.now ?? Date.now;

  async function scan(signal: AbortSignal): Promise<{
    readonly state: MeetingIntakeState;
    readonly events: EventsPublishInput[];
    readonly fingerprint: string;
  }> {
    const state = await options.store.load();
    const window = decisionWindow(state);
    try {
      const page = await options.scanner.scanGeneratedArtifacts({
        fromCursor: window.fromCursor,
        throughCursor: window.throughCursor,
        signal,
      });
      if (page.nextCursor !== window.throughCursor) {
        throw new Error('Feishu catch-up scanner changed the frozen boundary');
      }
      const events = page.artifacts.map(normalizeGeneratedArtifact);
      return { state, events, fingerprint: fingerprint(events) };
    } catch (error) {
      if (error instanceof FeishuCatchUpRequiredError && error.reason !== 'CURSOR_GAP') {
        await options.store.requireCatchUp({
          fromCursor: error.fromCursor,
          throughCursor: error.throughCursor,
          reason: error.reason,
          ...(error.candidateCountAtLeast === undefined
            ? {} : { candidateCountAtLeast: error.candidateCountAtLeast }),
          detectedAt: now(),
        });
      }
      throw error;
    }
  }

  return {
    async preview(signal) {
      const scanned = await scan(signal);
      const window = decisionWindow(scanned.state);
      await options.store.recordCatchUpPreview({
        candidateCount: scanned.events.length,
        fingerprint: scanned.fingerprint,
        previewedAt: now(),
      });
      return {
        fromCursor: window.fromCursor,
        throughCursor: window.throughCursor,
        candidateCount: scanned.events.length,
        fingerprint: scanned.fingerprint,
      };
    },

    async futureOnly(expectedFingerprint) {
      const state = await options.store.load();
      if (state.catchUp.status !== 'previewed') {
        throw new Error('Feishu catch-up has not been previewed');
      }
      const candidateCount = state.catchUp.candidateCount;
      await options.store.resolveCatchUpFutureOnly(expectedFingerprint, now());
      return { action: 'future-only', candidateCount };
    },

    async replay(expectedFingerprint, signal) {
      const scanned = await scan(signal);
      if (scanned.fingerprint !== expectedFingerprint) {
        throw new Error('Feishu catch-up preview changed');
      }
      await options.store.resolveCatchUpReplay(expectedFingerprint, scanned.events, now());
      return { action: 'replay', candidateCount: scanned.events.length };
    },
  };
}
