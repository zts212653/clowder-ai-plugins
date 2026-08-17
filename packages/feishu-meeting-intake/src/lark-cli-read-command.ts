import { spawn } from 'node:child_process';

import { FeishuGatewayError } from './gateway.js';
import { classifyLarkCliFailure } from './lark-cli-consumer.js';
import {
  larkCliChildEnvironment,
  resolveBundledLarkCliEntrypoint,
} from './lark-cli-runner.js';

const MAX_STDOUT_BYTES = 2 * 1024 * 1024;
const MAX_STDERR_BYTES = 32 * 1024;
const COMMAND_DEADLINE_MS = 30_000;
const INSTALLER_NOTICE = /^lark-cli v\d+\.\d+\.\d+ installed successfully\r?$/u;

export type LarkCliReadCommand = (
  args: readonly string[],
  signal: AbortSignal,
) => Promise<unknown>;

export function parseLarkCliReadOutput(text: string): unknown {
  const lines = text.split('\n').filter(line => !INSTALLER_NOTICE.test(line.trim()));
  const candidate = lines.join('\n').trim();
  const start = candidate.indexOf('{');
  if (start < 0 || candidate.slice(0, start).trim() !== '') {
    throw new FeishuGatewayError('UNAVAILABLE', 'lark-cli read command emitted invalid JSON');
  }
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < candidate.length; index += 1) {
    const character = candidate[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === '{') depth += 1;
    else if (character === '}') depth -= 1;
    if (depth !== 0) continue;
    if (candidate.slice(index + 1).trim() !== '') {
      throw new FeishuGatewayError('UNAVAILABLE', 'lark-cli read command emitted trailing output');
    }
    try {
      return JSON.parse(candidate.slice(start, index + 1)) as unknown;
    } catch {
      throw new FeishuGatewayError('UNAVAILABLE', 'lark-cli read command emitted invalid JSON');
    }
  }
  throw new FeishuGatewayError('UNAVAILABLE', 'lark-cli read command emitted incomplete JSON');
}

function boundedAppend(
  current: Buffer<ArrayBufferLike>,
  chunk: Buffer<ArrayBufferLike>,
  maximum: number,
  label: string,
): Buffer<ArrayBufferLike> {
  if (current.byteLength + chunk.byteLength > maximum) {
    throw new FeishuGatewayError('UNAVAILABLE', `lark-cli ${label} exceeded its bound`);
  }
  return Buffer.concat([current, chunk]);
}

export function createDefaultLarkCliReadCommand(homeDirectory: string): LarkCliReadCommand {
  return (args, signal) => new Promise<unknown>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const child = spawn(
      process.execPath,
      [resolveBundledLarkCliEntrypoint(), ...args],
      {
        cwd: process.cwd(),
        env: larkCliChildEnvironment(homeDirectory),
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let settled = false;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const finish = (operation: () => void): void => {
      if (settled) return;
      settled = true;
      if (deadline !== undefined) clearTimeout(deadline);
      signal.removeEventListener('abort', onAbort);
      operation();
    };
    const fail = (error: unknown): void => {
      if (!child.killed) child.kill('SIGTERM');
      finish(() => reject(error));
    };
    const onAbort = (): void => fail(signal.reason);
    deadline = setTimeout(() => fail(
      new FeishuGatewayError('UNAVAILABLE', 'lark-cli read command deadline expired'),
    ), COMMAND_DEADLINE_MS);
    signal.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', (chunk: Buffer) => {
      try {
        stdout = boundedAppend(stdout, chunk, MAX_STDOUT_BYTES, 'stdout');
      } catch (error) {
        fail(error);
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      try {
        stderr = boundedAppend(stderr, chunk, MAX_STDERR_BYTES, 'diagnostic');
      } catch (error) {
        fail(error);
      }
    });
    child.once('error', () => fail(
      new FeishuGatewayError('UNAVAILABLE', 'lark-cli read command could not start'),
    ));
    child.once('exit', (code) => {
      if (settled) return;
      const detail = `${stdout.toString('utf8')}\n${stderr.toString('utf8')}`;
      if (code !== 0) {
        finish(() => reject(classifyLarkCliFailure(detail)));
        return;
      }
      try {
        const value = parseLarkCliReadOutput(stdout.toString('utf8'));
        if (
          typeof value === 'object' &&
          value !== null &&
          !Array.isArray(value) &&
          (value as Record<string, unknown>).ok === false
        ) {
          finish(() => reject(classifyLarkCliFailure(JSON.stringify(value))));
          return;
        }
        finish(() => resolve(value));
      } catch (error) {
        finish(() => reject(error));
      }
    });
  });
}
