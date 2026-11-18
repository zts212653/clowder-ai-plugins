import { spawn } from 'node:child_process';
import { access, mkdtemp, unlink, rmdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Attachment, Command } from './types.js';

export class CliUnavailableError extends Error {}

/** Fixed argv, bounded JSON stdin/stdout; no shell, inherited credentials, or user-supplied flags. */
export async function runCli(command: Command, input: unknown, signal: AbortSignal): Promise<unknown> {
  const output = await runCommand(command, JSON.stringify(input), signal);
  try { return JSON.parse(output); } catch { throw new Error('CLI 返回了无效 JSON'); }
}

export async function githubCliExecutable(dataPath: string) {
  if (process.platform !== 'win32') return 'gh';
  const executable = join(dataPath, 'tools', 'github-cli', 'gh.exe');
  return access(executable).then(() => executable, () => 'gh');
}

export async function githubCliToken(signal: AbortSignal, executable = 'gh') {
  const output = await runCommand({ executable, args: ['auth', 'token', '--hostname', 'github.com'] }, undefined, signal, {});
  return output.trim();
}

export async function githubCliCanAttach(signal: AbortSignal, executable = 'gh') {
  const help = await runCommand({ executable, args: ['issue', 'comment', '--help'] }, undefined, signal, {}).catch(() => '');
  signal.throwIfAborted();
  return /^\s*--attach\s/m.test(help);
}

export async function githubCliAttach(issueUrl: string, pictures: Attachment[], comment: string, auth: string, signal: AbortSignal, executable = 'gh') {
  const directory = await mkdtemp(join(tmpdir(), 'clowder-feedback-'));
  const files = pictures.map((picture, index) =>
    join(directory, `screenshot-${index + 1}.${picture.mime.split('/')[1]}`));
  try {
    for (const [index, picture] of pictures.entries()) {
      await writeFile(files[index]!, Buffer.from(picture.base64, 'base64'), {mode:0o600});
    }
    const args = ['issue', 'comment', issueUrl, '--body-file', '-',
      ...files.flatMap((file, i) => ['--attach', `${file}#Clowder-screenshot-${i + 1}`])];
    return (await runCommand({ executable, args }, comment, signal, {GH_TOKEN:auth}, 90_000)).trim();
  } finally {
    await Promise.allSettled(files.map(file => unlink(file)));
    await rmdir(directory).catch(() => {});
  }
}

async function runCommand(command: Command, input: string | undefined, signal: AbortSignal, githubEnv?: NodeJS.ProcessEnv, timeout = 30_000): Promise<string> {
  signal.throwIfAborted();
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'PATHEXT', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  if (githubEnv) Object.assign(env, githubEnv, {GH_PROMPT_DISABLED:'1', GH_NO_UPDATE_NOTIFIER:'1'});
  const child = spawn(command.executable, command.args, { shell: false, windowsHide: true, env, stdio: ['pipe', 'pipe', 'pipe'] });
  return await new Promise((resolve, reject) => {
    let output = ''; let bytes = 0; let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal.removeEventListener('abort', abort);
      if (error) { stop(); reject(error); }
      else resolve(output);
    };
    const stop = () => {
      if (!child.pid) return;
      if (process.platform === 'win32') {
        const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        killer.on('error', () => child.kill());
      } else child.kill('SIGKILL');
    };
    const abort = () => finish(new Error('CLI 已取消；远端写入结果需要核对'));
    const timer = setTimeout(() => finish(new Error('CLI 超时；远端写入结果需要核对')), timeout);
    signal.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 2_000_000) finish(new Error('CLI 输出超限'));
      else output += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > 2_000_000) finish(new Error('CLI 输出超限')); });
    child.on('error', () => finish(new CliUnavailableError('CLI 无法启动，请检查目标配置')));
    child.on('close', code => finish(code === 0 ? undefined : new Error('CLI 操作失败；请核对远端状态')));
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}
