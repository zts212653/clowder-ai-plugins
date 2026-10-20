#!/usr/bin/env node

import { randomBytes } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, stat, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { removePersonalChromeConversationAuthorizations } from './conversation-binding.mjs';
import {
  digestInstalledNativeHostArtifactDirectory,
  digestNativeHostArtifactDirectory,
  publishNativeHostArtifact,
} from './native-host-artifact.mjs';
import {
  assertInstallMutationSupported,
  assertNodeRuntimeExecutable,
  buildNativeHostInstallPlan,
  installationReceipt,
  manifestLocation,
  PERSONAL_CHROME_NATIVE_HOST_NAME,
  PersonalChromeNativeHostInstallationError,
  renderNativeHostLauncher,
  requireExact,
} from './native-host-install-contract.mjs';
import {
  pathExists,
  readManifest,
  readOptionalFileSnapshot,
  restoreFileSnapshot,
  writeAtomicFile,
} from './native-host-install-files.mjs';
import { acquireProcessLease, acquireInactiveSocketLease, assertInactiveSocketLeaseHeld } from './native-socket-lease.mjs';
import {
  readPersonalChromePairingRecord,
  resolvePersonalChromeHostPaths,
  writePersonalChromePairingRecordAtomic,
} from './pairing-record.mjs';

const CHROME_EXTENSION_ID = /^[a-p]{32}$/;
const sourceDirectoryDefault = dirname(fileURLToPath(import.meta.url));

export { buildNativeHostInstallPlan, PERSONAL_CHROME_NATIVE_HOST_NAME };

export async function inspectNativeHostInstallation({
  platform = process.platform,
  projectRoot,
  homeDirectory = homedir(),
  localAppData = process.env.LOCALAPPDATA,
  userDataDirectory,
  nodeExecutable = process.execPath,
  sourceDirectory = sourceDirectoryDefault,
} = {}) {
  assertInstallMutationSupported(platform);
  await assertNodeRuntimeExecutable(nodeExecutable);
  const paths = resolvePersonalChromeHostPaths(projectRoot);
  const record = await readPersonalChromePairingRecord(paths.pairingRecordPath);
  const artifactDirectory = join(paths.artifactsDirectory, record.artifactDigest.slice('sha512:'.length));
  const artifactEntrypoint = join(artifactDirectory, 'native-host-cli.mjs');
  if ((await digestInstalledNativeHostArtifactDirectory(artifactDirectory)) !== record.artifactDigest) {
    throw new Error('installed native host artifact digest mismatch');
  }
  const plan = buildNativeHostInstallPlan({
    platform,
    homeDirectory,
    localAppData,
    userDataDirectory,
    extensionId: record.extensionId,
    nativeHostPath: paths.launcherPath,
  });
  const manifest = await readManifest(plan.manifestPath);
  if (JSON.stringify(manifest) !== JSON.stringify(plan.manifest))
    throw new Error('native host manifest does not match pairing');
  const launcherMetadata = await stat(paths.launcherPath);
  if (!launcherMetadata.isFile()) throw new Error('native host launcher must be a regular file');
  if (platform !== 'win32' && (launcherMetadata.mode & 0o111) === 0) {
    throw new Error('native host launcher must be executable');
  }
  const expectedLauncher = renderNativeHostLauncher({
    nodeExecutable,
    artifactEntrypoint,
    pairingRecordPath: paths.pairingRecordPath,
  });
  if ((await readFile(paths.launcherPath, 'utf8')) !== expectedLauncher) {
    throw new Error('native host launcher does not match installed runtime');
  }
  const receipt = installationReceipt({
    operation: 'inspect',
    paths,
    manifestPath: plan.manifestPath,
    record,
    artifactEntrypoint,
  });
  const expectedArtifactDigest = await digestNativeHostArtifactDirectory(sourceDirectory);
  if (record.artifactDigest !== expectedArtifactDigest) {
    throw new PersonalChromeNativeHostInstallationError(
      'NATIVE_HOST_ARTIFACT_STALE',
      'installed native host artifact is intact but does not match the current runtime artifact',
      { ...receipt, status: 'stale', expectedArtifactDigest },
    );
  }
  return receipt;
}

