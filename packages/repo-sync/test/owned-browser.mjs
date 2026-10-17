import { createHash } from 'node:crypto';
import { appendFile, readFile } from 'node:fs/promises';
// Test-only lifecycle evidence; never print page contents, credentials or configuration.
export async function traceLifecycle(label, operation) {
  console.log(`[browser-test] ${label}: start`);
  try {
    const result = await operation();
    console.log(`[browser-test] ${label}: done`);
    return result;
  } catch (error) {
    console.error(`[browser-test] ${label}: failed (${error?.name ?? 'Error'})`);
    throw error;
  }
}

export async function launchOwnedBrowser(browserType, options = {}) {
  const server = await browserType.launchServer(options);
  const child = server.process();
  if (!child) throw new Error('Test browser server did not expose its owned child process');
  const releaseExitedPipes = () => {
    if (child.exitCode === null && child.signalCode === null) return;
    // Windows descendants can retain inherited stdio after the browser itself exits.
    // Only release this test-owned, confirmed-exited child's public Node streams.
    for (const stream of new Set([...(child.stdio ?? []), child.stdin, child.stdout, child.stderr]))
      stream?.destroy?.();
  };
  child.once('exit', releaseExitedPipes);
  releaseExitedPipes();
  let browser;
  try {
    browser = await browserType.connect(server.wsEndpoint());
  } catch (error) {
    await server.kill();
    throw error;
  }
  let closing;
  async function record(status) {
    if (!process.env.REPO_SYNC_TEST_LEDGER) return;
    const packageBytes = await readFile(new URL('../package.json', import.meta.url));
    await appendFile(
      process.env.REPO_SYNC_TEST_LEDGER,
      `${JSON.stringify({
        task: 'repo-sync PR #77',
        owner: 'Codex regression',
        component: 'test-browser',
        status,
        test: process.argv[1],
        sourceCommit: process.env.REPO_SYNC_SOURCE_COMMIT,
        sourceHash: process.env.REPO_SYNC_SOURCE_HASH,
        packageVersion: JSON.parse(packageBytes).version,
        packageHash: createHash('sha256').update(packageBytes).digest('hex'),
        executable: child.spawnfile,
        programDirectory: process.cwd(),
        dataDirectory: process.env.TEMP,
        controllerPid: process.pid,
        pid: child.pid,
        purpose: 'isolated synthetic browser acceptance',
        retention: 'evidence/data retained; owned browser exits in finally',
        time: new Date().toISOString(),
      })}\n`,
    );
  }
  await record('running');
  return {
    browser,
    processId: child.pid,
    close() {
      closing ??= (async () => {
        releaseExitedPipes();
        try {
          await traceLifecycle('owned-browser-client-close', () => browser.close());
        } finally {
          releaseExitedPipes();
          try {
            await traceLifecycle('owned-browser-server-close', () => server.close());
          } finally {
            releaseExitedPipes();
            if (child.exitCode === null && child.signalCode === null)
              await traceLifecycle('owned-browser-server-kill', () => server.kill());
          }
        }
        if (child.exitCode === null && child.signalCode === null)
          throw new Error('Owned test browser cleanup returned before its process exited');
        await record('stopped');
      })();
      return closing;
    },
  };
}
