import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';
import { createPreviewServer } from '../scripts/preview.mjs';

let browser;
let origin;
let server;

before(async () => {
  server = createPreviewServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert(address && typeof address === 'object');
  origin = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch({ headless: true });
});

after(async () => {
  await browser?.close();
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
});

async function openPreview(viewport = { width: 600, height: 800 }) {
  const page = await browser.newPage({ viewport });
  await page.addInitScript(() => {
    let bridge;
    const callbacks = [];
    Object.defineProperty(window, 'clowderCompanion', {
      configurable: true,
      get: () => bridge,
      set: value => {
        bridge = value;
        const subscribe = value.subscribe.bind(value);
        value.subscribe = callback => {
          callbacks.push(callback);
          return subscribe(callback);
        };
        window.__emitAudio = event => callbacks.forEach(callback => callback(event));
      },
    });
  });
  await page.goto(`${origin}/index.html?skin=xianxian-codex&pending=1`);
  await page.waitForLoadState('networkidle');
  await page.evaluate(() => {
    window.__layoutRequests = [];
    const bridge = window.clowderCompanion;
    const original = bridge.request.bind(bridge);
    bridge.request = command => {
      if (command.kind === 'view.layout') window.__layoutRequests.push({ ...command });
      return original(command);
    };
  });
  return page;
}

async function visibleClipping(page, panelId) {
  return page.evaluate(id => {
    const panel = document.getElementById(id);
    const bounds = panel.getBoundingClientRect();
    const visible = element => element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden';
    const clippedButtons = [...panel.querySelectorAll('button')].filter(visible).flatMap(button => {
      const rect = button.getBoundingClientRect();
      const edges = {
        left: Math.max(0, bounds.left - rect.left),
        right: Math.max(0, rect.right - bounds.right),
        top: Math.max(0, bounds.top - rect.top),
        bottom: Math.max(0, rect.bottom - bounds.bottom),
      };
      const clipped = Object.values(edges).reduce((sum, value) => sum + value, 0);
      return clipped > 0.5 ? [{ id: button.id || button.textContent.trim(), clipped, edges }] : [];
    });
    return { width: bounds.width, height: bounds.height, clippedButtons };
  }, panelId);
}

test('dynamic call content and expanded transcript keep every action visible', async () => {
  const page = await openPreview();
  try {
    await page.click('#pet');
    await page.click('#begin');
    await page.waitForFunction(() => document.getElementById('call-state')?.textContent.includes('通话中'));
    await page.waitForFunction(() => document.getElementById('actions').style.maxHeight !== '');
    await page.waitForTimeout(300);
    await page.evaluate(() => {
      const work = document.getElementById('call-work');
      work.textContent = '宪宪正在思考';
      work.hidden = false;
      const share = document.getElementById('call-share-context');
      share.hidden = false;
      document.getElementById('call-share-target').textContent = '共享中：Blender · 一个很长的窗口标题';
    });
    await page.waitForFunction(() => window.__layoutRequests.some(row => row.panel === 'actions' && row.height > 200));
    const callbar = await visibleClipping(page, 'actions');
    assert.deepEqual(callbar.clippedButtons, []);
    assert(callbar.height <= 500);

    await page.click('[data-action="transcript"]');
    await page.click('#transcript-expand');
    await page.waitForFunction(() => window.__layoutRequests.some(row => row.panel === 'transcript' && row.height >= 500));
    const transcript = await visibleClipping(page, 'transcript');
    assert.equal(transcript.height, 500);
    assert.deepEqual(transcript.clippedButtons, []);
    assert.equal(await page.locator('#transcript').getAttribute('data-expanded'), 'true');
  } finally {
    await page.close();
  }
});

test('subtitle return is visible and restores the same shared call at compact and expanded heights', async () => {
  const page = await openPreview({ width: 460, height: 620 });
  try {
    await page.click('#pet');
    await page.click('#begin');
    await page.waitForFunction(() => document.getElementById('call-state')?.textContent.includes('通话中'));
    await page.evaluate(() => {
      for (const prefix of ['call', 'transcript']) {
        document.getElementById(`${prefix}-share-context`).hidden = false;
        document.getElementById(`${prefix}-share-target`).textContent = '共享中：Blender · 窄屏验收窗口';
      }
    });

    for (const expanded of [false, true]) {
      await page.click('[data-action="transcript"]');
      if (expanded) await page.click('#transcript-expand');
      await page.fill('#call-message', '未发送的草稿');
      const transcript = await visibleClipping(page, 'transcript');
      assert(transcript.height <= 500);
      assert.deepEqual(transcript.clippedButtons, []);
      assert.equal(await page.locator('#transcript-return').isVisible(), true);

      await page.click('#transcript-return');
      await page.waitForFunction(() => !document.getElementById('actions').hidden);
      assert.equal(await page.locator('#call-state').textContent(), '通话中');
      assert.equal(await page.locator('#call-share-target').textContent(), '共享中：Blender · 窄屏验收窗口');
      assert.equal(await page.inputValue('#call-message'), '未发送的草稿');
    }
  } finally {
    await page.close();
  }
});

