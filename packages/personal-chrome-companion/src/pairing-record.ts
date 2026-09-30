import { lstat, readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

import {
  PersonalChromeHostAdapter,
  type PersonalChromeHostAdapterOptions,
  PersonalChromeHostError,
} from './personal-chrome-host-transport.js';

export const PERSONAL_CHROME_PAIRING_RECORD_FILE = 'pairing.json' as const;

interface PersistedPersonalChromePairingRecord {
  readonly schemaVersion: 1;
  readonly extensionId: string;
  readonly socketPath: string;
  readonly ledgerPath: string;
  readonly pairingSecret: string;
  readonly artifactDigest: string;
  readonly installedAt: string;
  readonly updatedAt: string;
}

const PAIRING_RECORD_FIELDS = new Set([
  'schemaVersion',
  'extensionId',
  'socketPath',
  'ledgerPath',
  'pairingSecret',
  'artifactDigest',
  'installedAt',
  'updatedAt',
]);
const MAX_PAIRING_RECORD_BYTES = 16 * 1024;

function isCanonicalIsoTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function parsePersistedPairingRecord(value: unknown): PersistedPersonalChromePairingRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new PersonalChromeHostError('INVALID_CONFIGURATION', 'pairing record must be an object');
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((field) => !PAIRING_RECORD_FIELDS.has(field))) {
    throw new PersonalChromeHostError('INVALID_CONFIGURATION', 'pairing record contains an unknown field');
  }
  if (
    Object.keys(record).length !== PAIRING_RECORD_FIELDS.size ||
    record.schemaVersion !== 1 ||
    typeof record.extensionId !== 'string' ||
    !/^[a-p]{32}$/.test(record.extensionId) ||
    typeof record.socketPath !== 'string' ||
    !isAbsolute(record.socketPath) ||
    typeof record.ledgerPath !== 'string' ||
    !isAbsolute(record.ledgerPath) ||
    typeof record.pairingSecret !== 'string' ||
    !/^[A-Za-z0-9_-]{43,512}$/.test(record.pairingSecret) ||
    typeof record.artifactDigest !== 'string' ||
    !/^sha512:[a-f0-9]{128}$/.test(record.artifactDigest) ||
    !isCanonicalIsoTimestamp(record.installedAt) ||
    !isCanonicalIsoTimestamp(record.updatedAt)
  ) {
    throw new PersonalChromeHostError('INVALID_CONFIGURATION', 'pairing record failed validation');
  }
  return record as unknown as PersistedPersonalChromePairingRecord;
}

/**
 * Reads the pairing record the install-host CLI wrote into the granted data
 * directory. This package never falls back to projectRoot or env: the data
 * directory is the single source of socket path, pairing secret, and helper
 * artifact revision (contract h2, installation attribution A).
 */
export async function readPersonalChromeAdapterOptions(
  dataDirectory: string,
): Promise<PersonalChromeHostAdapterOptions> {
  const pairingRecordPath = join(dataDirectory, PERSONAL_CHROME_PAIRING_RECORD_FILE);
  const metadata = await lstat(pairingRecordPath);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new PersonalChromeHostError('INVALID_CONFIGURATION', 'pairing record must be a regular file');
  }
  if (process.platform !== 'win32' && (metadata.mode & 0o777) !== 0o600) {
    throw new PersonalChromeHostError('INVALID_CONFIGURATION', 'pairing record must have mode 0600');
  }
  if (metadata.size > MAX_PAIRING_RECORD_BYTES) {
    throw new PersonalChromeHostError('INVALID_CONFIGURATION', 'pairing record exceeds size limit');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(pairingRecordPath, 'utf8'));
  } catch (error) {
    throw new PersonalChromeHostError(
      'INVALID_CONFIGURATION',
      `pairing record is unreadable: ${error instanceof Error ? error.name : 'unknown'}`,
    );
  }
  const record = parsePersistedPairingRecord(parsed);
  return {
    socketPath: record.socketPath,
    pairingSecret: record.pairingSecret,
    helperArtifactRevision: record.artifactDigest,
  };
}

export function isPersonalChromeNotInstalled(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT';
}

export function createPersonalChromeHostAdapter(
  options: PersonalChromeHostAdapterOptions,
): PersonalChromeHostAdapter {
  return new PersonalChromeHostAdapter(options);
}
