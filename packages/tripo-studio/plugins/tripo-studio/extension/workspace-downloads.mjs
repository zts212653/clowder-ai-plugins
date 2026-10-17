import { validateAssetUrl } from '../runtime/contract.mjs';
const PREFIX = 'supplier-export:';
export function workspaceDownloads(chromeApi) {
  const sourceAllowed = (url) => {
    try {
      return (
        new URL(url).origin === 'https://studio.tripo3d.ai' ||
        url.startsWith('blob:https://studio.tripo3d.ai/') ||
        !!validateAssetUrl(url)
      );
    } catch {
      return false;
    }
  };
  chromeApi.downloads?.onCreated.addListener(async (item) => {
    const records = await chromeApi.storage.local.get(null);
    for (const [key, entry] of Object.entries(records)) {
      if (
        !key.startsWith(PREFIX) ||
        entry.state !== 'awaiting_download' ||
        Date.now() - entry.at > 60000 ||
        !sourceAllowed(item.finalUrl || item.url) ||
        !(item.filename + ' ' + item.url).includes(entry.modelId) ||
        !new RegExp(`\\.${entry.format}$`, 'i').test(item.filename || item.url)
      )
        continue;
      if (entry.downloadId !== undefined) entry.state = 'ambiguous_download';
      else entry.downloadId = item.id;
      await chromeApi.storage.local.set({ [key]: entry });
    }
  });
  return {
    async start(request, click) {
      if (!chromeApi.downloads) throw new Error('DOWNLOAD_PERMISSION_REQUIRED');
      const records = await chromeApi.storage.local.get(null);
      if (
        Object.entries(records).some(
          ([key, e]) =>
            key.startsWith(PREFIX) &&
            e.state === 'awaiting_download' &&
            Date.now() - e.at < 60000,
        )
      )
        throw new Error('EXPORT_BUSY');
      const exportId = crypto.randomUUID(),
        key = PREFIX + exportId;
      await chromeApi.storage.local.set({
        [key]: {
          state: 'awaiting_download',
          at: Date.now(),
          modelId: request.modelId,
          format: request.format,
        },
      });
      try {
        const result = await click();
        return { exportId, ...result };
      } catch (error) {
        await chromeApi.storage.local.set({
          [key]: {
            state: 'export_unknown',
            at: Date.now(),
            modelId: request.modelId,
            format: request.format,
          },
        });
        throw error;
      }
    },
    async status(exportId) {
      if (!chromeApi.downloads) throw new Error('DOWNLOAD_PERMISSION_REQUIRED');
      const value = (await chromeApi.storage.local.get(PREFIX + exportId))[
        PREFIX + exportId
      ];
      if (!value) throw new Error('EXPORT_NOT_FOUND');
      if (value.state !== 'awaiting_download' || value.downloadId === undefined)
        return {
          exportId,
          ...value,
          ...(Date.now() - value.at > 60000
            ? {
                state: 'download_not_verified',
                nextAction:
                  '供应商下载尚未与模型编号匹配；请核对下载记录，不要重新生成。',
              }
            : {}),
        };
      const [item] = await chromeApi.downloads.search({ id: value.downloadId });
      if (!item || !sourceAllowed(item.finalUrl || item.url))
        throw new Error('DOWNLOAD_SOURCE_CHANGED');
      if (item.state !== 'complete')
        return {
          exportId,
          modelId: value.modelId,
          state: item.state,
          error: item.error ?? null,
        };
      return {
        exportId,
        modelId: value.modelId,
        format: value.format,
        state: 'complete',
        filename: item.filename,
        bytes: item.fileSize,
        completedAt: item.endTime,
        sourceUrl: (item.finalUrl || item.url).split('?')[0],
      };
    },
  };
}
