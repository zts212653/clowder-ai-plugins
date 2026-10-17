import { MAX_TABS, parseModelPage } from '../runtime/contract.mjs';

export async function applyBrowserAuthorization(
  message,
  chromeApi,
  foreground,
) {
  async function revokeWorkspace() {
    const { workspaceGrant } =
      await chromeApi.storage.local.get('workspaceGrant');
    if (workspaceGrant) {
      // This tab was created by the explicit generation grant, never a pre-existing owner tab.
      // Closing it stops outstanding injected work before revocation is acknowledged.
      const tabs = await chromeApi.tabs.query({});
      if (tabs.some((tab) => tab.id === workspaceGrant.tabId))
        await chromeApi.tabs.remove(workspaceGrant.tabId);
    }
    await chromeApi.storage.local.remove('workspaceGrant');
  }

  if (message?.op === 'grant') {
    if (
      !(await chromeApi.permissions.contains({
        origins: ['https://studio.tripo3d.ai/*'],
      }))
    )
      throw new Error('CHROME_PERMISSION_REQUIRED');
    const tabs = await chromeApi.tabs.query({
      url: 'https://studio.tripo3d.ai/3d-model/*',
    });
    const batch = tabs.flatMap((tab) => {
      try {
        return [{ tabId: tab.id, ...parseModelPage(tab.url) }];
      } catch {
        return [];
      }
    });
    if (!batch.length || batch.length > MAX_TABS)
      throw new Error('OPEN_1_TO_8_MODEL_PAGES');
    await chromeApi.storage.local.set({ grants: batch, lastRead: null });
  } else if (message?.op === 'grant-workspace') {
    if (
      !(await chromeApi.permissions.contains({
        origins: ['https://studio.tripo3d.ai/*'],
        permissions: ['downloads'],
      }))
    )
      throw new Error('CHROME_PERMISSION_REQUIRED');
    await revokeWorkspace();
    const before = await foreground(chromeApi);
    const tab = await chromeApi.tabs.create({
      url: 'https://studio.tripo3d.ai/workspace/generate',
      active: false,
    });
    await chromeApi.storage.local.set({
      workspaceGrant: {
        tabId: tab.id,
        authority: crypto.randomUUID(),
        grantedAt: new Date().toISOString(),
      },
    });
    const after = await foreground(chromeApi);
    if (JSON.stringify(before) !== JSON.stringify(after))
      throw new Error('FOREGROUND_CHANGED');
  } else if (message?.op === 'downgrade') {
    await revokeWorkspace();
  } else if (message?.op === 'revoke') {
    await revokeWorkspace();
    await chromeApi.storage.local.remove(['grants', 'lastRead']);
    await chromeApi.permissions.remove({
      origins: ['https://studio.tripo3d.ai/*'],
      permissions: ['downloads'],
    });
  } else if (message?.op !== 'status') throw new Error('INVALID_OPERATION');
}
