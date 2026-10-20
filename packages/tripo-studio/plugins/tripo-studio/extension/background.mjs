import { applyBrowserAuthorization } from './browser-authorization.mjs';
import {
  HOST_NAME,
  MAX_TABS,
  parseModelPage,
  VERSION,
  validateAssetUrl,
} from '../runtime/contract.mjs';
import { workspaceSession } from './workspace-session.mjs';
import { workspaceDownloads } from './workspace-downloads.mjs';
import { readTripoPage } from './page-reader.mjs';

let port;
let busy = false;
let connected = false;
let helperVersion = null;
let lastError = 'NOT_CONNECTED';
export async function foreground(chromeApi = chrome) {
  const windows = await chromeApi.windows.getAll({ populate: true });
  return {
    focusedWindowId: windows.find((w) => w.focused)?.id ?? -1,
    activeTabs: windows
      .map((w) => ({
        windowId: w.id,
        tabId: w.tabs?.find((t) => t.active)?.id ?? -1,
      }))
      .sort((a, b) => a.windowId - b.windowId),
  };
}
const workspace = workspaceSession(
  chrome,
  foreground,
  workspaceDownloads(chrome),
);
async function grants() {
  return (await chrome.storage.local.get('grants')).grants ?? [];
}
async function inspectTabs() {
  const bound = await grants();
  if (!bound.length) throw new Error('NEEDS_AUTHORIZATION');
  if (bound.length > MAX_TABS) throw new Error('TAB_LIMIT');
  const before = await foreground();
  const observations = [];
  for (const grant of bound) {
    const tab = await chrome.tabs.get(grant.tabId);
    if (tab.url !== parseModelPage(grant.pageUrl).pageUrl)
      throw new Error('AUTHORIZED_PAGE_CHANGED');
    const results = await chrome.scripting.executeScript({
      target: { tabId: grant.tabId },
      world: 'MAIN',
      func: readTripoPage,
    });
    const observed = results[0]?.result;
    if (observed?.pageUrl !== grant.pageUrl)
      throw new Error('AUTHORIZED_PAGE_CHANGED');
    observed.resources = observed.resources.filter((value) => {
      try {
        validateAssetUrl(value);
        return true;
      } catch {
        return false;
      }
    });
    observations.push(observed);
  }
  const after = await foreground();
  if (JSON.stringify(before) !== JSON.stringify(after))
    throw new Error('FOREGROUND_CHANGED');
  if (JSON.stringify(await grants()) !== JSON.stringify(bound))
    throw new Error('AUTHORIZATION_REVOKED');
  await chrome.storage.local.set({
    lastRead: { count: observations.length, at: new Date().toISOString() },
  });
  return {
    version: VERSION,
    observations: observations.map((observation) => ({
      ...observation,
      before,
      after,
    })),
  };
}
async function runNativeOperation(op, payload) {
  if (busy) throw new Error('BUSY');
  busy = true;
  try {
    return op === 'status'
      ? {
          version: VERSION,
          authorized: (await grants()).map(({ pageUrl }) => pageUrl),
          lastRead:
            (await chrome.storage.local.get('lastRead')).lastRead ?? null,
          workspaceAuthorized: !!(
            await chrome.storage.local.get('workspaceGrant')
          ).workspaceGrant,
        }
      : op === 'workspace'
        ? { version: VERSION, ...(await workspace(payload)) }
        : await inspectTabs();
  } finally {
    busy = false;
  }
}
function connect() {
  if (port) return;
  try {
    const current = chrome.runtime.connectNative(HOST_NAME);
    port = current;
    lastError = 'HELPER_NOT_READY';
    current.onDisconnect.addListener(() => {
      connected = false;
      lastError = chrome.runtime.lastError?.message
        ? 'HELPER_UNAVAILABLE'
        : 'DISCONNECTED';
      if (port === current) port = null;
    });
    current.onMessage.addListener(async (request) => {
      if (request?.kind === 'ready') {
        helperVersion =
          typeof request.version === 'string'
            ? request.version.slice(0, 64)
            : null;
        connected = request.v === 1 && request.version === VERSION;
        lastError = connected ? null : 'HELPER_VERSION_MISMATCH';
        return;
      }
      const respond = (body) => {
        try {
          current.postMessage({ v: 1, id: request.id, ...body });
        } catch {}
      };
      if (
        request?.v !== 1 ||
        typeof request.id !== 'string' ||
        !['status', 'observe', 'workspace'].includes(request.op)
      )
        return;
      if (!connected) {
        respond({ error: lastError });
        return;
      }
      try {
        respond({
          result: await runNativeOperation(request.op, request.payload),
        });
      } catch (error) {
        respond({ error: error.message });
      }
    });
  } catch {
    lastError = 'HELPER_UNAVAILABLE';
  }
}
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  // Only the extension popup is a command source. No externally_connectable/content scripts.
  if (
    sender.id !== chrome.runtime.id ||
    !sender.url?.startsWith(chrome.runtime.getURL('extension/popup.html'))
  )
    return false;
  (async () => {
    await applyBrowserAuthorization(message, chrome, foreground);
    connect();
    return {
      connected,
      lastError,
      authorized: (await grants()).map(({ pageUrl }) => pageUrl),
      lastRead: (await chrome.storage.local.get('lastRead')).lastRead ?? null,
      lastSubmission:
        Object.entries(await chrome.storage.local.get(null))
          .filter(([key]) => key.startsWith('submission:'))
          .map(([, value]) => value)
          .sort((a, b) => b.at.localeCompare(a.at))[0] ?? null,
      version: VERSION,
      helperVersion,
      workspaceAuthorized: !!(await chrome.storage.local.get('workspaceGrant'))
        .workspaceGrant,
    };
  })().then(respond, (error) => respond({ error: error.message }));
  return true;
});
chrome.runtime.onStartup.addListener(connect);
connect();