test('recovering shared subtitles keep every header action inside compact and expanded panels', async () => {
  const page = await openPreview({ width: 460, height: 700 });
  try {
    await page.click('#pet');
    await page.click('#begin');
    await page.waitForFunction(() => document.getElementById('call-state')?.textContent === '通话中');
    await page.click('[data-action="transcript"]');
    await page.evaluate(() => {
      window.__emitAudio({ kind: 'audio', type: 'recovering', callId: '11111111-1111-4111-8111-111111111111' });
      const share = document.getElementById('transcript-share-context');
      share.hidden = false;
      document.getElementById('transcript-share-target').textContent = '共享中：Blender · 长窗口标题';
    });
    await page.waitForFunction(() => document.getElementById('transcript-call-state')?.textContent === '连接不稳定');

    for (const expanded of [false, true]) {
      if (expanded) await page.click('#transcript-expand');
      const transcript = await visibleClipping(page, 'transcript');
      assert(transcript.height <= 500);
      assert.deepEqual(transcript.clippedButtons, []);
      assert.equal(await page.locator('#transcript-call-state').textContent(), '连接不稳定');
      assert.equal(await page.locator('#transcript-call-mic-state').textContent(), '正在等待原连接恢复 · 麦克风已开启');
      assert.equal(await page.locator('#transcript-return').isVisible(), true);
      assert.equal(await page.locator('#transcript-mic').isVisible(), true);
      assert.equal(await page.locator('#transcript-expand').isVisible(), true);
      assert.equal(await page.locator('#transcript [data-action="stop"]').isVisible(), true);
      const stateGeometry = await page.locator('#transcript-call-state').evaluate(element => {
        const rect = element.getBoundingClientRect();
        return { width: rect.width, height: rect.height };
      });
      assert(stateGeometry.width > stateGeometry.height * 2, JSON.stringify(stateGeometry));
    }
  } finally {
    await page.close();
  }
});

test('decisions loaded after opening expand the panel until every bounded row is visible', async () => {
  const page = await openPreview();
  try {
    await page.click('#pet');
    await page.click('[data-action="decisions"]');
    await page.waitForFunction(() => document.querySelectorAll('#decision-list > li').length === 3);
    await page.waitForFunction(() => document.getElementById('decisions').getBoundingClientRect().height > 250);
    const result = await page.evaluate(() => {
      const panel = document.getElementById('decisions').getBoundingClientRect();
      const list = document.getElementById('decision-list').getBoundingClientRect();
      const rows = [...document.querySelectorAll('#decision-list > li')].map(row => {
        const rect = row.getBoundingClientRect();
        return Math.max(0, Math.min(rect.bottom, list.bottom) - Math.max(rect.top, list.top)) / rect.height;
      });
      return { panelHeight: panel.height, rows };
    });
    assert(result.panelHeight <= 500);
    assert(result.rows.every(ratio => ratio >= 0.99), JSON.stringify(result));
  } finally {
    await page.close();
  }
});

test('an asynchronously capped Host does not create a layout feedback loop', async () => {
  const page = await openPreview();
  try {
    await page.evaluate(() => {
      const bridge = window.clowderCompanion;
      const original = bridge.request.bind(bridge);
      bridge.request = async command => {
        const reply = await original(command);
        if (command.kind !== 'view.layout') return reply;
        await new Promise(resolve => setTimeout(resolve, 40));
        return { ...reply, panel: { ...reply.panel, height: Math.min(200, reply.panel.height) } };
      };
    });
    await page.click('#pet');
    await page.click('[data-action="settings"]');
    await page.waitForTimeout(500);
    const settled = await page.evaluate(() => window.__layoutRequests.filter(row => row.panel === 'settings').length);
    await page.waitForTimeout(2300);
    const later = await page.evaluate(() => window.__layoutRequests.filter(row => row.panel === 'settings').length);
    assert.equal(later, settled, `layout count changed after settling: ${settled} -> ${later}`);
  } finally {
    await page.close();
  }
});
