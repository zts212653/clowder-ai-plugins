import process from 'node:process';

interface PrivateAccessMetadata {
  readonly mode: number | bigint;
  readonly uid: number | bigint;
}

interface PrivateAccessErrors {
  readonly owner: string;
  readonly mode: string;
}

/**
 * Enforce owner-only POSIX access without pretending that Windows mode bits are a DACL.
 *
 * The Host owns the Windows ACL boundary for the provisioned module dataPath. Node exposes
 * file type through Stats on Windows, but it does not implement owner/group/other permission
 * distinctions there. Callers must still validate file type and their no-follow/TOCTOU rules.
 */
export function assertPrivatePosixAccess(
  metadata: PrivateAccessMetadata,
  errors: PrivateAccessErrors,
  platform: NodeJS.Platform = process.platform,
): void {
  if (platform === 'win32') return;
  const uid = process.geteuid?.() ?? process.getuid?.();
  if (uid !== undefined && Number(metadata.uid) !== uid) throw new Error(errors.owner);
  const exposed =
    typeof metadata.mode === 'bigint' ? (metadata.mode & 0o077n) !== 0n : (metadata.mode & 0o077) !== 0;
  if (exposed) throw new Error(errors.mode);
}
