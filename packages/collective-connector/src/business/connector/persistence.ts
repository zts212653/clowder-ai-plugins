import { randomUUID } from 'node:crypto';
import { type BigIntStats, constants } from 'node:fs';
import { lstat, mkdir, open, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { syncDirectory } from '../../directory-durability.js';
import { establishPrivateDirectoryAccess, type PrivatePathBoundary } from '../../private-path-access.js';
import {
  type ConnectorState,
  type MutableConnectorState,
  migrateConnectorState,
  parseConnectorState,
} from './state.js';

export const CONNECTOR_STATE_FILE = 'collective-connector.json';

export class ConnectorPersistence {
  readonly filePath: string;
  #state: ConnectorState;
  readonly #privatePath: PrivatePathBoundary;
  #tail: Promise<void> = Promise.resolve();

  private constructor(filePath: string, state: ConnectorState, privatePath: PrivatePathBoundary) {
    this.filePath = filePath;
    this.#state = state;
    this.#privatePath = privatePath;
  }

  static async open(dataDirectory: string): Promise<ConnectorPersistence> {
    const filePath = join(dataDirectory, CONNECTOR_STATE_FILE);
    await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
    const privatePath = await establishPrivateDirectoryAccess(dataDirectory);
    await assertPrivateDirectory(dataDirectory, privatePath);
    try {
      const contents = await readPrivateRegularFile(filePath, privatePath);
      const raw = JSON.parse(contents.toString('utf8')) as unknown;
      const state = structuredClone(migrateConnectorState(raw)) as MutableConnectorState;
      const normalized = !isDeepStrictEqual(raw, state);
      let recovered = false;
      for (const connection of Object.values(state.connections)) {
        for (const attempt of connection.localAttempts ?? []) {
          if (attempt.status !== 'entered') continue;
          attempt.status = 'held';
          attempt.effect = 'unknown';
          attempt.proof = 'unresolved';
          attempt.reason = 'LOCAL_ATTEMPT_INTERRUPTED';
          attempt.revision++;
          attempt.updatedAt = new Date().toISOString();
          recovered = true;
        }
      }
      const persistence = new ConnectorPersistence(filePath, state, privatePath);
      if (recovered || normalized) await persistence.write(state);
      return persistence;
    } catch (error) {
      if (!isMissingFile(error)) throw error;
      const persistence = new ConnectorPersistence(
        filePath,
        {
          schemaVersion: 3,
          connections: {},
          legacyConnections: [],
          hostRoutes: {},
        },
        privatePath,
      );
      await persistence.write(persistence.#state);
      return persistence;
    }
  }

  snapshot(): ConnectorState {
    return structuredClone(this.#state);
  }

  async transaction<T>(
    mutate: (draft: MutableConnectorState) => T,
    assertCurrent?: () => Promise<void>,
  ): Promise<T> {
    let release: (() => void) | undefined;
    const previous = this.#tail;
    this.#tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      await assertCurrent?.();
      if (
        Object.values(this.#state.connections).some((connection) => connection.localAttempts?.length) &&
        !(await this.backingFileMatches(serializeState(this.#state)))
      )
        throw Object.assign(new Error('Local recovery state changed; reopen before another transition'), {
          code: 'COLLECTIVE_STATE_STALE',
        });
      const draft = structuredClone(this.#state) as MutableConnectorState;
      const result = mutate(draft);
      const validated = parseConnectorState(draft);
      const serialized = serializeState(validated);
      if (serialized !== serializeState(this.#state) || !(await this.backingFileMatches(serialized)))
        await this.write(validated, assertCurrent);
      this.#state = validated;
      return result;
    } finally {
      release?.();
    }
  }

  private async backingFileMatches(serialized: string): Promise<boolean> {
    const directory = dirname(this.filePath);
    await assertPrivateDirectory(directory, this.#privatePath);
    try {
      const bytes = await readPrivateRegularFile(this.filePath, this.#privatePath);
      await assertPrivateDirectory(directory, this.#privatePath);
      return bytes.equals(Buffer.from(serialized, 'utf8'));
    } catch (error) {
      if (isMissingFile(error)) return false;
      throw error;
    }
  }

  private async write(state: ConnectorState, assertCurrent?: () => Promise<void>): Promise<void> {
    await writePrivateDocument(this.filePath, serializeState(state), this.#privatePath, assertCurrent);
  }
}

async function writePrivateDocument(
  filePath: string,
  serialized: string,
  privatePath: PrivatePathBoundary,
  assertCurrent?: () => Promise<void>,
): Promise<void> {
  await assertPrivateDirectory(dirname(filePath), privatePath);
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temporaryPath, 'wx', 0o600);
  try {
    await handle.writeFile(serialized, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await assertCurrent?.();
    await rename(temporaryPath, filePath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
  await syncDirectory(dirname(filePath));
}

function serializeState(state: ConnectorState): string {
  return `${JSON.stringify(state, null, 2)}\n`;
}

async function assertPrivateDirectory(path: string, privatePath: PrivatePathBoundary): Promise<void> {
  const metadata = await lstat(path);
  if (!metadata.isDirectory()) {
    throw new Error(`Collective Connector data directory must be a private regular directory`);
  }
  privatePath.assertMetadata(metadata, {
    owner: 'Collective Connector private state must be owned by the current user',
    mode: 'Collective Connector data directory permissions must be private (mode 0700)',
  });
}

function assertPrivateRegularFile(metadata: BigIntStats, privatePath: PrivatePathBoundary): void {
  if (!metadata.isFile())
    throw new Error(`Collective Connector credential state must be a private regular file`);
  privatePath.assertMetadata(metadata, {
    owner: 'Collective Connector private state must be owned by the current user',
    mode: 'Collective Connector credential state permissions must be private (mode 0600)',
  });
}

function sameFile(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

async function readPrivateRegularFile(path: string, privatePath: PrivatePathBoundary): Promise<Buffer> {
  const pathMetadata = await lstat(path, { bigint: true });
  assertPrivateRegularFile(pathMetadata, privatePath);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat({ bigint: true });
    assertPrivateRegularFile(before, privatePath);
    if (!sameFile(pathMetadata, before))
      throw new Error('Collective Connector private file changed before read');
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    const canonical = await lstat(path, { bigint: true });
    assertPrivateRegularFile(after, privatePath);
    assertPrivateRegularFile(canonical, privatePath);
    if (!sameFile(before, after) || !sameFile(after, canonical) || BigInt(bytes.length) !== after.size)
      throw new Error('Collective Connector private file changed during read');
    return bytes;
  } finally {
    await handle.close();
  }
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: string }).code === 'ENOENT'
  );
}
