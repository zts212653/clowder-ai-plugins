import { homedir } from 'node:os';

import {
  FeishuGatewayError,
  type FeishuArtifactLocator,
  type FeishuGeneratedArtifact,
  type FeishuGeneratedArtifactPage,
  type FeishuPollingGateway,
} from './gateway.js';
import {
  normalizeLarkCliGeneratedEvent,
  readLarkCliEventId,
} from './lark-event-normalizer.js';
import {
  LARK_EVENT_KEYS,
  startDefaultLarkCliConsumer,
  type LarkCliEventConsumer,
} from './lark-cli-consumer.js';
import {
  createLarkCliFeishuPollingGateway,
  type LarkCliFeishuPollingGateway,
} from './lark-cli-polling-gateway.js';
import {
  createLarkCliFeishuArtifactInspector,
} from './lark-cli-artifact-inspector.js';
import type { LarkCliReadCommand } from './lark-cli-read-command.js';

const MAX_BUFFERED_EVENTS = 512;
const DEFAULT_SOURCE_READINESS_DEADLINE_MS = 30_000;
const DEFAULT_SOURCE_OBSERVATION_INTERVAL_MS = 30_000;

export interface LarkCliFeishuEventGateway extends FeishuPollingGateway {
  start(): Promise<void>;
  close(): Promise<void>;
}

export interface LarkCliFeishuEventGatewayOptions {
  readonly homeDirectory?: string;
  readonly sourceReadinessDeadlineMs?: number;
  readonly sourceObservationIntervalMs?: number;
  readonly createConsumer?: (
    eventKey: typeof LARK_EVENT_KEYS[number],
    signal: AbortSignal,
  ) => Promise<LarkCliEventConsumer>;
  readonly inspectArtifact?: (
    locator: FeishuArtifactLocator,
    signal: AbortSignal,
  ) => Promise<unknown>;
  readonly runCommand?: LarkCliReadCommand;
  readonly createPollingGateway?: () => LarkCliFeishuPollingGateway;
}

type CreateConsumer = NonNullable<LarkCliFeishuEventGatewayOptions['createConsumer']>;

