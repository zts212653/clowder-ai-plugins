import { lstat, readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

const RECORD_FIELDS = new Set([
  'schemaVersion',
  'extensionId',
  'socketPath',
  'ledgerPath',
  'pairingSecret',
  'artifactDigest',
  'installedAt',
  'updatedAt',
]);
const EXTENSION_ID = /^[a-p]{32}$/;
const PAIRING_SECRET = /^[A-Za-z0-9_-]{43,512}$/;
const ARTIFACT_DIGEST = /^sha512:[a-f0-9]{128}$/;
const MAX_RECORD_BYTES = 16 * 1024;

function requireExactString(value, field) {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
    throw new Error(`${field} must be a non-empty exact string`);
  }
  return value;
}

function requireAbsolutePath(value, field) {
  requireExactString(value, field);
  if (!isAbsolute(value)) throw new Error(`${field} must be absolute`);
  return value;
}

function requireIsoTimestamp(value, field) {
  requireExactString(value, field);
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new Error(`${field} must be a canonical ISO timestamp`);
  }
  return value;
}

/** Validates a record issued by the Host; this package never creates or rotates one. */
export function validatePersonalChromePairingRecord(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('pairing record must be an object');
  }
  for (const key of Object.keys(value)) {
    if (!RECORD_FIELDS.has(key)) throw new Error(`pairing record has unknown field: ${key}`);
  }
  for (const field of RECORD_FIELDS) {
    if (!Object.hasOwn(value, field)) throw new Error(`pairing record is missing field: ${field}`);
  }
  if (value.schemaVersion !== 1) throw new Error('schemaVersion must equal 1');
  if (!EXTENSION_ID.test(value.extensionId)) throw new Error('extensionId must be a Chrome extension ID');
  requireAbsolutePath(value.socketPath, 'socketPath');
  requireAbsolutePath(value.ledgerPath, 'ledgerPath');
  if (!PAIRING_SECRET.test(value.pairingSecret)) {
    throw new Error('pairingSecret must be a 256-bit-or-stronger base64url token');
  }
  if (!ARTIFACT_DIGEST.test(value.artifactDigest)) {
    throw new Error('artifactDigest must be a lowercase sha512 digest');
  }
  requireIsoTimestamp(value.installedAt, 'installedAt');
  requireIsoTimestamp(value.updatedAt, 'updatedAt');
  return {
    schemaVersion: 1,
    extensionId: value.extensionId,
    socketPath: value.socketPath,
    ledgerPath: value.ledgerPath,
    pairingSecret: value.pairingSecret,
    artifactDigest: value.artifactDigest,
    installedAt: value.installedAt,
    updatedAt: value.updatedAt,
  };
}

export async function readPersonalChromePairingRecord(path) {
  requireAbsolutePath(path, 'pairingRecordPath');
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error('pairing record must be a regular file');
  if ((metadata.mode & 0o777) !== 0o600) throw new Error('pairing record must have mode 0600');
  if (metadata.size > MAX_RECORD_BYTES) throw new Error('pairing record exceeds size limit');
  let parsed;
  try {
    parsed = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    throw new Error(`pairing record is unreadable: ${error instanceof Error ? error.message : 'unknown'}`);
  }
  return validatePersonalChromePairingRecord(parsed);
}
