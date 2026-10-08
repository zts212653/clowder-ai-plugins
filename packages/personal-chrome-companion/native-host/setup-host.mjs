import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extensionDigest, extensionFiles } from '../dist/extension-delivery.js';
import { prepareRuntimeDelivery } from '../dist/runtime-delivery.js';
import { inspectNativeHostInstallation, installNativeHost, uninstallNativeHost } from './install-host.mjs';
import { manifestLocation, PERSONAL_CHROME_NATIVE_HOST_NAME } from './native-host-install-contract.mjs';
import { resolvePersonalChromeHostPaths } from './pairing-record.mjs';
import { acquireProcessLease, acquireInactiveSocketLease } from './native-socket-lease.mjs';

const extensionDirectory = fileURLToPath(new URL('../extension/', import.meta.url));
const FIELDS = new Set(['operation', 'projectRoot', 'homeDirectory']);

function requestOptions(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request) ||
      Object.keys(request).some(key => !FIELDS.has(key)) ||
      !['inspect', 'install', 'uninstall'].includes(request.operation)) {
    throw new TypeError('invalid setup request');
  }
  for (const field of ['projectRoot', 'homeDirectory']) {
    const value = request[field];
    if (typeof value !== 'string' || !isAbsolute(value) || value.trim() !== value || /[\x00-\x1f]/.test(value)) {
      throw new TypeError(`invalid setup request ${field}`);
    }
  }
  return { projectRoot: request.projectRoot, homeDirectory: request.homeDirectory };
}

async function metadata(path) {
  try { return await lstat(path); }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
}

/** A trusted Host selects roots. Package actions never receive HOME authority. */
async function guardDestination(root, destination) {
  const suffix = relative(root, destination);
  if (!suffix || suffix.startsWith('..') || isAbsolute(suffix)) throw new Error('invalid setup destination');
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('invalid setup root');
  let current = root;
  for (const part of suffix.split('/')) {
    current = join(current, part);
    const info = await metadata(current);
    if (!info) break;
    if (info.isSymbolicLink() || (!info.isDirectory() && current !== destination)) {
      throw new Error('invalid setup destination');
    }
  }
}

async function identity() {
  const manifest = JSON.parse(await readFile(join(extensionDirectory, 'manifest.json'), 'utf8'));
  if (typeof manifest.key !== 'string' || manifest.key.length < 100) throw new Error('invalid extension identity');
  return createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest('hex').slice(0, 32)
    .replace(/[0-9a-f]/g, digit => String.fromCharCode(97 + parseInt(digit, 16)));
}

function failureCode(error) {
  if (error.code === 'EACCES' || error.code === 'EPERM') return 'PERMISSION_DENIED';
  if (error.message?.includes('socket already has a live owner')) return 'HELPER_ACTIVE';
  if (error.message?.includes('already has a live owner')) return 'INSTALLATION_BUSY';
  if (error.message?.includes('helper is active')) return 'HELPER_ACTIVE';
  return 'INVALID_INSTALLATION';
}