async function assertManifestOwnedOrAbsent(manifestPath, launcherPath) {
  if (!(await pathExists(manifestPath))) return;
  const manifest = await readManifest(manifestPath);
  if (manifest?.name !== PERSONAL_CHROME_NATIVE_HOST_NAME || manifest?.path !== launcherPath) {
    throw new Error('refusing to overwrite a Native Messaging manifest not owned by this installation');
  }
}

async function inspectOptionalInstallation(options) {
  try {
    return await inspectNativeHostInstallation(options);
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined;
    // A prior process may have stopped between activation-file writes. The
    // canonical pairing record remains the last committed generation, so the
    // next explicit install is allowed to repair launcher/manifest around it.
    return undefined;
  }
}

async function readOptionalPairingRecord(pairingRecordPath) {
  try {
    return await readPersonalChromePairingRecord(pairingRecordPath);
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined;
    throw error;
  }
}

async function commitActivationGeneration({ paths, plan, launcherSource, record, writePairingRecord }) {
  const launcherSnapshot = await readOptionalFileSnapshot(paths.launcherPath);
  const manifestSnapshot = await readOptionalFileSnapshot(plan.manifestPath);
  try {
    await writeAtomicFile(paths.launcherPath, launcherSource, 0o700);
    await writeAtomicFile(plan.manifestPath, `${JSON.stringify(plan.manifest, null, 2)}\n`, 0o600);
    await writePairingRecord(paths.pairingRecordPath, record);
  } catch (error) {
    const rollbackErrors = [];
    await restoreFileSnapshot(paths.launcherPath, launcherSnapshot).catch((rollbackError) =>
      rollbackErrors.push(rollbackError),
    );
    await restoreFileSnapshot(plan.manifestPath, manifestSnapshot).catch((rollbackError) =>
      rollbackErrors.push(rollbackError),
    );
    if (rollbackErrors.length > 0) {
      throw new AggregateError(
        [error, ...rollbackErrors],
        'native host install failed and activation rollback was incomplete',
      );
    }
    throw error;
  }
}

async function installNativeHostLocked({
  platform = process.platform,
  projectRoot,
  homeDirectory = homedir(),
  localAppData = process.env.LOCALAPPDATA,
  userDataDirectory,
  extensionId,
  sourceDirectory = sourceDirectoryDefault,
  now = () => new Date(),
  generatePairingSecret = () => randomBytes(32).toString('base64url'),
  writePairingRecord = writePersonalChromePairingRecordAtomic,
  nodeExecutable = process.execPath,
  paths,
}) {
  requireExact(extensionId, 'extensionId');
  if (!CHROME_EXTENSION_ID.test(extensionId)) throw new Error('extensionId must be a 32-character Chrome extension ID');
  await assertNodeRuntimeExecutable(nodeExecutable);
  const existingManifestLocation = manifestLocation({ platform, homeDirectory, localAppData, userDataDirectory });
  await assertManifestOwnedOrAbsent(existingManifestLocation.manifestPath, paths.launcherPath);
  const previousRecord = await readOptionalPairingRecord(paths.pairingRecordPath);
  if (previousRecord && previousRecord.extensionId !== extensionId) {
    throw new Error('installed extension identity is immutable; uninstall before changing extension ID');
  }
  const artifact = await publishNativeHostArtifact(sourceDirectory, paths.artifactsDirectory);
  const existing = await inspectOptionalInstallation({
    platform,
    projectRoot,
    homeDirectory,
    localAppData,
    userDataDirectory,
    nodeExecutable,
    sourceDirectory,
  });
  if (existing && existing.extensionId === extensionId && existing.artifactDigest === artifact.artifactDigest) {
    return { ...existing, operation: 'unchanged' };
  }

  const timestamp = now().toISOString();
  const record = {
    schemaVersion: 1,
    extensionId,
    socketPath: paths.socketPath,
    ledgerPath: paths.ledgerPath,
    pairingSecret: previousRecord?.pairingSecret ?? generatePairingSecret(),
    artifactDigest: artifact.artifactDigest,
    installedAt: previousRecord?.installedAt ?? timestamp,
    updatedAt: timestamp,
  };
  const launcherSource = renderNativeHostLauncher({
    nodeExecutable,
    artifactEntrypoint: artifact.artifactEntrypoint,
    pairingRecordPath: paths.pairingRecordPath,
  });
  const plan = buildNativeHostInstallPlan({
    platform,
    homeDirectory,
    localAppData,
    userDataDirectory,
    extensionId,
    nativeHostPath: paths.launcherPath,
  });
  await commitActivationGeneration({ paths, plan, launcherSource, record, writePairingRecord });
  return installationReceipt({
    operation: previousRecord ? 'repaired' : 'installed',
    paths,
    manifestPath: plan.manifestPath,
    record,
    artifactEntrypoint: artifact.artifactEntrypoint,
  });
}

