import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { commandFailure } from './command-errors.mjs';
import { fail } from './config.mjs';
import { checkpoint, execution, progress } from './execution.mjs';
import { terminateTree } from './terminate.mjs';
import { checkCommandDirectory } from './tool-diagnostics.mjs';

export async function command(executable, args, options = {}) {
  checkpoint();
  const signal = options.signal ?? execution()?.signal;
  if (signal?.aborted) fail('OPERATION_CANCELLED', '操作已取消');
  const { signal: _signal, timeout = 120000, input, binary = false, onOutput, ...spawnOptions } = options;
  const child = spawn(executable, args, {
    ...spawnOptions,
    windowsHide: true,
    detached: process.platform !== 'win32',
    stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
  });
  const decoder = new StringDecoder('utf8');
  let stderr = '';
  let truncated = false;
  let line = '';
  const stdout = [];
  let size = 0;
  let cause;
  let stopping;
  let uncertain;
  const uncertainty = new Promise((done) => {
    uncertain = done;
  });
  const stop = (reason) => {
    if (stopping || child.exitCode !== null || child.signalCode !== null) return;
    cause = reason;
    stopping = terminateTree(child).catch((error) => {
      cause = error.code;
      if (execution()) execution().stopUnconfirmed = true;
      uncertain(null);
    });
  };
  const abort = () => stop('OPERATION_CANCELLED');
  signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => stop('COMMAND_TIMEOUT'), timeout);
  child.stderr.on('data', (chunk) => {
    const text = decoder.write(chunk);
    if (stderr.length + text.length > 65536) truncated = true;
    stderr = (stderr + text).slice(-65536);
    line = (line + text).slice(-8192);
    const parts = line.split(/[\r\n]/);
    line = parts.pop();
    for (const part of parts) progress(part);
  });
  child.stdout.on('data', (chunk) => {
    size += chunk.length;
    if (size > 8 * 1024 * 1024) stop('OUTPUT_LIMIT');
    else stdout.push(chunk);
  });
  let spawnError;
  child.on('error', (error) => {
    spawnError = error;
  });
  if (input !== undefined) {
    child.stdin.on('error', () => {});
    child.stdin.end(input, 'utf8');
  }
  const code = await Promise.race([new Promise((done) => child.once('close', done)), uncertainty]);
  clearTimeout(timer);
  signal?.removeEventListener('abort', abort);
  if (stopping) await stopping;
  progress(line);
  if (cause)
    fail(
      cause,
      {
        OPERATION_CANCELLED: '操作已取消，执行进程树已停止',
        COMMAND_TIMEOUT: '命令超过允许时间，执行进程树已停止；请检查网络或在私有配置调整对应超时',
        STOP_UNCONFIRMED: '无法确认执行进程树已停止；保留执行锁，请在本机确认后恢复',
        OUTPUT_LIMIT: '命令输出超过允许大小，执行已停止；请在本机核对检查命令',
      }[cause],
    );
  onOutput?.({ stdout: Buffer.concat(stdout).toString('utf8'), stderr, truncated });
  if (spawnError) await checkCommandDirectory(spawnOptions.cwd);
  if (spawnError || code !== 0) commandFailure(stderr, spawnError?.code ?? code, executable);
  const output = Buffer.concat(stdout);
  return binary ? output : output.toString('utf8').trim();
}
export function gitEnvironment() {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' };
  if (!env.GIT_SSH_COMMAND && !env.GIT_SSH) env.GIT_SSH_COMMAND = 'ssh -o BatchMode=yes -o StrictHostKeyChecking=yes';
  return env;
}
export function git(directory, args, options = {}) {
  return command('git', ['-C', directory, ...args], { env: gitEnvironment(), ...options });
}
export async function ancestor(directory, from, to) {
  try {
    await git(directory, ['merge-base', '--is-ancestor', from, to]);
    return true;
  } catch (error) {
    if (error.code === 'COMMAND_FAILED' && error.details?.exitCode === 1) return false;
    throw error;
  }
}
