import { spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { NativeClient } from './native-client.mjs';

// A source-pinned Clowder repair build, bundled for offline installation.
const pins = JSON.parse(readFileSync(new URL('../assets/native/manifest.json', import.meta.url), 'utf8'));
export function nativeAsset(platform = process.platform, arch = process.arch) {
  const pin = pins.artifacts[`${platform}-${arch}`];
  if (!pin) throw Error('本次通讯录修复构建暂只提供 macOS Apple Silicon 版本');
  return { ...pin, version: pins.version, capabilities: ['current-contact-directory'] };
}
export async function loadBundled(asset, signal) {
  signal.throwIfAborted();
  const compressed = await readFile(new URL(`../assets/native/${asset.fileName}.gz`, import.meta.url));
  if (createHash('sha256').update(compressed).digest('hex') !== asset.compressedSha256) throw Error('native bundle integrity mismatch');
  return gunzipSync(compressed, { maxOutputLength: asset.size });
}
async function port() {
  const listener = createServer();
  await new Promise((resolve, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', resolve); });
  const number = listener.address().port;
  await new Promise((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
  return number;
}
export class NativeSupervisor {
  constructor({ dataPath, asset, download = loadBundled }) {
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
            !Array.isArray(status.version.capabilities) || ['serve', 'events', 'profile-read', 'text-send', 'native-login', ...(asset.capabilities ?? [])].some(capability => !status.version.capabilities.includes(capability)))
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
