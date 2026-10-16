import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';
import { createPreviewServer } from '../scripts/preview.mjs';

const CALL_CONTEXT_IDS = [
  'actions',
  'chat-call-context',
  'transcript-call-context',
  'menu-call-context',
  'settings-call-context',
];

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

async function openRenderer(reducedMotion = 'no-preference') {
  const page = await browser.newPage({ viewport: { width: 600, height: 800 } });
  if (reducedMotion === 'reduce') await page.emulateMedia({ reducedMotion });
  await page.goto(`${origin}/index.html?skin=xianxian-codex&pending=1&autoTranscript=1`);
  await page.waitForLoadState('networkidle');
  await page.evaluate(() => {
    const bridge = window.clowderCompanion;
    const original = bridge.request.bind(bridge);
    bridge.request = command => original(command);
  });
  return page;
}

async function readCallDots(page) {
  return page.evaluate(contextIds => {
    const resolvedColor = variable => {
      const probe = document.createElement('i');
      probe.style.background = `var(${variable})`;
      document.body.append(probe);
      const color = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return color;
    };
    return {
      colors: {
        success: resolvedColor('--desktop-success'),
        warning: resolvedColor('--desktop-warning'),
        muted: resolvedColor('--desktop-muted'),
      },
      dots: contextIds.map(id => {
        const context = document.getElementById(id);
        const dot = context.querySelector(':scope > .status-dot, :scope > .call-status-line > .status-dot');
        const style = getComputedStyle(dot);
        const halo = getComputedStyle(dot, '::after');
        return {
          id,
          state: context.dataset.connectionState,
          width: style.width,
          height: style.height,
          color: style.backgroundColor,
          opacity: style.opacity,
          haloAnimation: halo.animationName,
          haloDuration: halo.animationDuration,
          haloTiming: halo.animationTimingFunction,
        };
      }),
      meetingAnimation: getComputedStyle(document.querySelector('.meeting-status-dot'), '::after').animationName,
    };
  }, CALL_CONTEXT_IDS);
}

async function readVisibleHalo(page) {
  return page.evaluate(() => {
    const dot = document.querySelector('#actions .status-dot');
    const animation = dot.getAnimations({ subtree: true })
      .find(candidate => candidate.animationName === 'call-status-breathe');
    if (!animation) return null;
    return {
      duration: animation.effect.getTiming().duration,
      pseudoElement: animation.effect.pseudoElement,
      frames: animation.effect.getKeyframes().map(frame => ({
        offset: frame.offset,
        opacity: Number(frame.opacity),
        scale: new DOMMatrixReadOnly(frame.transform).a,
      })),
    };
  });
}

test('real call headers breathe from connected through recovering and settle when disconnected', async () => {
  const page = await openRenderer();
  try {
    await page.click('#pet');
    await page.click('#begin');
    await page.waitForFunction(() => document.getElementById('call-state')?.textContent === '正在连接');

    const connecting = await readCallDots(page);
    for (const dot of connecting.dots) {
      assert.equal(dot.state, 'connecting', dot.id);
      assert.equal(dot.color, connecting.colors.muted, dot.id);
      assert.equal(dot.haloAnimation, 'none', dot.id);
    }

    await page.waitForFunction(() => document.getElementById('call-state')?.textContent === '通话中');

    const connected = await readCallDots(page);
    for (const dot of connected.dots) {
      assert.equal(dot.state, 'connected', dot.id);
      assert.equal(dot.width, '8px', dot.id);
      assert.equal(dot.height, '8px', dot.id);
      assert.equal(dot.color, connected.colors.success, dot.id);
      assert.equal(dot.opacity, '1', `${dot.id}: the solid point must not blink`);
      assert.equal(dot.haloAnimation, 'call-status-breathe', dot.id);
      assert.equal(dot.haloDuration, '2s', dot.id);
      assert.equal(dot.haloTiming, 'ease-out', dot.id);
    }
    const halo = await readVisibleHalo(page);
    assert(halo, 'the visible native call bar must own the halo animation');
    assert.equal(halo.duration, 2000);
    assert.equal(halo.pseudoElement, '::after');
    assert.deepEqual(halo.frames, [
      { offset: 0, opacity: 0.38, scale: 1 },
      { offset: 1, opacity: 0, scale: 3 },
    ]);
    assert.equal(connected.meetingAnimation, 'none', 'meeting truth uses its own static indicator');

    await page.evaluate(() => window.__previewEmit({
      kind: 'audio', type: 'recovering', callId: window.__previewCallId,
    }));
    await page.waitForFunction(() => document.getElementById('actions')?.dataset.connectionState === 'recovering');
    await page.click('[data-action="transcript"]');
    const recovering = await readCallDots(page);
    for (const dot of recovering.dots) {
      assert.equal(dot.state, 'recovering', dot.id);
      assert.equal(dot.color, recovering.colors.warning, dot.id);
      assert.equal(dot.haloAnimation, 'call-status-breathe', dot.id);
    }

    await page.evaluate(() => window.__previewEmit({ kind: 'media-stopped', reason: 'closed' }));
    await page.waitForFunction(() => document.getElementById('actions')?.dataset.connectionState === 'idle');
    const disconnected = await readCallDots(page);
    for (const dot of disconnected.dots) {
      assert.equal(dot.state, 'idle', dot.id);
      assert.equal(dot.color, disconnected.colors.muted, dot.id);
      assert.equal(dot.haloAnimation, 'none', dot.id);
    }
  } finally {
    await page.close();
  }
});

test('reduced motion keeps every call status point static without changing its state color', async () => {
  const page = await openRenderer('reduce');
  try {
    await page.click('#pet');
    await page.click('#begin');
    await page.waitForFunction(() => document.getElementById('call-state')?.textContent === '通话中');
    const connected = await readCallDots(page);
    for (const dot of connected.dots) {
      assert.equal(dot.color, connected.colors.success, dot.id);
      assert.equal(dot.haloAnimation, 'none', dot.id);
    }
    const replyCountdown = await page.evaluate(() => {
      const button = document.getElementById('reply-retain');
      button.dataset.running = 'true';
      button.style.setProperty('--reply-visible-ms', '6000ms');
      return getComputedStyle(button.querySelector('.reply-ring-progress')).animationName;
    });
    assert.equal(replyCountdown, 'none', 'the reply countdown ring also respects reduced motion');
  } finally {
    await page.close();
  }
});
