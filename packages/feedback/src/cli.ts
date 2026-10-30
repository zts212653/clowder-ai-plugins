import { spawn } from 'node:child_process';
import type { Command } from './types.js';

/** Fixed argv, bounded JSON stdin/stdout; no shell, inherited credentials, or user-supplied flags. */
export async function runCli(command: Command, input: unknown, signal: AbortSignal): Promise<unknown> {
  signal.throwIfAborted();
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'PATHEXT', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  const child = spawn(command.executable, command.args, { shell: false, windowsHide: true, env, stdio: ['pipe', 'pipe', 'pipe'] });
  return await new Promise((resolve, reject) => {
    let output = ''; let bytes = 0; let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal.removeEventListener('abort', abort);
      if (error) { stop(); reject(error); }
      else { try { resolve(JSON.parse(output)); } catch { reject(new Error('CLI 返回了无效 JSON')); } }
    };
    const stop = () => {
      if (!child.pid) return;
      if (process.platform === 'win32') {
        const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        killer.on('error', () => child.kill());
      } else child.kill('SIGKILL');
    };
    const abort = () => finish(new Error('CLI 已取消；远端写入结果需要核对'));
    const timer = setTimeout(() => finish(new Error('CLI 超时；远端写入结果需要核对')), 30_000);
    signal.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 2_000_000) finish(new Error('CLI 输出超限'));
      else output += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > 2_000_000) finish(new Error('CLI 输出超限')); });
    child.on('error', () => finish(new Error('CLI 无法启动，请检查目标配置')));
    child.on('close', code => finish(code === 0 ? undefined : new Error('CLI 操作失败；请核对远端状态')));
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(input));
  });
}
