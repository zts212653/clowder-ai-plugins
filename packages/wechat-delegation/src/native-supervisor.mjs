import { spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { NativeClient } from './native-client.mjs';

// Vendor release metadata read 2026-11-14; exact digests are pinned, never latest.
const pins = {
  'darwin-arm64': ['wx-v2.4.1-darwin-arm64', 37408672, '98cca7f34a09d30a0ff552b10ca91dd94198c9c6b31302f3acbea09e4c55c85b'],
  'linux-arm64': ['wx-v2.4.1-linux-arm64-gnu', 43027568, 'bc504a9d1053e04d8b29885688e6695796c13cdc3a0b061475bc114420c6e73f'],
  'linux-x64': ['wx-v2.4.1-linux-x64-gnu', 46437160, '8d18d49d9e4c4e69bc3249405c119a9d25f9ccf92b0893907da14f3f56307f8c'],
};
export function nativeAsset(platform = process.platform, arch = process.arch) {
  const pin = pins[`${platform}-${arch}`];
  if (!pin) throw Error('当前系统没有已固定校验的账号连接组件');
  const [fileName, size, sha256] = pin;
  return { fileName, size, sha256, version: '2.4.1', url: `https://github.com/thisnick/agent-wechat/releases/download/v2.4.1/${fileName}` };
}
export async function downloadPinned(asset, signal) {
  let url = new URL(asset.url);
  for (let hop = 0; hop < 4; hop++) {
    if (url.protocol !== 'https:' || url.username || url.password || !['github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com'].includes(url.hostname))
      throw Error('账号组件下载来源不受支持');
    const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.any([signal, AbortSignal.timeout(60000)]) });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location'); await response.body?.cancel();
      if (!location) throw Error('账号组件下载跳转无效');
      url = new URL(location, url); continue;
    }
    if (!response.ok || !response.body) { await response.body?.cancel(); throw Error('账号组件下载未完成'); }
    if (Number(response.headers.get('content-length')) > asset.size) { await response.body.cancel(); throw Error('账号组件大小不符'); }
    const reader = response.body.getReader(); const chunks = []; let size = 0;
    try {
      for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.length; if (size > asset.size) throw Error('账号组件大小不符'); chunks.push(part.value); }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    return Buffer.concat(chunks);
  }
  throw Error('账号组件下载跳转次数过多');
}
async function port() {
  const listener = createServer();
  await new Promise((resolve, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', resolve); });
  const number = listener.address().port;
  await new Promise((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
  return number;
}
export class NativeSupervisor {
  constructor({ dataPath, asset, download = downloadPinned }) {
    this.dataPath = dataPath; this.asset = asset; this.download = download; this.client = null;
  }
  async prepare(owner) {
    owner.signal.throwIfAborted(); await owner.assertCurrent();
    if (this.client) { await this.client.status(); return this.client; }
    if (this.preparing) return this.preparing;
    this.preparing = this.start(owner).finally(() => { this.preparing = null; });
    return this.preparing;
  }
  async start(owner) {
    const asset = this.asset ?? nativeAsset();
    await mkdir(this.dataPath, { recursive: true, mode: 0o700 });
    const root = await realpath(this.dataPath);
    const binary = join(root, asset.fileName);
    let bytes;
    try {
      const stat = await lstat(binary);
      if (!stat.isFile() || stat.isSymbolicLink()) throw Error('native integrity mismatch');
      if (stat.size === asset.size) bytes = await readFile(binary);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (!bytes || createHash('sha256').update(bytes).digest('hex') !== asset.sha256) {
      bytes = await this.download(asset, owner.signal);
      if (bytes.length !== asset.size || createHash('sha256').update(bytes).digest('hex') !== asset.sha256) throw Error('native integrity mismatch');
      owner.signal.throwIfAborted(); await owner.assertCurrent();
      const temporary = join(root, `.download-${randomUUID()}`);
      try { await writeFile(temporary, bytes, { mode: 0o700, flag: 'wx' }); await rename(temporary, binary); }
      finally { await rm(temporary, { force: true }); }
    }
    if (createHash('sha256').update(bytes).digest('hex') !== asset.sha256) throw Error('native integrity mismatch');
    await chmod(binary, 0o700);
    const dataDir = join(root, 'native-profile');
    await mkdir(dataDir, { recursive: true, mode: 0o700 });
    // The native CLI resolves global config before serving, even with --data-dir.
    // Keep it in this plugin instance rather than inheriting the owner's HOME.
    const configDir = join(root, 'native-config');
    await mkdir(configDir, { recursive: true, mode: 0o700 });
    const listen = await port(); const token = randomBytes(32).toString('hex');
    const environment = Object.fromEntries(['PATH', 'TMPDIR', 'TMP', 'TEMP', 'SystemRoot', 'WINDIR', 'LANG', 'LC_ALL', 'TZ', 'SSL_CERT_FILE', 'SSL_CERT_DIR']
      .filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
    environment.XDG_CONFIG_HOME = configDir;
    owner.signal.throwIfAborted(); await owner.assertCurrent(); owner.signal.throwIfAborted();
    const child = spawn(binary, ['serve', '--data-dir', dataDir, '--token-stdin', '--listen', `127.0.0.1:${listen}`],
      { env: environment, stdio: ['pipe', 'ignore', 'pipe'], shell: false });
    this.child = child; let exited = false;
    this.exited = new Promise(resolve => {
      const finish = () => { if (exited) return; exited = true; this.client = null; this.onExit?.(); resolve(); };
      child.once('exit', finish); child.once('error', finish);
    });
    child.stderr.on('data', () => {}); // Never copy provider/account diagnostics to chats or logs.
    child.stdin.on('error', () => {}); child.stdin.end(`${token}\n`);
    const client = new NativeClient({ baseUrl: `http://127.0.0.1:${listen}/`, token, timeoutMs: 1000 });
    try {
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        owner.signal.throwIfAborted(); await owner.assertCurrent();
        if (exited) throw Error('账号连接组件已退出');
        let status;
        try { status = await client.status(); } catch { await delay(100, undefined, { signal: owner.signal }); continue; }
        if (status.pid !== child.pid || status.dataDir !== dataDir || status.version?.product !== 'agent-wechat' ||
            status.version?.backend !== 'native' || status.version?.apiVersion !== 1 || status.version?.version !== asset.version || !status.serverId || !status.ownershipGeneration ||
            !Array.isArray(status.version.capabilities) || ['serve', 'events', 'profile-read', 'text-send', 'native-login'].some(capability => !status.version.capabilities.includes(capability)))
          throw Error('账号连接组件身份与本次进程不符');
        await owner.assertCurrent(); owner.signal.throwIfAborted();
        this.client = new NativeClient({ baseUrl: client.base.href, token }); this.status = status;
        return this.client;
      }
      throw Error('账号连接组件未能启动，请重试准备连接');
    } catch (error) { await this.stop(); throw error; }
  }
  async stop() {
    const child = this.child;
    this.client = null;
    if (!child) return;
    child.kill('SIGTERM');
    await Promise.race([this.exited, delay(3000)]);
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await this.exited; }
    this.child = undefined;
  }
}
