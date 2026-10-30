import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { constants } from 'node:fs';
import { link, mkdir, open, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createSecret } from './business/service/persistence.js';
import { syncDirectory } from './directory-durability.js';
import { establishPrivateDirectoryAccess, type PrivatePathBoundary } from './private-path-access.js';

/** Constructed only from authenticated Host native context, never tool input.
 * This identifies a business reference; it is not a Host Task admission receipt. */
export interface CollectiveReferenceIdentity {
  readonly pluginInstanceId: string;
  readonly invocationId: string;
}
export interface CollectiveContextReferences {
  opaqueRef(auth: CollectiveReferenceIdentity, operation: string, sourceRef: string): string;
  verifyRef(auth: CollectiveReferenceIdentity, actual: string, operation: string, sourceRef: string): void;
}

function opaqueRef(key: string, auth: CollectiveReferenceIdentity, operation: string, sourceRef: string): string {
  return createHmac('sha256', key)
    .update(JSON.stringify([auth.pluginInstanceId, auth.invocationId, operation, sourceRef]))
    .digest('base64url');
}

function verifyRef(key: string, auth: CollectiveReferenceIdentity, actual: string, operation: string, sourceRef: string) {
  const expected = Buffer.from(opaqueRef(key, auth, operation, sourceRef));
  const received = Buffer.from(actual);
  if (received.length !== expected.length || !timingSafeEqual(expected, received))
    throw collectiveContextError(
      'RETURN_REF_INVALID',
      'This reference does not belong to the current invocation and source',
    );
}

export function collectiveContextError(code: string, message: string) {
  return Object.assign(new Error(message), { code });
}

async function readKey(path: string, privatePath: PrivatePathBoundary): Promise<string> {
  // Nonblocking open reaches the fd type check even when corrupt state is a FIFO with no writer.
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size < 1 || stat.size > 64)
      throw new Error('Collective native reference key is invalid');
    privatePath.assertMetadata(stat, {
      owner: 'Collective native reference key is invalid',
      mode: 'Collective native reference key is invalid',
    });
    const key = (await file.readFile('utf8')).trim();
    if (!/^[A-Za-z0-9_-]{43}$/.test(key) || Buffer.from(key, 'base64url').toString('base64url') !== key)
      throw new Error('Collective native reference key is invalid');
    return key;
  } finally { await file.close(); }
}

/** Fixed file under the existing Host-provisioned instance-private data directory.
 * Complete private bytes are linked atomically without replacing another initializer's winner.
 * Invalid existing state is refused, never regenerated. No Host callback secret is read or exposed. */
export async function openCollectiveContextReferences(
  dataDirectory: string,
  assertActive: () => void,
): Promise<CollectiveContextReferences> {
  assertActive();
  await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
  const privatePath = await establishPrivateDirectoryAccess(dataDirectory);
  assertActive();
  const path = join(dataDirectory, 'native-reference.secret');
  let key: string;
  try { key = await readKey(path, privatePath); }
  catch (error) {
    if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT') throw error;
    assertActive();
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      const file = await open(temporary, 'wx', 0o600);
      try { await file.writeFile(`${createSecret()}\n`, 'utf8'); await file.sync(); }
      finally { await file.close(); }
      assertActive();
      try { await link(temporary, path); }
      catch (error) {
        if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'EEXIST') throw error;
      }
      await syncDirectory(dataDirectory);
      assertActive();
      key = await readKey(path, privatePath);
    } finally { await rm(temporary, { force: true }); }
  }
  assertActive();
  // Keep key inside the package closure. Only opaque MACs and original refusal errors cross callers.
  return Object.freeze({
    opaqueRef(auth: CollectiveReferenceIdentity, operation: string, sourceRef: string) {
      assertActive(); return opaqueRef(key, auth, operation, sourceRef);
    },
    verifyRef(auth: CollectiveReferenceIdentity, actual: string, operation: string, sourceRef: string) {
      assertActive(); verifyRef(key, auth, actual, operation, sourceRef);
    },
  });
}
