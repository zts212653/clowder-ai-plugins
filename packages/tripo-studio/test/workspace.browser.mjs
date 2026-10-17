import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { workspacePage } from '../plugins/tripo-studio/extension/workspace-page.mjs';
const require = createRequire(
  new URL('../../companion/package.json', import.meta.url),
);
const { chromium } = require('playwright');
const profile = await mkdtemp(join(tmpdir(), 'tripo-extension-browser-'));
const extension = resolve(import.meta.dirname, '../plugins/tripo-studio');
const browser = await chromium.launchPersistentContext(profile, {
  channel: 'chromium',
  headless: true,
  args: [
    `--disable-extensions-except=${extension}`,
    `--load-extension=${extension}`,
  ],
});
try {
  const page = await browser.newPage();
  const html = `<main><div data-workspace-panel><h2>Generate Model</h2><button>HD Model</button><button>Smart Mesh</button><button><i class="i-tripo:add-image"></i></button><button><i class="i-tripo:multi-view"></i></button><div id="slots"></div><div><p>Privacy</p><button role="combobox">Private</button></div><button role="combobox">P2.0</button><button aria-pressed="true">1</button><button id="generate">Generate 100</button></div></main>`;
  await page.route('https://studio.tripo3d.ai/workspace/generate', (route) =>
    route.fulfill({ contentType: 'text/html', body: html }),
  );
  await page.goto('https://studio.tripo3d.ai/workspace/generate');
  await page.evaluate(() => {
    window.submissions = 0;
    const slot = document.getElementById('slots');
    const set = (count) => {
      slot.replaceChildren();
      for (let i = 0; i < count; i++) {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'image/png';
        input.dataset.view = ['front', 'left', 'right', 'back'][i];
        input.addEventListener('change', () => {
          window.files ??= {};
          window.files[input.dataset.view] = input.files[0].name;
        });
        slot.append(input);
      }
    };
    set(1);
    document.querySelector(
      '[class~="i-tripo:multi-view"]',
    ).parentElement.onclick = () => set(4);
    document.querySelector(
      '[class~="i-tripo:add-image"]',
    ).parentElement.onclick = () => set(1);
    document.getElementById('generate').onclick = () => {
      window.submissions++;
    };
  });
  const configured = await page.evaluate(workspacePage, {
    kind: 'configure',
    mode: 'Smart Mesh',
    views: 4,
    privacy: 'Private',
  });
  assert.equal(configured.privacy, 'Private');
  assert.equal(configured.quantity, 1);
  assert.equal(configured.imageSlots.length, 4);
  const bytes = Buffer.from('test-image-snapshot');
  const { createHash } = await import('node:crypto');
  for (const view of ['front', 'left', 'right', 'back'])
    await page.evaluate(workspacePage, {
      kind: 'upload-file',
      view,
      name: `${view}.png`,
      mime: 'image/png',
      data: bytes.toString('base64'),
      sha256: createHash('sha256').update(bytes).digest('hex'),
    });
  assert.deepEqual(await page.evaluate(() => window.files), {
    front: 'front.png',
    left: 'left.png',
    right: 'right.png',
    back: 'back.png',
  });
  await page.evaluate(workspacePage, { kind: 'submit' });
  assert.equal(await page.evaluate(() => window.submissions), 1);
  await page.evaluate(() => {
    const button = document.createElement('button');
    button.textContent = 'Generate 100';
    document.querySelector('[data-workspace-panel]').append(button);
  });
  await assert.rejects(
    page.evaluate(workspacePage, { kind: 'submit' }),
    /STUDIO_UI_CHANGED/,
  );
  assert.equal(await page.evaluate(() => window.submissions), 1);
  await page.evaluate(() => {
    const button = document.createElement('button');
    button.textContent = 'Sign up/Log in';
    document.body.append(button);
  });
  await assert.rejects(
    page.evaluate(workspacePage, { kind: 'upload-file' }),
    /TRIPO_NOT_LOGGED_IN/,
  );
  const worker =
    browser.serviceWorkers()[0] ??
    (await browser.waitForEvent('serviceworker', { timeout: 15000 }));
  const id = new URL(worker.url()).host;
  // Permission responses are fixtures; tab creation and popup rendering use real Chrome APIs.
  await worker.evaluate(() => {
    chrome.permissions.contains = async () => true;
  });
  const popup = await browser.newPage();
  await popup.goto(`chrome-extension://${id}/extension/popup.html`);
  await popup.locator('input[value=workspace]').check();
  assert.equal(await popup.locator('#grant').innerText(), '授权生成与导出');
  assert.match(
    await popup.locator('#workspace-description').innerText(),
    /网页订阅积分/,
  );
  await popup.screenshot({
    path: '/tmp/f328-subscription-popup.png',
    fullPage: true,
  });
  // Non-Tripo origins disable the grant button; this product boundary stays enforced.
  assert.equal(await popup.locator('#grant').isDisabled(), true);
  const before = await worker.evaluate(() =>
    chrome.tabs.query({ active: true }).then((t) => t.map((x) => x.id)),
  );
  const grant = await popup.evaluate(() =>
    chrome.runtime.sendMessage({ op: 'grant-workspace' }),
  );
  assert.equal(grant.workspaceAuthorized, true);
  const after = await worker.evaluate(() =>
    chrome.tabs.query({ active: true }).then((t) => t.map((x) => x.id)),
  );
  assert.deepEqual(after, before);
  const background = await worker.evaluate(async () => {
    const { workspaceGrant } = await chrome.storage.local.get('workspaceGrant');
    return chrome.tabs.get(workspaceGrant.tabId);
  });
  assert.equal(background.active, false);
  console.log(
    JSON.stringify({
      result: 'pass',
      browser: 'isolated headless Chromium',
      coverage: [
        'four file slots receive the exact files',
        'visible privacy and single generation',
        'ambiguous Generate refuses a second click',
        'signed-out upload refused',
        'actual extension worker/popup boots and explicit mode copy',
        'real Chrome background tab is inactive and active IDs unchanged (permission response fixture)',
      ],
      supplierGeneration: false,
      ownerChromeTouched: false,
    }),
  );
} finally {
  await browser.close();
  await rm(profile, { recursive: true, force: true });
}
