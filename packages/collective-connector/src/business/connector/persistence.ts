import { randomUUID } from 'node:crypto';
import { type BigIntStats, constants, type Stats } from 'node:fs';
import { lstat, mkdir, open, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import {
  workReconsiderationBindingSchema,
  type WorkReconsiderationBinding,
} from './work-reconsideration-custody.js';

import {
  type ConnectorState,
  type MutableConnectorState,
  migrateConnectorState,
  parseConnectorState,
} from './state.js';

export const CONNECTOR_STATE_FILE = 'collective-connector.json';
const RECONSIDERATION_SOURCES_FILE = 'collective-connector.reconsideration-sources.json';
const reconsiderationSourcesSchema = z
  .object({ schemaVersion: z.literal(1), bindings: z.array(workReconsiderationBindingSchema) })
  .strict();

export class ConnectorPersistence {
  readonly filePath: string;
  #state: ConnectorState;
  #tail: Promise<void> = Promise.resolve();
  #reconsiderationSources: WorkReconsiderationBinding[] = [];

  private constructor(filePath: string, state: ConnectorState) {
    this.filePath = filePath;
    this.#state = state;
  }

  static async open(dataDirectory: string): Promise<ConnectorPersistence> {
    const filePath = join(dataDirectory, CONNECTOR_STATE_FILE);
    await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
    await assertPrivateDirectory(dataDirectory);
    try {
      const contents = await readPrivateRegularFile(filePath);
      const raw = JSON.parse(contents.toString('utf8')) as unknown;
      const state = structuredClone(migrateConnectorState(raw)) as MutableConnectorState;
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
      const persistence = new ConnectorPersistence(filePath, state);
      if (recovered || schemaVersionOf(raw) !== state.schemaVersion) await persistence.write(state);
      persistence.#reconsiderationSources = await persistence.readReconsiderationSources();
      return persistence;
    } catch (error) {
      if (!isMissingFile(error)) throw error;
      const persistence = new ConnectorPersistence(filePath, {
        schemaVersion: 3,
        connections: {},
        legacyConnections: [],
        hostRoutes: {},
      });
      await persistence.write(persistence.#state);
      persistence.#reconsiderationSources = await persistence.readReconsiderationSources();
      return persistence;
    }
  }

  snapshot(): ConnectorState {
    return structuredClone(this.#state);
  }

  /** A second source-message relation uses the same private container and writer tail.
   * The retained strict v3 document stays byte-compatible with historical packages. */
  reconsiderationSources(): WorkReconsiderationBinding[] {
    return structuredClone(this.#reconsiderationSources);
  }

  async transactionReconsiderationSources<T>(
    mutate: (state: ConnectorState, bindings: WorkReconsiderationBinding[]) => T,
    assertCurrent: () => Promise<void>,
  ): Promise<T> {
    let release!: () => void;
    const previous = this.#tail;
    this.#tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      await assertCurrent();
      const current = await this.readReconsiderationSources();
      if (
        !(await this.backingFileMatches(serializeState(this.#state))) ||
        JSON.stringify(current) !== JSON.stringify(this.#reconsiderationSources)
      )
        throw Object.assign(new Error('Connector source state changed; reopen before another transition'), {
          code: 'COLLECTIVE_STATE_STALE',
        });
      const draft = structuredClone(this.#reconsiderationSources);
      const result = mutate(this.snapshot(), draft);
      const validated = reconsiderationSourcesSchema.parse({ schemaVersion: 1, bindings: draft });
      if (JSON.stringify(validated.bindings) !== JSON.stringify(this.#reconsiderationSources))
        await writePrivateDocument(
          join(dirname(this.filePath), RECONSIDERATION_SOURCES_FILE),
          JSON.stringify(validated, null, 2) + '\n',
          assertCurrent,
        );
      this.#reconsiderationSources = validated.bindings as WorkReconsiderationBinding[];
      return result;
    } finally {
      release();
    }
  }

  private async readReconsiderationSources(): Promise<WorkReconsiderationBinding[]> {
    const directory = dirname(this.filePath);
    await assertPrivateDirectory(directory);
    try {
      const raw = await readPrivateRegularFile(join(directory, RECONSIDERATION_SOURCES_FILE));
      await assertPrivateDirectory(directory);
      return reconsiderationSourcesSchema.parse(JSON.parse(raw.toString('utf8')))
        .bindings as WorkReconsiderationBinding[];
    } catch (error) {
      if (!isMissingFile(error)) throw error;
      return [];
    }
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
    await assertPrivateDirectory(directory);
    try {
      const bytes = await readPrivateRegularFile(this.filePath);
      await assertPrivateDirectory(directory);
      return bytes.equals(Buffer.from(serialized, 'utf8'));
    } catch (error) {
      if (isMissingFile(error)) return false;
      throw error;
    }
  }

  private async write(state: ConnectorState, assertCurrent?: () => Promise<void>): Promise<void> {
    await writePrivateDocument(this.filePath, serializeState(state), assertCurrent);
  }
}

async function writePrivateDocument(
  filePath: string,
  serialized: string,
  assertCurrent?: () => Promise<void>,
): Promise<void> {
  await assertPrivateDirectory(dirname(filePath));
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
  const directoryHandle = await open(dirname(filePath), 'r');
  try {
    await directoryHandle.sync();
  } finally {
    await directoryHandle.close();
  }
}

function serializeState(state: ConnectorState): string {
  return `${JSON.stringify(state, null, 2)}\n`;
}

function schemaVersionOf(value: unknown): unknown {
  if (typeof value !== 'object' || value === null || !('schemaVersion' in value)) return undefined;
  return value.schemaVersion;
}

async function assertPrivateDirectory(path: string): Promise<void> {
  const metadata = await lstat(path);
  if (!metadata.isDirectory()) {
    throw new Error(`Collective Connector data directory must be a private regular directory`);
  }
  assertOwned(metadata);
  if ((metadata.mode & 0o077) !== 0) {
    throw new Error(`Collective Connector data directory permissions must be private (mode 0700)`);
  }
}

function assertOwned(metadata: Pick<Stats | BigIntStats, 'uid'>): void {
  const uid = process.geteuid?.() ?? process.getuid?.();
  if (uid !== undefined && Number(metadata.uid) !== uid)
    throw new Error(`Collective Connector private state must be owned by the current user`);
}

function assertPrivateRegularFile(metadata: BigIntStats): void {
  if (!metadata.isFile())
    throw new Error(`Collective Connector credential state must be a private regular file`);
  assertOwned(metadata);
  if ((metadata.mode & 0o077n) !== 0n)
    throw new Error(`Collective Connector credential state permissions must be private (mode 0600)`);
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

async function readPrivateRegularFile(path: string): Promise<Buffer> {
  const pathMetadata = await lstat(path, { bigint: true });
  assertPrivateRegularFile(pathMetadata);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat({ bigint: true });
    assertPrivateRegularFile(before);
    if (!sameFile(pathMetadata, before))
      throw new Error('Collective Connector private file changed before read');
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    const canonical = await lstat(path, { bigint: true });
    assertPrivateRegularFile(after);
    assertPrivateRegularFile(canonical);
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
