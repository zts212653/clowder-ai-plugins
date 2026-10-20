import {
  isWorkspaceUrl,
  validateWorkspaceRequest,
} from '../runtime/workspace-contract.mjs';
import { workspacePage } from './workspace-page.mjs';

const hex = (bytes) =>
  [...new Uint8Array(bytes)]
    .map((n) => n.toString(16).padStart(2, '0'))
    .join('');
export const fingerprint = async (value) =>
  hex(
    await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(JSON.stringify(value)),
    ),
  );
export function workspaceSession(chromeApi, foreground, downloads) {
  let transfer;
  let uploaded = {};
  let settings;
  let preview;
  const load = async () => {
    const { workspaceGrant } =
      await chromeApi.storage.local.get('workspaceGrant');
    if (!workspaceGrant) throw new Error('GENERATION_NOT_AUTHORIZED');
    const tab = await chromeApi.tabs.get(workspaceGrant.tabId);
    if (!isWorkspaceUrl(tab.url))
      throw new Error('AUTHORIZED_WORKSPACE_CHANGED');
    return workspaceGrant;
  };
  const page = async (grant, command) => {
    const result = await chromeApi.scripting.executeScript({
      target: { tabId: grant.tabId },
      world: 'ISOLATED',
      func: workspacePage,
      args: [{ ...command, authority: grant.authority }],
    });
    if (result.length !== 1 || !result[0].result)
      throw new Error('WORKSPACE_RESPONSE_MISSING');
    if (JSON.stringify(await load()) !== JSON.stringify(grant))
      throw new Error('AUTHORIZATION_REVOKED');
    return result[0].result;
  };
  return async (request) => {
    validateWorkspaceRequest(request);
    const grant = await load();
    const before = await foreground(chromeApi);
    let result;
    if (request.kind === 'navigate') {
      transfer = undefined;
      uploaded = {};
      settings = undefined;
      preview = undefined;
      await chromeApi.tabs.update(grant.tabId, {
        url: `https://studio.tripo3d.ai/workspace/${request.page}`,
      });
      result = {
        state: 'loading',
        page: request.page,
        nextAction: '再次读取工作页状态；此操作不上传或生成。',
      };
    }
    if (request.kind === 'inspect')
      result = { ...(await page(grant, request)), uploaded, settings };
    if (request.kind === 'configure') {
      transfer = undefined;
      uploaded = {};
      preview = undefined;
      result = await page(grant, request);
      settings = { ...request };
      if (
        result.privacy !== request.privacy ||
        result.imageSlots.length !== request.views
      )
        throw new Error('SETTINGS_NOT_APPLIED');
    }
    if (request.kind === 'upload') {
      if (
        !settings ||
        ![
          'front',
          ...(settings.views === 4 ? ['left', 'right', 'back'] : []),
        ].includes(request.view)
      )
        throw new Error('CONFIGURE_WORKSPACE_FIRST');
      if (request.index === 0) transfer = { ...request, data: [], next: 0 };
      if (
        !transfer ||
        transfer.sha256 !== request.sha256 ||
        transfer.view !== request.view ||
        transfer.bytes !== request.bytes ||
        transfer.total !== request.total ||
        transfer.name !== request.name ||
        transfer.mime !== request.mime ||
        transfer.next !== request.index
      )
        throw new Error('IMAGE_TRANSFER_CHANGED');
      transfer.data.push(request.data);
      transfer.next++;
      result = { received: transfer.next, total: transfer.total };
      if (transfer.next === transfer.total) {
        // Each chunk except the last is a multiple of three bytes, so base64 joins exactly.
        const data = transfer.data.join('');
        if (atob(data).length !== request.bytes)
          throw new Error('IMAGE_SIZE_MISMATCH');
        result = await page(grant, { ...request, kind: 'upload-file', data });
        uploaded[request.view] = {
          sha256: request.sha256,
          bytes: request.bytes,
          name: request.name,
        };
        transfer = undefined;
        preview = undefined;
      }
    }
    if (request.kind === 'preview') {
      if (!settings || Object.keys(uploaded).length !== settings.views)
        throw new Error('IMAGES_NOT_READY');
      const observed = await page(grant, { kind: 'inspect' });
      if (
        !observed.loggedIn ||
        observed.privacy !== settings.privacy ||
        !observed.canSubmit ||
        observed.quantity !== 1 ||
        !Number.isInteger(observed.creditCost)
      )
        throw new Error('GENERATION_PREVIEW_NOT_READY');
      const state = {
        pageUrl: observed.pageUrl,
        privacy: observed.privacy,
        model: observed.model,
        generationLabel: observed.generationLabel,
        quantity: observed.quantity,
        uploaded,
        settings,
      };
      preview = {
        jobId: request.jobId,
        sourceRef: request.sourceRef,
        state,
        digest: await fingerprint(state),
      };
      result = { ...preview, observed };
    }
    if (request.kind === 'submit') {
      if (
        !preview ||
        request.jobId !== preview.jobId ||
        request.previewDigest !== preview.digest
      )
        throw new Error('PREVIEW_CHANGED');
      const observed = await page(grant, { kind: 'inspect' });
      const state = {
        pageUrl: observed.pageUrl,
        privacy: observed.privacy,
        model: observed.model,
        generationLabel: observed.generationLabel,
        quantity: observed.quantity,
        uploaded,
        settings,
      };
      if (
        (await fingerprint(state)) !== preview.digest ||
        !observed.loggedIn ||
        !observed.canSubmit
      )
        throw new Error('PREVIEW_CHANGED');
      const key = `submission:${request.jobId}`;
      if ((await chromeApi.storage.local.get(key))[key])
        throw new Error('ALREADY_ATTEMPTED');
      await chromeApi.storage.local.set({
        [key]: {
          state: 'submission_unknown',
          at: new Date().toISOString(),
          sourceRef: preview.sourceRef,
          digest: preview.digest,
        },
      });
      // The durable unknown state is set before click and is never reset by reconnect/regrant.
      result = await page(grant, { kind: 'submit' });
      await chromeApi.storage.local.set({
        [key]: {
          state: result.receipt ? 'submitted' : 'submission_unknown',
          at: new Date().toISOString(),
          result,
        },
      });
      preview = undefined;
    }
    if (request.kind === 'export')
      result = await downloads.start(request, () => page(grant, request));
    if (request.kind === 'downloads')
      result = await downloads.status(request.exportId);
    const after = await foreground(chromeApi);
    return {
      ...result,
      before,
      after,
      foregroundUnchanged: JSON.stringify(before) === JSON.stringify(after),
    };
  };
}