async function createConsumerBeforeDeadline(
  createConsumer: CreateConsumer,
  eventKey: typeof LARK_EVENT_KEYS[number],
  signal: AbortSignal,
  deadlineMs: number,
): Promise<LarkCliEventConsumer> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new FeishuGatewayError(
        'UNAVAILABLE',
        `lark-cli source readiness deadline expired for ${eventKey}`,
      ));
    }, deadlineMs);
    timer.unref();
  });
  try {
    return await Promise.race([createConsumer(eventKey, signal), deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

interface QueueWaiter {
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
  readonly signal: AbortSignal;
  readonly onAbort: () => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

function createEventSourceGateway(
  options: LarkCliFeishuEventGatewayOptions = {},
): LarkCliFeishuEventGateway {
  const homeDirectory = options.homeDirectory ?? homedir();
  const inspectArtifact = options.inspectArtifact ?? createLarkCliFeishuArtifactInspector({
    homeDirectory,
    ...(options.runCommand === undefined ? {} : { runCommand: options.runCommand }),
  });
  const sourceReadinessDeadlineMs = options.sourceReadinessDeadlineMs ??
    DEFAULT_SOURCE_READINESS_DEADLINE_MS;
  const sourceObservationIntervalMs = options.sourceObservationIntervalMs ??
    DEFAULT_SOURCE_OBSERVATION_INTERVAL_MS;
  if (!Number.isSafeInteger(sourceReadinessDeadlineMs) || sourceReadinessDeadlineMs < 1) {
    throw new TypeError('source readiness deadline must be a positive safe integer');
  }
  if (!Number.isSafeInteger(sourceObservationIntervalMs) || sourceObservationIntervalMs < 1) {
    throw new TypeError('source observation interval must be a positive safe integer');
  }
  const lifecycle = new AbortController();
  const buffered: Array<{ readonly eventId: string; readonly artifact: FeishuGeneratedArtifact }> = [];
  const consumers: LarkCliEventConsumer[] = [];
  let starting: Promise<void> | undefined;
  let failure: unknown;
  let waiter: QueueWaiter | undefined;

  const notify = (): void => {
    const current = waiter;
    waiter = undefined;
    if (current === undefined) return;
    clearTimeout(current.timer);
    current.signal.removeEventListener('abort', current.onAbort);
    if (failure !== undefined) current.reject(failure);
    else current.resolve();
  };

  const pump = async (consumer: LarkCliEventConsumer): Promise<void> => {
    try {
      for await (const candidate of consumer.events) {
        const artifact = normalizeLarkCliGeneratedEvent(candidate);
        const eventId = readLarkCliEventId(candidate);
        if (buffered.length >= MAX_BUFFERED_EVENTS) {
          throw new FeishuGatewayError('UNAVAILABLE', 'lark-cli generated-event buffer is full');
        }
        buffered.push({ eventId, artifact });
        notify();
      }
      if (!lifecycle.signal.aborted) {
        throw new FeishuGatewayError('UNAVAILABLE', 'lark-cli generated-event source ended');
      }
    } catch (error) {
      if (!lifecycle.signal.aborted) {
        failure = error;
        lifecycle.abort(error);
        notify();
        const opened = consumers.splice(0);
        await Promise.all(opened.map(current => current.close()));
      }
    }
  };

  const ensureStarted = async (): Promise<void> => {
    if (starting !== undefined) return starting;
    starting = (async () => {
      const createConsumer = options.createConsumer ?? ((eventKey, signal) =>
        startDefaultLarkCliConsumer(eventKey, signal, homeDirectory));
      for (const eventKey of LARK_EVENT_KEYS) {
        if (lifecycle.signal.aborted) throw lifecycle.signal.reason;
        const consumer = await createConsumerBeforeDeadline(
          createConsumer,
          eventKey,
          lifecycle.signal,
          sourceReadinessDeadlineMs,
        );
        if (lifecycle.signal.aborted) {
          await consumer.close();
          throw lifecycle.signal.reason;
        }
        consumers.push(consumer);
        void pump(consumer);
      }
      await new Promise<void>(resolve => setImmediate(resolve));
      if (lifecycle.signal.aborted) throw lifecycle.signal.reason;
    })().catch(async error => {
      failure = error;
      lifecycle.abort(error);
      notify();
      const opened = consumers.splice(0);
      await Promise.all(opened.map(consumer => consumer.close()));
      throw error;
    });
    return starting;
  };

  const waitForEvent = (signal: AbortSignal): Promise<void> => {
    if (buffered.length > 0) return Promise.resolve();
    if (failure !== undefined) return Promise.reject(failure);
    if (signal.aborted) return Promise.reject(signal.reason);
    return new Promise<void>((resolve, reject) => {
      const onAbort = (): void => {
        if (waiter?.onAbort === onAbort) waiter = undefined;
        clearTimeout(timer);
        reject(signal.reason);
      };
      const timer = setTimeout(() => {
        if (waiter?.onAbort !== onAbort) return;
        waiter = undefined;
        signal.removeEventListener('abort', onAbort);
        resolve();
      }, sourceObservationIntervalMs);
      timer.unref();
      waiter = { resolve, reject, signal, onAbort, timer };
      signal.addEventListener('abort', onAbort, { once: true });
    });
  };

  return {
    start: ensureStarted,
    async listGeneratedArtifacts({ cursor, limit, signal }): Promise<FeishuGeneratedArtifactPage> {
      if (!Number.isInteger(limit) || limit < 1 || limit > 64) {
        throw new TypeError('generated-artifact page limit must be 1..64');
      }
      await ensureStarted();
      await waitForEvent(signal);
      await new Promise<void>(resolve => setImmediate(resolve));
      const page = buffered.splice(0, limit);
      return {
        artifacts: page.map(item => item.artifact),
        nextCursor: page.at(-1)?.eventId ?? cursor,
      };
    },
    inspectArtifact(locator, signal): Promise<unknown> {
      return inspectArtifact(locator, signal);
    },
    async close(): Promise<void> {
      lifecycle.abort(new Error('Feishu event gateway closed'));
      notify();
      await starting?.catch(() => undefined);
      await Promise.all(consumers.map(consumer => consumer.close()));
    },
  };
}

export function createLarkCliFeishuEventGateway(
  options: LarkCliFeishuEventGatewayOptions = {},
): LarkCliFeishuEventGateway {
  const homeDirectory = options.homeDirectory ?? homedir();
  const eventSource = createEventSourceGateway(options);
  let pollingSource: LarkCliFeishuPollingGateway | undefined;
  let activeSource: LarkCliFeishuEventGateway | LarkCliFeishuPollingGateway | undefined;
  let starting: Promise<void> | undefined;

  const start = (): Promise<void> => {
    starting ??= (async () => {
      try {
        await eventSource.start();
        activeSource = eventSource;
      } catch (error) {
        if (!(error instanceof FeishuGatewayError) || error.code !== 'EVENT_BUS_CONFLICT') {
          throw error;
        }
        await eventSource.close();
        pollingSource = options.createPollingGateway?.() ??
          createLarkCliFeishuPollingGateway({
            homeDirectory,
            ...(options.runCommand === undefined ? {} : { runCommand: options.runCommand }),
            ...(options.inspectArtifact === undefined
              ? {} : { inspectArtifact: options.inspectArtifact }),
          });
        await pollingSource.start();
        activeSource = pollingSource;
      }
    })();
    return starting;
  };

  return {
    start,
    async listGeneratedArtifacts(request): Promise<FeishuGeneratedArtifactPage> {
      await start();
      if (activeSource === undefined) {
        throw new FeishuGatewayError('UNAVAILABLE', 'Feishu source did not become ready');
      }
      return activeSource.listGeneratedArtifacts(request);
    },
    async inspectArtifact(locator, signal): Promise<unknown> {
      await start();
      if (activeSource === undefined) {
        throw new FeishuGatewayError('UNAVAILABLE', 'Feishu source did not become ready');
      }
      return activeSource.inspectArtifact(locator, signal);
    },
    async close(): Promise<void> {
      await Promise.all([
        eventSource.close(),
        pollingSource?.close(),
      ]);
    },
  };
}

export { classifyLarkCliFailure } from './lark-cli-consumer.js';
export {
  larkCliChildEnvironment,
  resolveBundledLarkCliEntrypoint,
} from './lark-cli-runner.js';
export type { LarkCliEventConsumer } from './lark-cli-consumer.js';
