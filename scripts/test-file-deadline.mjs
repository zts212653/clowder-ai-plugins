// Node's per-test timeout does not cover handles left after a test has
// already failed. Run this preload in each isolated test FILE process.
// A successful, quiescent file exits naturally; only a file still alive at
// the deadline is terminated, after naming it for the gate's diagnosis.
if (process.env.NODE_TEST_CONTEXT === 'child-v8') {
  const timeoutMs = Number(process.env.CLOWDER_TEST_FILE_TIMEOUT_MS ?? 60_000);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 60_000) {
    throw new RangeError('test file deadline must be between 1 and 60000ms');
  }
  setTimeout(() => {
    process.stderr.write(`Test file deadline exceeded (${timeoutMs}ms): ${process.argv[1]}\n`);
    process.exit(1);
  }, timeoutMs).unref();
}
