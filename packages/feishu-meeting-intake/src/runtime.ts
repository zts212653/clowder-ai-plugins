import type { EventsPublisher } from '@clowder-ai/plugin-sdk';

import { normalizeGeneratedArtifact } from './artifact.js';
import {
  FeishuGatewayError,
  type FeishuArtifactLocator,
  type FeishuPollingGateway,
  type FeishuGeneratedArtifactPage,
} from './gateway.js';
import type { MeetingIntakeStateStore } from './state-store.js';

const PAGE_LIMIT = 64;

export interface FeishuMeetingIntakeRuntimeOptions {
  readonly gateway: FeishuPollingGateway;
  readonly publisher: Pick<EventsPublisher, 'publish'>;
  readonly store: MeetingIntakeStateStore;
}

export interface FeishuMeetingIntakeCycleResult {
  readonly discovered: number;
  readonly published: number;
}

export interface FeishuMeetingIntakeRuntime {
  pollOnce(signal: AbortSignal): Promise<FeishuMeetingIntakeCycleResult>;
  importArtifact(
    locator: FeishuArtifactLocator,
    signal: AbortSignal,
  ): Promise<FeishuMeetingIntakeCycleResult>;
}

function requireLocator(locator: FeishuArtifactLocator): FeishuArtifactLocator {
  const normalized = normalizeGeneratedArtifact({
    ...locator,
    revision: locator.revision ?? 'latest',
    generatedAt: '2000-01-01T00:00:00Z',
  });
  const payload = normalized.payload;
  return {
    artifactId: String(payload.artifactId),
    kind: payload.artifactKind as FeishuArtifactLocator['kind'],
    ...(locator.revision === undefined ? {} : { revision: String(payload.revision) }),
  };
}

function requirePage(value: FeishuGeneratedArtifactPage): FeishuGeneratedArtifactPage {
  if (
    typeof value !== 'object' ||
    value === null ||
    !Array.isArray(value.artifacts) ||
    value.artifacts.length > PAGE_LIMIT ||
    !(
      value.nextCursor === null ||
      (typeof value.nextCursor === 'string' &&
        value.nextCursor.length >= 1 &&
        value.nextCursor.length <= 512)
    )
  ) {
    throw new TypeError('Feishu generated-artifact page is invalid');
  }
  return value;
}

export function createFeishuMeetingIntakeRuntime(
  options: FeishuMeetingIntakeRuntimeOptions,
): FeishuMeetingIntakeRuntime {
  let operations: Promise<void> = Promise.resolve();

  function serialized<T>(operation: () => Promise<T>): Promise<T> {
    const result = operations.then(operation, operation);
    operations = result.then(() => undefined, () => undefined);
    return result;
  }

  async function flush(): Promise<number> {
    let published = 0;
    while (true) {
      const event = (await options.store.load()).pending[0];
      if (event === undefined) return published;
      try {
        await options.publisher.publish(event);
      } catch (error) {
        await options.store.setHealth({ status: 'degraded', code: 'PUBLISH_FAILED' });
        throw error;
      }
      await options.store.acknowledge(event.idempotencyKey);
      published += 1;
    }
  }

  async function recordGatewayFailure(error: unknown): Promise<void> {
    if (error instanceof FeishuGatewayError && error.code === 'AUTH_EXPIRED') {
      await options.store.setHealth({ status: 'auth-expired', code: error.code });
    } else {
      await options.store.setHealth({
        status: 'degraded',
        code: error instanceof FeishuGatewayError ? error.code : 'SOURCE_FAILED',
      });
    }
  }

  return {
    pollOnce(signal): Promise<FeishuMeetingIntakeCycleResult> {
      return serialized(async () => {
        let published = await flush();
        const before = await options.store.load();
        let page: FeishuGeneratedArtifactPage;
        try {
          page = requirePage(await options.gateway.listGeneratedArtifacts({
            cursor: before.cursor,
            limit: PAGE_LIMIT,
            signal,
          }));
        } catch (error) {
          await recordGatewayFailure(error);
          throw error;
        }

        let events;
        try {
          events = page.artifacts.map(normalizeGeneratedArtifact);
        } catch (error) {
          await options.store.setHealth({ status: 'degraded', code: 'SOURCE_INVALID' });
          throw error;
        }
        await options.store.commitPage(before.cursor, page.nextCursor, events);
        published += await flush();
        await options.store.setHealth({ status: 'ready' });
        return { discovered: events.length, published };
      });
    },

    importArtifact(locator, signal): Promise<FeishuMeetingIntakeCycleResult> {
      return serialized(async () => {
        const safeLocator = requireLocator(locator);
        let descriptor: unknown;
        try {
          descriptor = await options.gateway.inspectArtifact(safeLocator, signal);
        } catch (error) {
          await recordGatewayFailure(error);
          throw error;
        }
        const event = normalizeGeneratedArtifact(descriptor);
        await options.store.enqueue([event]);
        const published = await flush();
        await options.store.setHealth({ status: 'ready' });
        return { discovered: 1, published };
      });
    },
  };
}