async function runInstallationMutation(paths, platform, operation) {
  await mkdir(paths.rootDirectory, { recursive: true, mode: 0o700 });
  if (platform !== 'win32') await chmod(paths.rootDirectory, 0o700);
  const lease = await acquireProcessLease(join(paths.rootDirectory, 'install'), {
    label: 'native host installation',
  });
  try {
    return await operation();
  } finally {
    await lease.release();
  }
}

export async function installNativeHost(options = {}) {
  const { platform = process.platform } = options;
  assertInstallMutationSupported(platform);
  const paths = resolvePersonalChromeHostPaths(options.projectRoot);
  return runInstallationMutation(paths, platform, () => installNativeHostLocked({ ...options, platform, paths }));
}

/** Refresh an existing generation only. No home/Chrome registration path is accepted. */
export async function republishNativeHost({
  dataDirectory,
  sourceDirectory = sourceDirectoryDefault,
  nodeExecutable = process.execPath,
  now = () => new Date(),
  writePairingRecord = writePersonalChromePairingRecordAtomic,
  activate = (publish) => publish(),
} = {}) {
  requireExact(dataDirectory, 'dataDirectory');
  if (!isAbsolute(dataDirectory)) throw new Error('dataDirectory must be absolute');
  const root = await lstat(dataDirectory).catch((error) => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
  if (!root) return { operation: 'not_installed' };
  if (!root.isDirectory() || root.isSymbolicLink()) throw new Error('data directory must be a regular directory');
  const paths = {
    rootDirectory: dataDirectory,
    artifactsDirectory: join(dataDirectory, 'artifacts'),
    pairingRecordPath: join(dataDirectory, 'pairing.json'),
    launcherPath: join(dataDirectory, 'native-host-launcher.mjs'),
  };
  // The activation callback composes extension publication with this helper mutation
  // under one installer lease. It must await publication before committing its backup.
  return runInstallationMutation(paths, process.platform, () => activate(async () => {
    const previous = await readOptionalPairingRecord(paths.pairingRecordPath);
    if (!previous) return { operation: 'not_installed' };
    assertInstallMutationSupported(process.platform);
    // Refuse linked destinations before publish/chmod can follow them outside the grant.
    const artifacts = await lstat(paths.artifactsDirectory);
    const launcher = await lstat(paths.launcherPath);
    if (!artifacts.isDirectory() || artifacts.isSymbolicLink()) throw new Error('artifacts must be a regular directory');
    if (!launcher.isFile() || launcher.isSymbolicLink()) throw new Error('launcher must be a regular file');
    const digest = await digestNativeHostArtifactDirectory(sourceDirectory);
    if (previous.artifactDigest === digest) return { operation: 'unchanged', artifactDigest: digest };
    await assertNodeRuntimeExecutable(nodeExecutable);
    const launcherSnapshot = await readOptionalFileSnapshot(paths.launcherPath);
    const pairingSnapshot = await readOptionalFileSnapshot(paths.pairingRecordPath);
    const artifact = await publishNativeHostArtifact(sourceDirectory, paths.artifactsDirectory);
    const launcherSource = renderNativeHostLauncher({
      nodeExecutable, artifactEntrypoint: artifact.artifactEntrypoint, pairingRecordPath: paths.pairingRecordPath,
    });
    try {
      await writeAtomicFile(paths.launcherPath, launcherSource, 0o700);
      await writePairingRecord(paths.pairingRecordPath, {
        ...previous, artifactDigest: artifact.artifactDigest, updatedAt: now().toISOString(),
      });
    } catch (error) {
      // Immutable artifacts may remain cached; only this activation pair selects a generation.
      const restored = await Promise.allSettled([
        restoreFileSnapshot(paths.launcherPath, launcherSnapshot),
        restoreFileSnapshot(paths.pairingRecordPath, pairingSnapshot),
      ]);
      const failed = restored.filter((item) => item.status === 'rejected').map((item) => item.reason);
      if (failed.length) throw new AggregateError([error, ...failed], 'native host republish rollback incomplete');
      throw error;
    }
    return { operation: 'republished', artifactDigest: artifact.artifactDigest };
  }));
}
async function uninstallNativeHostLocked({
  platform = process.platform,
  homeDirectory = homedir(),
  localAppData = process.env.LOCALAPPDATA,
  userDataDirectory,
  retainAuthorizations = false,
  paths,
}) {
  const location = manifestLocation({ platform, homeDirectory, localAppData, userDataDirectory });
  if (await pathExists(location.manifestPath)) {
    const manifest = await readManifest(location.manifestPath);
    if (manifest?.name !== PERSONAL_CHROME_NATIVE_HOST_NAME || manifest?.path !== paths.launcherPath) {
      throw new Error('refusing to remove a Native Messaging manifest not owned by this installation');
    }
    await unlink(location.manifestPath);
  }
  await unlink(paths.pairingRecordPath).catch((error) => {
    if (error?.code !== 'ENOENT') throw error;
  });
  await unlink(paths.launcherPath).catch((error) => {
    if (error?.code !== 'ENOENT') throw error;
  });
  if (!retainAuthorizations) await removePersonalChromeConversationAuthorizations(paths.conversationBindingPath);
  return {
    status: 'absent',
    operation: 'uninstalled',
    rootDirectory: paths.rootDirectory,
    manifestPath: location.manifestPath,
    pairingRecordPath: paths.pairingRecordPath,
    launcherPath: paths.launcherPath,
    ledgerRetained: await pathExists(paths.ledgerPath),
    conversationBindingRemoved: !(await pathExists(paths.conversationBindingPath)),
  };
}
export async function uninstallNativeHost(options = {}) {
  const { platform = process.platform } = options;
  assertInstallMutationSupported(platform);
  const paths = resolvePersonalChromeHostPaths(options.projectRoot);
  const socketLease = options.socketLease ?? await acquireInactiveSocketLease(paths.socketPath);
  assertInactiveSocketLeaseHeld(socketLease, paths.socketPath);
  try {
    return await runInstallationMutation(paths, platform, () => uninstallNativeHostLocked({ ...options, platform, paths }));
  } finally {
    if (!options.socketLease) await socketLease.release();
  }
}
function argumentValue(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    const plan = buildNativeHostInstallPlan({
      platform: process.platform,
      homeDirectory: homedir(),
      localAppData: process.env.LOCALAPPDATA,
      extensionId: argumentValue('--extension-id'),
      nativeHostPath: argumentValue('--host-path'),
    });
    process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`native host install plan failed: ${error instanceof Error ? error.message : 'unknown'}\n`);
    process.exitCode = 1;
  }
}
