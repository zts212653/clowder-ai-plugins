// pnpm's bundled-dependency pack path delegates gzip framing to the host
// platform. The deflate stream and tar payload are stable, but byte 9 (the
// gzip OS field) is 3 on the Ubuntu release runner and 19 on macOS. Normalize
// that informational byte to the release runner's value before hashing or
// publishing so one fixed toolchain has one immutable package identity.
export function normalizeBundledPublishGzip(bytes) {
  if (
    !Buffer.isBuffer(bytes) ||
    bytes.length < 10 ||
    bytes[0] !== 0x1f ||
    bytes[1] !== 0x8b ||
    bytes[2] !== 0x08
  ) {
    throw new Error('bundled publish artifact is not a gzip archive');
  }
  if ((bytes[3] & 0x02) !== 0) {
    throw new Error('bundled publish gzip has FHCRC; refusing to rewrite header');
  }
  const normalized = Buffer.from(bytes);
  normalized[9] = 3; // RFC 1952 OS=Unix, matching the Ubuntu publisher.
  return normalized;
}
