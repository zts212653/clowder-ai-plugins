import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { constants, readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { NativeStdioTransport } from './native-stdio.mjs';
import { NativeLinkClient } from './link-client.mjs';

const pins = JSON.parse(readFileSync(new URL('../assets/native/manifest.json', import.meta.url), 'utf8'));
export function nativeAsset(platform = process.platform, arch = process.arch) {
  const pin = pins.artifacts[`${platform}-${arch}`];
  if (!pin || pins.product !== 'clowder-wechat-link') throw Error('当前安装包尚未包含适用于本机的安全重写连接组件');
  return { ...pin, product: pins.product, version: pins.version };
}
export async function loadBundled(asset, signal) {
  signal.throwIfAborted();
  const compressed = await readFile(new URL(`../assets/native/${asset.fileName}.gz`, import.meta.url));
  signal.throwIfAborted();
  if (createHash('sha256').update(compressed).digest('hex') !== asset.compressedSha256) throw Error('native bundle integrity mismatch');
  return gunzipSync(compressed, { maxOutputLength: asset.size });
}
async function privateDirectory(path, recursive = false) {
  let directory;
  try {
    try { await mkdir(path, { recursive, mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    directory = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const stat = await directory.stat();
    if (!stat.isDirectory() || typeof process.getuid === 'function' && stat.uid !== process.getuid()) throw Error('directory ownership mismatch');
    await directory.chmod(0o700);
  } catch { throw Error('native private directory must be an owned directory, not a symbolic link'); }
  finally { await directory?.close(); }
}
async function initializeVault(path) {
  const names = await readdir(path);
  if (!names.length) return true;
  if (names.includes('vault.id') && names.includes('state.vault')) return false;
  // A marker without complete state could represent an interrupted creation
  // or missing user data. Preserve everything; never guess and start over.
  throw Object.assign(Error('账号保险库初始化未完成或文件缺失；原件已保留，请进入修复。'), { code: 'vault_repair_required' });
}
function validAsset(asset) {
  return asset && typeof asset.fileName === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(asset.fileName) &&
    Number.isSafeInteger(asset.size) && asset.size > 0 && asset.size <= 128 * 1024 * 1024 && /^[a-f0-9]{64}$/.test(asset.sha256) &&
    typeof asset.version === 'string' && /^[A-Za-z0-9][A-Za-z0-9.+-]{0,63}$/.test(asset.version);
}
/** Own exactly one private-pipe process. There is no port/token, external PID
 * lookup, generic configuration root, legacy profile import or backend fallback. */
export class NativeSupervisor {
  constructor({ dataPath, asset, download = loadBundled }) {
    Object.assign(this, { dataPath, asset, download }); this.client = null; this.clients = new WeakMap(); this.epoch = 0;
  }
  async executable(signal, current) {
    const asset = this.asset ?? nativeAsset();
    if (!validAsset(asset)) throw Error('native integrity descriptor invalid');
    await privateDirectory(this.dataPath, true);
    const root = await realpath(this.dataPath), binary = join(root, asset.fileName);
    let bytes;
    try {
      const stat = await lstat(binary);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || typeof process.getuid === 'function' && stat.uid !== process.getuid()) throw Error('native integrity mismatch');
      if (stat.size === asset.size) bytes = await readFile(binary);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (!bytes || createHash('sha256').update(bytes).digest('hex') !== asset.sha256) {
      bytes = await this.download(asset, signal);
      if (!Buffer.isBuffer(bytes) || bytes.length !== asset.size || createHash('sha256').update(bytes).digest('hex') !== asset.sha256) throw Error('native integrity mismatch');
      await current();
      const temporary = join(root, `.component-${randomUUID()}`);
      try { await writeFile(temporary, bytes, { mode: 0o700, flag: 'wx' }); await rename(temporary, binary); }
      finally { await rm(temporary, { force: true }); }
    }
    await chmod(binary, 0o700);
    return { asset, root, binary };
  }
  async prepare(owner) {
    const epoch = this.epoch;
    owner.signal.throwIfAborted(); await owner.assertCurrent();
    if (epoch !== this.epoch) throw Error("connection preparation expired");
    if (this.repairing) throw Error("system authorization is already in progress");
    if (this.record?.stopping) await this.record.stopping;
    if (epoch !== this.epoch || this.repairing) throw Error("connection preparation expired");
    if (this.client) { await this.client.status(); return this.client; }
    if (this.preparing) return this.preparing;
    const record = { controller: new AbortController(), child: null, client: null, exited: null, stopping: null };
    this.record = record;
    const pending = this.start(record, owner).finally(() => { if (this.preparing === pending) this.preparing = null; });
    record.pending = pending; this.preparing = pending; return pending;
  }
  async start(record, owner) {
    const signal = AbortSignal.any([owner.signal, record.controller.signal]);
    const current = async () => { signal.throwIfAborted(); await owner.assertCurrent(); signal.throwIfAborted(); };
    const abort = () => { void this.stopRecord(record); };
    signal.addEventListener('abort', abort, { once: true });
    try {
      const { asset, root, binary } = await this.executable(signal, current);
      const vault = join(root, 'link-vault'); await privateDirectory(vault);
      const initialize = await initializeVault(vault);
      await current();
      const child = spawn(binary, ['--data-dir', vault, ...(initialize ? ['--initialize'] : [])], { env: {}, stdio: ['pipe', 'pipe', 'pipe'], shell: false });
      record.child = child; this.child = child;
      record.exited = new Promise(resolve => {
        let done = false;
        const finish = () => {
          if (done) return; done = true;
          if (this.record === record) { this.client = null; this.child = undefined; this.onExit?.(); }
          resolve();
        };
        child.once('exit', finish); child.once('error', finish);
      });
      const transport = new NativeStdioTransport(child, { timeoutMs: 45000 });
      const client = new NativeLinkClient({ transport, pid: child.pid, version: asset.version });
      record.client = client; this.clients.set(client, record);
      await client.handshake(); await current();
      if (child.exitCode !== null || child.signalCode !== null || transport.closed || transport.exited) throw Error('账号连接组件已退出');
      this.client = client; return client;
    } catch (error) { await this.stopRecord(record); throw error; }
    finally { signal.removeEventListener('abort', abort); }
  }
  async reauthorize(owner, mode = 'reauthorize') {
    if (!['reauthorize', 'recover-initialization'].includes(mode)) throw Error('unsupported system authorization operation');
    const epoch = this.epoch;
    owner.signal.throwIfAborted(); await owner.assertCurrent();
    if (epoch !== this.epoch) throw Error('system authorization expired');
    if (this.preparing || this.repairing) throw Error('connection operation already in progress');
    const previous = this.record;
    const record = { controller: new AbortController(), child: null, client: null, exited: null, stopping: null };
    this.record = record; this.client = null; this.child = undefined;
    const pending = this.authorizeProcess(record, previous, owner, mode).finally(() => { if (this.repairing === pending) this.repairing = null; });
    record.pending = pending; this.repairing = pending; return pending;
  }
  async authorizeProcess(record, previous, owner, mode) {
    const signal = AbortSignal.any([owner.signal, record.controller.signal]);
    const current = async () => { signal.throwIfAborted(); await owner.assertCurrent(); signal.throwIfAborted(); };
    const abort = () => { void this.stopRecord(record); };
    signal.addEventListener('abort', abort, { once: true });
    let timer;
    try {
      if (previous) await this.stopRecord(previous);
      await current();
      const { root, binary, asset } = await this.executable(signal, current);
      const vault = join(root, 'link-vault');
      // No new vault directory/marker is created by this path. The native
      // process validates file descriptors and decrypts existing state only.
      const stateDirectory = await lstat(vault);
      if (!stateDirectory.isDirectory() || stateDirectory.isSymbolicLink() || (stateDirectory.mode & 0o7777) !== 0o700 ||
          typeof process.getuid === 'function' && stateDirectory.uid !== process.getuid()) throw Error('invalid existing account state directory');
      if (mode === 'reauthorize' && await initializeVault(vault)) throw Error('existing account state is required');
      await current();
      const child = spawn(binary, ['--data-dir', vault, `--${mode}`], { env: {}, stdio: ['ignore', 'pipe', 'ignore'], shell: false });
      record.child = child; this.child = child;
      record.exited = new Promise(resolve => { child.once('exit', resolve); child.once('error', resolve); });
      let bytes = Buffer.alloc(0), oversized = false;
      child.stdout.on('data', chunk => {
        if (bytes.length + chunk.length > 4096) { oversized = true; abort(); }
        else bytes = Buffer.concat([bytes, chunk]);
      });
      const output = new Promise(resolve => child.once('close', code => resolve({ code, bytes })));
      timer = setTimeout(abort, 120000); timer.unref();
      const result = await output;
      if (signal.aborted || oversized || result.code !== 0) throw Error('system authorization result unknown');
      let value;
      try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(result.bytes)); }
      catch { throw Error('invalid system authorization response'); }
      const keys = ['product', 'version', 'pid', 'repair', 'state'];
      const states = ['verified', 'initialized', 'already_initialized', 'key_missing', 'access_denied', 'cancelled', 'interaction_unavailable', 'authorization_not_persistent', 'busy', 'key_unavailable', 'invalid_state'];
      const kind = mode === 'reauthorize' ? 'keychain-reauthorization' : 'initialization-recovery';
      if (!value || Object.keys(value).length !== keys.length || Object.keys(value).some(key => !keys.includes(key)) || value.product !== 'clowder-wechat-link' ||
          value.version !== asset.version || value.pid !== child.pid || value.repair !== kind || !states.includes(value.state) ||
          mode === 'reauthorize' && value.state === 'initialized' || mode === 'recover-initialization' && value.state === 'verified') throw Error('invalid system authorization response');
      return { state: value.state };
    } finally {
      clearTimeout(timer); signal.removeEventListener('abort', abort);
      await this.stopRecord(record);
    }
  }
  stopRecord(record) {
    if (record.stopping) return record.stopping;
    if (this.record === record) this.client = null;
    // Mark the stop before abort emits synchronously and re-enters this method.
    let finish;
    record.stopping = new Promise(resolve => { finish = resolve; });
    record.controller.abort(); record.client?.transport.close();
    void (async () => {
      try {
        const child = record.child;
        if (child) {
          if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
          await Promise.race([record.exited, delay(3000, undefined, { ref: false })]);
          if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await record.exited; }
        }
      } finally {
        if (this.record === record) { this.record = null; this.client = null; this.child = undefined; }
        finish();
      }
    })();
    return record.stopping;
  }
  async stopOwned(client) { const record = this.clients.get(client); if (record) await this.stopRecord(record); }
  async stop() {
    this.epoch++;
    const record = this.record;
    if (!record) return;
    await this.stopRecord(record); await record.pending?.catch(() => {});
  }
}
