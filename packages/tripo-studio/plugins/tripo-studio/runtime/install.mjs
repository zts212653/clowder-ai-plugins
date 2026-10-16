import { createHash, randomBytes } from 'node:crypto';
import { chmod, cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  readPersonalChromePairingRecord,
  writePersonalChromePairingRecordAtomic,
} from '../../cloud-cat-personal-host/native-host/pairing-record.mjs';
import { artifactDigest, SHARED_FILES } from './artifact-digest.mjs';
import { HOST_NAME, VERSION } from './contract.mjs';
import { pluginPaths } from './paths.mjs';

const SOURCE = fileURLToPath(new URL('../', import.meta.url));
const quote = (value) => `'${value.replaceAll("'", `'"'"'`)}'`;
export function extensionIdFromKey(key) {
  return createHash('sha256')
    .update(Buffer.from(key, 'base64'))
    .digest('hex')
    .slice(0, 32)
    .replace(/[0-9a-f]/g, (ch) => String.fromCharCode(97 + Number.parseInt(ch, 16)));
}
export async function prepareHelper({
  home = homedir(),
  platform = process.platform,
  source = SOURCE,
  nodeExecutable = process.execPath,
  signal,
} = {}) {
  signal?.throwIfAborted();
  if (!['darwin', 'linux'].includes(platform)) throw new Error('UNSUPPORTED_PLATFORM');
  const paths = pluginPaths(home);
  const manifestBytes = await readFile(join(source, 'manifest.json'));
  const extensionManifest = JSON.parse(manifestBytes);
  const extensionId = extensionIdFromKey(extensionManifest.key);
  const digest = await artifactDigest(source);
  let previous;
  try {
    previous = await readPersonalChromePairingRecord(paths.record);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  signal?.throwIfAborted();
  const artifactRoot = join(paths.versions, `${VERSION}-${digest.slice(0, 16)}`);
  const target = join(artifactRoot, 'tripo-studio');
  await mkdir(paths.root, { recursive: true, mode: 0o700 });
  await chmod(paths.root, 0o700);
  await mkdir(artifactRoot, { recursive: true, mode: 0o700 });
  await cp(source, target, {
    recursive: true,
    dereference: false,
    filter: (entry) => !entry.includes('/node_modules/'),
  });
  signal?.throwIfAborted();
  const sharedTarget = join(artifactRoot, 'cloud-cat-personal-host/native-host');
  await mkdir(sharedTarget, { recursive: true, mode: 0o700 });
  for (const file of SHARED_FILES)
    await cp(join(source, '../cloud-cat-personal-host/native-host', file), join(sharedTarget, file));
  signal?.throwIfAborted();
  const launcher = join(paths.root, 'native-host.sh');
  await writeFile(
    launcher,
    `#!/bin/sh\nexec ${quote(nodeExecutable)} ${quote(join(target, 'runtime/native-host.mjs'))} --pairing-record ${quote(paths.record)}\n`,
    { mode: 0o700 },
  );
  await chmod(launcher, 0o700);
  if ((await artifactDigest(target)) !== digest) throw new Error('INSTALLED_ARTIFACT_DIGEST_MISMATCH');
  signal?.throwIfAborted();
  const now = new Date().toISOString();
  await writePersonalChromePairingRecordAtomic(paths.record, {
    schemaVersion: 1,
    extensionId,
    socketPath: paths.socket,
    ledgerPath: join(paths.root, 'provenance.json'),
    pairingSecret: previous?.pairingSecret ?? randomBytes(32).toString('base64url'),
    artifactDigest: `sha512:${digest}`,
    installedAt: previous?.installedAt ?? now,
    updatedAt: now,
  });
  const manifestDirectory =
    platform === 'darwin'
      ? join(home, 'Library/Application Support/Google/Chrome/NativeMessagingHosts')
      : join(home, '.config/google-chrome/NativeMessagingHosts');
  signal?.throwIfAborted();
  await mkdir(manifestDirectory, { recursive: true });
  await writeFile(
    join(manifestDirectory, `${HOST_NAME}.json`),
    `${JSON.stringify({ name: HOST_NAME, description: 'Cat Café Tripo Studio read-only bridge', path: launcher, type: 'stdio', allowed_origins: [`chrome-extension://${extensionId}/`] }, null, 2)}\n`,
    { mode: 0o600 },
  );
  return {
    artifact: { installed: true, version: VERSION, extensionDirectory: target, extensionId },
    auth: { status: 'requires_chrome_confirmation' },
    live: { status: 'dormant' },
    nextAction: '在 Chrome 扩展页面加载 extensionDirectory，然后在 Tripo 模型页点扩展的「授权读取 Tripo Studio」。',
  };
}