/** Fixed, verified-package setup operation. All arguments come from Host policy, never HTTP input. */
export async function runPersonalChromeSetup(request) {
  const options = requestOptions(request);
  if (!['darwin', 'linux'].includes(process.platform)) return { status: 'unsupported', errorCode: 'UNSUPPORTED_PLATFORM' };
  const paths = resolvePersonalChromeHostPaths(options.projectRoot);
  const extensionPath = join(paths.rootDirectory, 'extension');
  const extensionId = await identity();
  const projection = { extensionId, extensionPath };
  let registrationLease;
  let socketLease;
  try {
    const { manifestPath } = manifestLocation({ platform: process.platform, homeDirectory: options.homeDirectory });
    await guardDestination(options.projectRoot, paths.rootDirectory);
    await guardDestination(options.homeDirectory, manifestPath);
    for (const path of [paths.pairingRecordPath, paths.launcherPath, paths.artifactsDirectory,
      join(paths.rootDirectory, 'delivery-reload.json'), extensionPath]) {
      if (await metadata(paths.rootDirectory)) await guardDestination(paths.rootDirectory, path);
    }
    if (request.operation !== 'inspect') {
      // Native registration is per browser user, while the existing installer lease is per project.
      // Serialize product setup across projects before checking registration ownership.
      await mkdir(dirname(manifestPath), { recursive: true, mode: 0o700 });
      registrationLease = await acquireProcessLease(`${manifestPath}.setup`, { label: 'native registration' });
      // Keep the helper's own socket fence through activation, delivery and cleanup.
      // An existence check alone races a Chrome-triggered helper startup.
      socketLease = await acquireInactiveSocketLease(paths.socketPath);
    }
    const existingManifest = await metadata(manifestPath);
    if (existingManifest) {
      if (!existingManifest.isFile() || existingManifest.size > 16 * 1024) throw new Error('invalid registration');
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
      if (manifest.name !== PERSONAL_CHROME_NATIVE_HOST_NAME || manifest.path !== paths.launcherPath) {
        return { ...projection, status: 'invalid_installation', errorCode: 'REGISTRATION_CONFLICT' };
      }
    }
    if (request.operation === 'uninstall') {
      if (await metadata(paths.rootDirectory)) {
        await uninstallNativeHost({ ...options, retainAuthorizations: true, socketLease });
      } else if (existingManifest) {
        // Ownership was checked above while holding both registration and helper fences.
        await unlink(manifestPath);
      }
      return { ...projection, status: 'not_installed' };
    }
    if (request.operation === 'install') {
      // Repair the activation files before delivery tries to refresh an existing helper.
      // A later delivery failure remains an incomplete installation and can be retried.
      await installNativeHost({ ...options, extensionId });
      // Keep delivery's lease/rollback and generation accounting as the single source of truth.
      const delivery = await prepareRuntimeDelivery(paths.rootDirectory);
      try {
        const { failure } = delivery.status();
        if (failure) return { ...projection, status: 'invalid_installation', errorCode: failure };
      } finally { await delivery.dispose(); }
    }
    if (!(await metadata(paths.pairingRecordPath))) {
      return { ...projection, status: 'not_installed' };
    }
    const installed = await inspectNativeHostInstallation(options);
    if (installed.extensionId !== extensionId ||
        extensionDigest(await extensionFiles(extensionPath)) !== extensionDigest(await extensionFiles(extensionDirectory))) {
      throw new Error('installed extension differs from verified package');
    }
    // This only attests disk installation, never browser connectivity or account authorization.
    return { ...projection, status: 'installed' };
  } catch (error) {
    return { ...projection, status: 'invalid_installation', errorCode: failureCode(error) };
  } finally {
    try { await socketLease?.release(); }
    finally { await registrationLease?.release(); }
  }
}

function parseArguments(args) {
  const [operation, json, ...rest] = args;
  if (!['inspect', 'install', 'uninstall'].includes(operation) || json !== '--json' || rest.length !== 6) {
    throw new TypeError('invalid setup request arguments');
  }
  const values = new Map();
  for (let index = 0; index < rest.length; index += 2) {
    if (!['--project-root', '--home', '--node'].includes(rest[index]) || values.has(rest[index])) {
      throw new TypeError('invalid setup request arguments');
    }
    values.set(rest[index], rest[index + 1]);
  }
  return { operation, projectRoot: values.get('--project-root'), homeDirectory: values.get('--home'),
    nodeExecutable: values.get('--node') };
}

export async function runSetupCommand(args) {
  const action = ['inspect', 'install', 'uninstall'].includes(args[0]) ? args[0] : null;
  try {
    const { nodeExecutable, ...request } = parseArguments(args);
    if (typeof nodeExecutable !== 'string' || !isAbsolute(nodeExecutable) ||
        await realpath(nodeExecutable) !== await realpath(process.execPath)) throw new Error('invalid setup request node');
    const result = await runPersonalChromeSetup(request);
    if (result.errorCode) return { protocolVersion: 1, ok: false, action, code: result.errorCode };
    const installed = result.status === 'installed';
    let restartRequired = false;
    if (installed) {
      const recordPath = join(resolvePersonalChromeHostPaths(request.projectRoot).rootDirectory, 'delivery-reload.json');
      const info = await metadata(recordPath);
      if (!info?.isFile() || info.size > 4096) throw new Error('invalid delivery state');
      const state = JSON.parse(await readFile(recordPath, 'utf8'));
      if (typeof state.reloadRequired !== 'boolean') throw new Error('invalid delivery state');
      restartRequired = state.reloadRequired;
    }
    return { protocolVersion: 1, ok: true, action, installed,
      extensionPath: installed ? result.extensionPath : null, extensionId: result.extensionId,
      browserAction: restartRequired ? 'load-unpacked' : 'none', restartRequired };
  } catch (error) {
    return { protocolVersion: 1, ok: false, action,
      code: error.message?.includes('setup request') || error.code === 'ENOENT' ? 'INVALID_REQUEST' : 'INVALID_INSTALLATION' };
  }
}

if (process.argv[1] && await realpath(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await runSetupCommand(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
