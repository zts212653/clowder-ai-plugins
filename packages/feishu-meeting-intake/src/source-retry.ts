import { abortableSleep } from './abortable-sleep.js';
import { FeishuGatewayError } from './gateway.js';
import type { FeishuMeetingIntakeRuntime } from './runtime.js';

const DEFAULT_BASE_DELAY_MS = 5_000;
const DEFAULT_MAX_DELAY_MS = 5 * 60_000;
const RETRYABLE_SOURCE_FAILURES = new Set([
  'RATE_LIMITED',
  'UNAVAILABLE',
]);

export interface FeishuSourceRetryOptions {
  readonly baseDelayMs?: number;
  readonly maxDelayMs?: number;
  readonly sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}

function waitForAbort(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    const rejectOnAbort = (): void => reject(signal.reason);
    if (signal.aborted) rejectOnAbort();
    else signal.addEventListener('abort', rejectOnAbort, { once: true });
  });
}

export async function runFeishuPollingLoop(
  runtime: FeishuMeetingIntakeRuntime,
  signal: AbortSignal,
  options: FeishuSourceRetryOptions = {},
): Promise<void> {
  const baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const maxDelayMs = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  if (
    !Number.isSafeInteger(baseDelayMs) || baseDelayMs < 1 ||
    !Number.isSafeInteger(maxDelayMs) || maxDelayMs < baseDelayMs
  ) {
    throw new TypeError('source retry delays must be positive safe integers with max >= base');
  }
  const sleep = options.sleep ?? abortableSleep;
  let consecutiveFailures = 0;
  while (!signal.aborted) {
    try {
      const result = await runtime.pollOnce(signal);
      consecutiveFailures = 0;
      if (result.blocked === 'catch-up') await waitForAbort(signal);
    } catch (error) {
      if (!(error instanceof FeishuGatewayError) || !RETRYABLE_SOURCE_FAILURES.has(error.code)) throw error;
      const multiplier = 2 ** Math.min(consecutiveFailures, 30);
      const delayMs = Math.min(baseDelayMs * multiplier, maxDelayMs);
      consecutiveFailures += 1;
      await sleep(delayMs, signal);
    }
  }
}
