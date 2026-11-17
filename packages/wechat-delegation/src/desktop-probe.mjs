import { spawn } from 'node:child_process';

const states = new Set(['unsupported', 'not_found', 'not_running', 'multiple_instances', 'unverified_app', 'permission_required', 'logged_in_ui', 'unknown']);
export async function inspectDesktop(supervisor, owner, prompt = false) {
  const epoch = supervisor.epoch;
  const record = { controller: new AbortController(), child: null, client: null, exited: null, stopping: null };
  owner.signal.throwIfAborted(); await owner.assertCurrent();
  if (epoch !== supervisor.epoch || supervisor.desktopProbe) throw Error('本机微信检测已结束或正在进行');
  supervisor.desktopProbe = record;
  const signal = AbortSignal.any([owner.signal, record.controller.signal]);
  const current = async () => {
    signal.throwIfAborted(); await owner.assertCurrent(); signal.throwIfAborted();
    if (epoch !== supervisor.epoch) throw Error('desktop detection expired');
  };
  const abort = () => { void supervisor.stopRecord(record); };
  signal.addEventListener('abort', abort, { once: true });
  let timer;
  const run = async () => {
    const { binary, asset } = await supervisor.desktopExecutable(signal, current);
    await current();
    // Neither mode supplies a vault path or initializes account services.
    const child = spawn(binary, [prompt ? '--request-desktop-access' : '--desktop-status'],
      { env: {}, stdio: ['ignore', 'pipe', 'ignore'], shell: false });
    record.child = child;
    record.exited = new Promise(resolve => { child.once('exit', resolve); child.once('error', resolve); });
    let bytes = Buffer.alloc(0), oversized = false;
    child.stdout.on('data', chunk => {
      if (bytes.length + chunk.length > 4096) { oversized = true; abort(); }
      else bytes = Buffer.concat([bytes, chunk]);
    });
    const output = new Promise(resolve => child.once('close', code => resolve(code)));
    timer = setTimeout(abort, 15000); timer.unref();
    const code = await output;
    await current();
    if (code !== 0 || oversized) throw Error('desktop probe unavailable');
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    const keys = ['product', 'version', 'pid', 'probe', 'state', 'appVersion'];
    if (!value || Object.keys(value).length !== keys.length || Object.keys(value).some(k => !keys.includes(k)) ||
      value.product !== 'clowder-wechat-desktop' || value.version !== asset.version || value.pid !== child.pid ||
      value.probe !== 'desktop-wechat' || !states.has(value.state) ||
      value.appVersion !== null && (typeof value.appVersion !== 'string' || value.appVersion.length > 31 || !/^\d+(?:\.\d+){1,3}$/.test(value.appVersion))) throw Error('invalid desktop result');
    return { state: value.state, appVersion: value.appVersion, observedAt: Date.now() };
  };
  const pending = run(); record.pending = pending;
  try { return await pending; }
  catch { throw Error('未能确认本机微信状态；请重新检查。'); }
  finally {
    clearTimeout(timer); signal.removeEventListener('abort', abort);
    await supervisor.stopRecord(record);
    if (supervisor.desktopProbe === record) supervisor.desktopProbe = null;
  }
}
