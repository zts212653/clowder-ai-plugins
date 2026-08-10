import type { WireMethodName } from '@clowder-ai/plugin-contract';
import type { JsonObject } from '@clowder-ai/plugin-sdk';

export interface PendingCall {
  readonly method: WireMethodName;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: unknown) => void;
}

export class HostCallError extends Error {
  readonly response: unknown;

  constructor(method: WireMethodName, response: unknown) {
    super(`Host rejected ${method}`);
    this.name = 'HostCallError';
    this.response = structuredClone(response);
  }
}

export class FeishuStdioProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FeishuStdioProtocolError';
  }
}

export function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
  readonly reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export function requestInput(value: JsonObject): {
  readonly id: string;
  readonly method: string;
  readonly input: Record<string, unknown>;
} {
  if (
    typeof value.id !== 'string' ||
    typeof value.method !== 'string' ||
    value.params === null ||
    typeof value.params !== 'object' ||
    Array.isArray(value.params)
  ) {
    throw new FeishuStdioProtocolError('classifier accepted an invalid Host request');
  }
  const params = value.params as Record<string, unknown>;
  if (params.input === null || typeof params.input !== 'object' || Array.isArray(params.input)) {
    throw new FeishuStdioProtocolError('classifier accepted Host input outside the closed object boundary');
  }
  return { id: value.id, method: value.method, input: params.input as Record<string, unknown> };
}
