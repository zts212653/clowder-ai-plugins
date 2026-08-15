import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

import { FeishuGatewayError } from './gateway.js';
import {
  larkCliChildEnvironment,
  resolveBundledLarkCliEntrypoint,
} from './lark-cli-runner.js';

export const LARK_EVENT_KEYS = [
  'minutes.minute.generated_v1',
  'vc.note.generated_v1',
] as const;

const MAX_EVENT_LINE_BYTES = 256 * 1024;
const MAX_DIAGNOSTIC_BYTES = 32 * 1024;

export interface LarkCliEventConsumer {
  readonly events: AsyncIterable<unknown>;
  close(): Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

class AsyncEventQueue implements AsyncIterable<unknown> {
  private readonly values: unknown[] = [];
  private readonly waiters: Array<{
    readonly resolve: (result: IteratorResult<unknown>) => void;
    readonly reject: (error: unknown) => void;
  }> = [];
  private ended = false;
  private failure: unknown;

  push(value: unknown): void {
    if (this.ended) return;
    const waiter = this.waiters.shift();
    if (waiter !== undefined) waiter.resolve({ done: false, value });
    else this.values.push(value);
  }

  fail(error: unknown): void {
    if (this.ended) return;
    this.ended = true;
    this.failure = error;
    for (const waiter of this.waiters.splice(0)) waiter.reject(error);
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    for (const waiter of this.waiters.splice(0)) waiter.resolve({ done: true, value: undefined });
  }

  [Symbol.asyncIterator](): AsyncIterator<unknown> {
    return {
      next: (): Promise<IteratorResult<unknown>> => {
        const value = this.values.shift();
        if (value !== undefined) return Promise.resolve({ done: false, value });
        if (this.failure !== undefined) return Promise.reject(this.failure);
        if (this.ended) return Promise.resolve({ done: true, value: undefined });
        return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
      },
    };
  }
}

export function classifyLarkCliFailure(detail: string): FeishuGatewayError {
  let errorType = '';
  let errorSubtype = '';
  for (const line of detail.split('\n')) {
    try {
      const candidate: unknown = JSON.parse(line);
      if (isRecord(candidate) && isRecord(candidate.error)) {
        errorType = String(candidate.error.type ?? '');
        errorSubtype = String(candidate.error.subtype ?? '');
      }
    } catch {
      // Readiness and exit diagnostics are intentionally non-JSON.
    }
  }
  const classification = `${errorType}:${errorSubtype}`.toLowerCase();
  if (classification === 'validation:failed_precondition') {
    return new FeishuGatewayError(
      'EVENT_BUS_CONFLICT',
      'another Feishu event bus owns this application',
    );
  }
  if (/auth|login|token|not_configured/u.test(classification)) {
    return new FeishuGatewayError('AUTH_EXPIRED', 'lark-cli user authorization is unavailable');
  }
  if (/permission|scope|forbidden/u.test(classification)) {
    return new FeishuGatewayError('PERMISSION_DENIED', 'lark-cli lacks generated-event permission');
  }
  if (/rate|429/u.test(classification)) {
    return new FeishuGatewayError('RATE_LIMITED', 'lark-cli generated-event source is rate limited');
  }
  return new FeishuGatewayError('UNAVAILABLE', 'lark-cli generated-event source stopped');
}

function startBoundedJsonLines(
  child: ChildProcessWithoutNullStreams,
  queue: AsyncEventQueue,
  fail: (error: unknown) => void,
): void {
  let pending = Buffer.alloc(0);
  child.stdout.on('data', (chunk: Buffer) => {
    pending = Buffer.concat([pending, chunk]);
    if (pending.byteLength > MAX_EVENT_LINE_BYTES && !pending.includes(0x0a)) {
      fail(new FeishuGatewayError('UNAVAILABLE', 'lark-cli emitted an oversized event'));
      return;
    }
    while (true) {
      const newline = pending.indexOf(0x0a);
      if (newline < 0) break;
      const line = pending.subarray(0, newline);
      pending = pending.subarray(newline + 1);
      if (line.byteLength === 0) continue;
      if (line.byteLength > MAX_EVENT_LINE_BYTES) {
        fail(new FeishuGatewayError('UNAVAILABLE', 'lark-cli emitted an oversized event'));
        return;
      }
      try {
        queue.push(JSON.parse(line.toString('utf8')) as unknown);
      } catch {
        fail(new FeishuGatewayError('UNAVAILABLE', 'lark-cli emitted invalid event JSON'));
        return;
      }
    }
  });
}

export async function startDefaultLarkCliConsumer(
  eventKey: typeof LARK_EVENT_KEYS[number],
  signal: AbortSignal,
  homeDirectory: string,
): Promise<LarkCliEventConsumer> {
  const child = spawn(
    process.execPath,
    [resolveBundledLarkCliEntrypoint(), 'event', 'consume', eventKey, '--as', 'user'],
    {
      cwd: process.cwd(),
      env: larkCliChildEnvironment(homeDirectory),
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
  const queue = new AsyncEventQueue();
  let diagnostic = '';
  let closed = false;
  let readySeen = false;
  let readyResolve!: () => void;
  let readyReject!: (error: unknown) => void;
  const ready = new Promise<void>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  const fail = (error: unknown): void => {
    queue.fail(error);
    readyReject(error);
    child.stdin.end();
  };
  startBoundedJsonLines(child, queue, fail);
  child.stderr.on('data', (chunk: Buffer) => {
    diagnostic = `${diagnostic}${chunk.toString('utf8')}`.slice(-MAX_DIAGNOSTIC_BYTES);
    if (diagnostic.includes(`[event] ready event_key=${eventKey}`)) {
      readySeen = true;
      readyResolve();
    }
  });
  child.once('error', fail);
  child.once('exit', (code) => {
    closed = true;
    if (!readySeen) fail(classifyLarkCliFailure(diagnostic));
    else if (code === 0) queue.end();
    else fail(classifyLarkCliFailure(diagnostic));
  });
  const onAbort = (): void => {
    if (!readySeen) readyReject(signal.reason);
    child.stdin.end();
  };
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    await ready;
  } catch (error) {
    signal.removeEventListener('abort', onAbort);
    throw error;
  }
  return {
    events: queue,
    close: async () => {
      signal.removeEventListener('abort', onAbort);
      if (closed) return;
      child.stdin.end();
      await new Promise<void>(resolve => {
        const timer = setTimeout(() => child.kill('SIGTERM'), 2_000);
        child.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    },
  };
}
