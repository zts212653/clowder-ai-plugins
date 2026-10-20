import { spawn } from 'node:child_process';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CdpConnection } from './cdp-connection.mjs';

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function chromeExecutable() {
  const candidates =
    process.platform === 'darwin'
      ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
      : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
  let executable;
  for (const candidate of candidates) {
    try {
      await access(candidate);
      executable = candidate;
      break;
    } catch {}
  }
  if (!executable) throw new Error('CHROME_NOT_INSTALLED');
  return executable;
}
async function waitForPort(profile, { signal, stopped, timeoutMs }) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    if (stopped()) throw new Error('ISOLATED_BROWSER_START_FAILED');
    try {
      const port = Number((await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]);
      if (Number.isInteger(port) && port > 0 && port < 65536) return port;
    } catch {}
    await pause(100);
  }
  signal?.throwIfAborted();
  throw new Error('ISOLATED_BROWSER_START_TIMEOUT');
}
export async function launchIsolatedChrome({ executable, spawnBrowser = spawn, startupTimeoutMs = 6000, signal } = {}) {
  signal?.throwIfAborted();
  const browserExecutable = executable ?? (await chromeExecutable());
  signal?.throwIfAborted();
  const profile = await mkdtemp(join(tmpdir(), 'catcafe-tripo-'));
  if (signal?.aborted) {
    await rm(profile, { recursive: true, force: true });
    signal.throwIfAborted();
  }
  const flags = [
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-sync',
    '--remote-debugging-address=127.0.0.1',
    '--remote-debugging-port=0',
    `--user-data-dir=${profile}`,
    '--no-startup-window',
  ];
  // Own Chrome itself from spawn time; an `open -W` wrapper cannot be stopped
  // safely when startup fails before CDP reports the browser PID.
  let child;
  try {
    child = spawnBrowser(browserExecutable, process.platform === 'darwin' ? flags : ['--headless=new', ...flags], {
      stdio: 'ignore',
    });
  } catch (error) {
    await rm(profile, { recursive: true, force: true });
    throw error;
  }
  let browserControl;
  let spawnError;
  child.once('error', (error) => {
    spawnError = error;
  });
  let exited = false;
  const closed = new Promise((resolve) =>
    child.once('close', () => {
      exited = true;
      resolve();
    }),
  );
  let stopping;
  const stop = () =>
    (stopping ??= (async () => {
      if (browserControl && !signal?.aborted) await browserControl.call('Browser.close').catch(() => undefined);
      browserControl?.close();
      if (!exited) {
        child.kill('SIGTERM');
        await Promise.race([closed, pause(1000)]);
      }
      if (!exited) {
        child.kill('SIGKILL');
        await Promise.race([closed, pause(2000)]);
      }
      if (!exited) throw new Error('ISOLATED_BROWSER_CLEANUP_UNCONFIRMED');
      await rm(profile, { recursive: true, force: true });
      signal?.removeEventListener('abort', abort);
    })());
  const abort = () => {
    // This direct ChildProcess belongs exclusively to the disposable preview.
    if (!exited) child.kill('SIGKILL');
    void stop().catch(() => undefined);
  };
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  try {
    const port = await waitForPort(profile, {
      signal,
      stopped: () => spawnError || exited,
      timeoutMs: startupTimeoutMs,
    });
    const version = await (
      await fetch(`http://127.0.0.1:${port}/json/version`, {
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(5000)]) : AbortSignal.timeout(5000),
      })
    ).json();
    browserControl = await CdpConnection.open(version.webSocketDebuggerUrl, { signal });
    const { targetId } = await browserControl.call('Target.createTarget', {
      url: 'about:blank',
      background: true,
      hidden: true,
    });
    const { sessionId } = await browserControl.call('Target.attachToTarget', { targetId, flatten: true });
    const cdp = {
      call: (method, params) => browserControl.call(method, params, sessionId),
      evaluate: (expression) => browserControl.evaluate(expression, sessionId),
    };
    await cdp.call('Page.enable');
    // Virtual focus belongs only to this new private page. It keeps WebGL painting
    // while the app is hidden; it never activates a macOS window or an owner tab.
    await cdp.call('Emulation.setFocusEmulationEnabled', { enabled: true });
    await cdp.call('Emulation.setDeviceMetricsOverride', {
      width: 1200,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    });
    signal?.throwIfAborted();
    return {
      cdp,
      close: async () => {
        await stop();
      },
    };
  } catch (error) {
    await stop();
    throw error;
  }
}
