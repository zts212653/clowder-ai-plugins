import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';
import { parse } from 'yaml';

const packageRoot = process.env.PERSONAL_CHROME_HEALTH_PACKAGE_ROOT ?? fileURLToPath(new URL('../../', import.meta.url));
const load = (path) => import(pathToFileURL(join(packageRoot, path)));
const { createNativeHostBridge } = await load('native-host/native-host.mjs');
const { installNativeHost } = await load('native-host/install-host.mjs');
const { resolvePersonalChromeHostPaths } = await load('native-host/pairing-record.mjs');
const { authorizePersonalChromeConversation } = await load('native-host/conversation-binding.mjs');
const { PersonalChromeHostAdapter } = await load('dist/personal-chrome-host-transport.js');
const { PERSONAL_CHROME_EXTENSION_REVISION, PERSONAL_CHROME_PAGE_ADAPTER_REVISION } = await load('dist/protocol.js');
const { default: entrypoint, PERSONAL_CHROME_TEST_METHOD, PERSONAL_CHROME_STATUS_METHOD } = await load('dist/plugin-entrypoint.js');

/** Actual worker, native bridge, transport and loaded Host Test; only Chrome's page port is simulated. */
export async function healthChainFixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'pro-health-chain-'));
  let activation, bridge;
  t.after(async () => {
    await activation?.stop({ reason: 'test' });
    await bridge?.stop();
    await rm(root, { recursive: true, force: true });
  });
  const manifest = JSON.parse(await readFile(join(packageRoot, 'extension/manifest.json'), 'utf8'));
  const extensionId = createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest('hex').slice(0, 32)
    .replace(/[0-9a-f]/g, (c) => String.fromCharCode(97 + parseInt(c, 16)));
  await installNativeHost({ projectRoot: root, homeDirectory: join(root, 'fake-home'),
    userDataDirectory: join(root, 'fake-chrome'), sourceDirectory: join(packageRoot, 'native-host'), extensionId, platform: 'darwin' });
  const paths = resolvePersonalChromeHostPaths(root);
  const dataPath = paths.rootDirectory;
  for (let index = 0; index < 21; index += 1) {
    await authorizePersonalChromeConversation(paths.conversationBindingPath, {
      conversationId: `conversation-${index}`,
      chatUrl: `https://chatgpt.com/c/conversation-${index}`,
      authorizedAt: '2026-10-27T00:00:00.000Z', updatedAt: '2026-10-27T00:00:00.000Z',
    });
  }
  activation = await entrypoint.create(parse(await readFile(join(packageRoot, 'plugin.yaml'), 'utf8'))).start({
    pluginInstanceId: 'health-fixture', dataPath,
    config: { get: async () => undefined }, secrets: { get: async () => undefined },
    storage: { get: async () => undefined, list: async () => ({}), set: async () => ({ revision: 1 }),
      compareAndSet: async () => ({ applied: true, revision: 1 }), delete: async () => ({ deleted: true, revision: 1 }) },
    log() {},
  });
  const pairing = JSON.parse(await readFile(paths.pairingRecordPath, 'utf8'));
  const revisions = { helper: pairing.artifactDigest, extension: PERSONAL_CHROME_EXTENSION_REVISION,
    pageAdapter: PERSONAL_CHROME_PAGE_ADAPTER_REVISION };
  const state = { tabs: [{ id: 7, url: 'https://chatgpt.com/c/conversation-7' }], pageAdapter: revisions.pageAdapter,
    ...options };
  const nativeRequests = [], tabQueries = [], contentRequests = [], revisionContacts = [];
  let nativeListener;
  const event = { addListener() {} };
  const chrome = {
    runtime: { getManifest: () => ({ version: state.extension ?? revisions.extension }), onMessage: event,
      connectNative: () => ({ onMessage: { addListener: (listener) => { nativeListener = listener; } }, onDisconnect: event,
        postMessage(message) { if (message.kind === 'health_result') void bridge.acceptNativeMessage(message); } }) },
    action: { onClicked: event, setBadgeText() {}, setTitle() {} },
    alarms: { onAlarm: event, async create() {} },
    tabs: { async query(query) { tabQueries.push(JSON.parse(JSON.stringify(query))); return state.tabs; }, async sendMessage(tabId, request) {
      contentRequests.push({ tabId, request });
      return { v: 2, kind: 'adapter_health_result', requestId: request.requestId, status: 'ready',
        observedRevisions: { ...revisions, pageAdapter: state.pageAdapter } };
    } },
    scripting: { async executeScript() {} },
  };
  vm.runInNewContext(await readFile(join(packageRoot, 'extension/service-worker.js'), 'utf8'),
    { chrome, console, URL, TextEncoder, setTimeout, clearTimeout });
  bridge = await createNativeHostBridge({ socketPath: pairing.socketPath, ledgerPath: pairing.ledgerPath,
    conversationBindingPath: paths.conversationBindingPath, pairingSecret: pairing.pairingSecret,
    helperArtifactRevision: state.helper ?? revisions.helper, sendNative: async (request) => { nativeRequests.push(request); nativeListener(request); } });
  const adapter = new PersonalChromeHostAdapter({ socketPath: pairing.socketPath, pairingSecret: pairing.pairingSecret,
    helperArtifactRevision: state.expectedHelper ?? revisions.helper,
    onRevisionContact: async (observedRevisions, errorCode) => { revisionContacts.push({ observedRevisions, errorCode }); } });
  return { root, paths, state, adapter, revisions, nativeRequests, tabQueries, contentRequests, revisionContacts,
    settings: async () => {
      const settings = await entrypoint.create(parse(await readFile(join(packageRoot, 'plugin.yaml'), 'utf8')))
        .settings({ dataPath, log() {} });
      t.after(() => settings.dispose());
      return settings.actions;
    },
    hostTest: () => activation.actions[PERSONAL_CHROME_TEST_METHOD]({}),
    pageCheckAction: () => activation.actions['personal-chrome-host.check-conversation'],
    revoke: (conversationId) => activation.actions['personal-chrome-host.authorizations.revoke']({ conversationId }),
    hostStatus: () => activation.actions[PERSONAL_CHROME_STATUS_METHOD]({}),
    fingerprint: async () => Promise.all([paths.pairingRecordPath, paths.conversationBindingPath, pairing.ledgerPath]
      .map((path) => readFile(path).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error)))),
  };
}
