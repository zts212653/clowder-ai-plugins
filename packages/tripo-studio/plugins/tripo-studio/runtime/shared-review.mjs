import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readTripoPage } from '../extension/page-reader.mjs';
import { downloadPreviewModel, outputDirectory } from './assets.mjs';
import { captureOrbitViews } from './capture-orbit.mjs';
import { assertSameModelPage, parseModelPage, validateAssetUrl } from './contract.mjs';
import { launchIsolatedChrome } from './isolated-chrome.mjs';
import { ownerForeground } from './owner-foreground.mjs';

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const READY = `(()=>{const canvas=[...document.querySelectorAll('canvas')].find(c=>c.width>100&&c.height>100);const text=document.body?.innerText??'';return {url:location.href,ready:!!canvas&&/Faces|Vertices/.test(text),canvas:canvas?{x:canvas.getBoundingClientRect().x,y:canvas.getBoundingClientRect().y,width:canvas.getBoundingClientRect().width,height:canvas.getBoundingClientRect().height}:null,text:text.slice(-6000)};})()`;
let activeReview;
export async function closeActiveReview() {
  const operation = activeReview;
  if (!operation) return;
  operation.controller.abort();
  await operation.finished;
}
export async function reviewSharedModel(pageUrl, number, root, options = {}) {
  options.signal?.throwIfAborted();
  if (activeReview) throw new Error('REVIEW_BUSY: 当前候选审模结束后再读下一份。');
  let finish;
  const operation = {
    controller: new AbortController(),
    finished: new Promise((resolve) => {
      finish = resolve;
    }),
  };
  activeReview = operation;
  try {
    return await captureSharedModel(pageUrl, number, root, {
      ...options,
      signal: AbortSignal.any([operation.controller.signal, ...(options.signal ? [options.signal] : [])]),
    });
  } finally {
    activeReview = undefined;
    finish();
  }
}
async function captureSharedModel(
  pageUrl,
  number,
  root,
  { launch = launchIsolatedChrome, foreground = ownerForeground, delay = pause, signal },
) {
  const source = parseModelPage(pageUrl);
  if (!Number.isInteger(number) || number < 1 || number > 8) throw new Error('INVALID_CANDIDATE_NUMBER');
  const output = await outputDirectory(root);
  signal.throwIfAborted();
  const directory = join(output, `tripo-shared-${number}-${source.modelId}-${randomUUID().slice(0, 8)}`);
  await mkdir(directory, { mode: 0o700 });
  let browser;
  try {
    signal.throwIfAborted();
    const before = await foreground();
    signal.throwIfAborted();
    browser = await launch({ signal });
    await browser.cdp.call('Page.navigate', { url: source.pageUrl });
    let state;
    for (let i = 0; i < 120; i++) {
      signal.throwIfAborted();
      state = await browser.cdp.evaluate(READY);
      if (state.ready) break;
      await delay(250);
    }
    if (!state?.ready) throw new Error('PUBLIC_MODEL_NOT_READY: 分享页尚未显示网格；未登录、未生成或导出。');
    assertSameModelPage(state.url, source.modelId);
    await delay(1500);
    const { screenshots, during } = await captureOrbitViews(browser.cdp, state.canvas, number, directory, {
      source,
      signal,
      foreground,
      delay,
    });
    const observed = await browser.cdp.evaluate(`(${readTripoPage.toString()})()`);
    assertSameModelPage(observed.pageUrl, source.modelId);
    signal.throwIfAborted();
    const resources = observed.resources.flatMap((value) => {
      try {
        return [validateAssetUrl(value)];
      } catch {
        return [];
      }
    });
    const model = await downloadPreviewModel(resources, directory, `${number}-${source.modelId}.glb`, { signal });
    signal.throwIfAborted();
    model.status = model.status === 'downloaded' ? 'preview_downloaded' : 'not_exported';
    const report = {
      v: 1,
      number,
      ...source,
      directory,
      observedAt: new Date().toISOString(),
      browser: {
        authenticated: false,
        profile: 'new_temporary_profile',
        mode: process.platform === 'darwin' ? 'hidden_target' : 'headless',
      },
      screenshots,
      model,
      displayedMeshLabels: {
        topology: state.text.match(/Topology\s+(\w+)/)?.[1] ?? null,
        faces: Number(state.text.match(/Faces\s+([\d,]+)/)?.[1]?.replaceAll(',', '')) || null,
        vertices: Number(state.text.match(/Vertices\s+([\d,]+)/)?.[1]?.replaceAll(',', '')) || null,
        source: 'public_viewer_labels_not_downloaded_mesh_measurement',
      },
      orientation: 'Initial camera plus three equal mouse orbit steps; not calibrated orthographic views.',
      exportStatus: 'not_exported',
    };
    await browser.close();
    browser = undefined;
    const after = await foreground();
    signal.throwIfAborted();
    report.foreground = {
      before,
      after,
      during,
      unchanged:
        before.status === 'observed' &&
        after.status === 'observed' &&
        JSON.stringify(before) === JSON.stringify(after) &&
        during.every((value) => value.applicationPid === before.applicationPid),
    };
    await writeFile(join(directory, 'provenance.json'), `${JSON.stringify(report, null, 2)}\n`, {
      flag: 'wx',
      mode: 0o600,
    });
    return report;
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  } finally {
    await browser?.close();
  }
}
