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

async function openPreview(viewport = { width: 600, height: 800 }, { autoTranscript = true } = {}) {
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
  await page.goto(`${origin}/index.html?skin=xianxian-codex&pending=1&autoTranscript=${autoTranscript ? '1' : '0'}`);
  await page.waitForLoadState('networkidle');
  await page.evaluate(() => {
    window.__layoutRequests = [];
    window.__presentationObservations = [];
    const bridge = window.clowderCompanion;
    const original = bridge.request.bind(bridge);
    bridge.request = command => {
      if (command.kind === 'view.layout') window.__layoutRequests.push({ ...command });
      if (command.kind === 'presentation.observe') window.__presentationObservations.push({ ...command });
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

async function textRangeVisibility(page, rowSelector, needle) {
  return page.evaluate(({ rowSelector, needle }) => {
    const row = document.querySelector(rowSelector);
    const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const index = node.data.indexOf(needle);
      if (index === -1) continue;
      const range = document.createRange();
      range.setStart(node, index);
      range.setEnd(node, index + needle.length);
      const bounds = row.getBoundingClientRect();
      const text = range.getBoundingClientRect();
      const hit = document.elementFromPoint((text.left + text.right) / 2, (text.top + text.bottom) / 2);
      return {
        rowText: row.textContent,
        visible: text.left >= bounds.left - 0.5 && text.right <= bounds.right + 0.5
          && text.top >= bounds.top - 0.5 && text.bottom <= bounds.bottom + 0.5
          && hit !== null && row.contains(hit),
        bounds: { left: bounds.left, right: bounds.right, top: bounds.top, bottom: bounds.bottom },
        text: { left: text.left, right: text.right, top: text.top, bottom: text.bottom },
      };
    }
    return { rowText: row.textContent, visible: false, missing: true };
  }, { rowSelector, needle });
}

async function recentRowPresentation(page, rowSelector) {
  return page.evaluate(rowSelector => {
    const row = document.querySelector(rowSelector);
    const speaker = row.querySelector('.recent-speaker').getBoundingClientRect();
    const message = row.querySelector('.recent-message');
    const text = row.querySelector('.recent-message-text').getBoundingClientRect();
    return {
      gap: text.left - speaker.right,
      textOverflow: getComputedStyle(message).textOverflow,
      textDirection: message.dataset.direction,
    };
  }, rowSelector);
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

test('meeting status keeps the longest state phrase whole and truncates only its source', async () => {
  const page = await openPreview({ width: 460, height: 620 });
  try {
    await page.click('#pet');
    await page.click('#begin');
    await page.waitForFunction(() => document.getElementById('call-meeting-label')?.textContent
      === '会议记录中 · 未接入通话');

    const metrics = async prefix => page.evaluate(prefix => {
      const label = document.getElementById(`${prefix}-meeting-label`);
      const source = document.getElementById(`${prefix}-meeting-source`);
      return {
        label: { clientWidth: label.clientWidth, scrollWidth: label.scrollWidth, text: label.textContent },
        source: { clientWidth: source.clientWidth, scrollWidth: source.scrollWidth,
          overflow: getComputedStyle(source).overflow, textOverflow: getComputedStyle(source).textOverflow },
      };
    }, prefix);
    const headerGeometry = async prefix => page.evaluate(prefix => {
      const context = document.getElementById(`${prefix}-call-context`);
      const dot = context.querySelector(':scope > .status-dot').getBoundingClientRect();
      const state = document.getElementById(`${prefix}-call-state`).getBoundingClientRect();
      const actions = context.querySelector(':scope > .call-context-actions').getBoundingClientRect();
      return {
        dotToState: state.left - dot.right,
        actionStateCenterDelta: Math.abs((actions.top + actions.height / 2) - (state.top + state.height / 2)),
      };
    }, prefix);

    const call = await metrics('call');
    assert.equal(call.label.text, '会议记录中 · 未接入通话');
    assert.equal(call.label.clientWidth, call.label.scrollWidth);
    assert(call.source.scrollWidth > call.source.clientWidth, JSON.stringify(call));
    assert.deepEqual({ overflow: call.source.overflow, textOverflow: call.source.textOverflow },
      { overflow: 'hidden', textOverflow: 'ellipsis' });

    await page.click('[data-action="transcript"]');
    const transcript = await metrics('transcript-call');
    assert.equal(transcript.label.clientWidth, transcript.label.scrollWidth);
    assert(transcript.source.scrollWidth > transcript.source.clientWidth, JSON.stringify(transcript));
    assert.equal(await page.locator('#transcript').evaluate(element => element.getBoundingClientRect().height), 210,
      'the meeting row takes space from captions, not from the collapsed card height');
    assert.deepEqual((await visibleClipping(page, 'transcript')).clippedButtons, []);

    await page.click('#transcript-return');
    await page.evaluate(() => window.__setMeeting({
      kind: 'running', sharing: false, paused: false, sourceLabel: 'Google Meet',
    }));
    await page.waitForFunction(() => document.getElementById('call-meeting-source')?.textContent.includes('Google Meet'));
    await page.click('#call-chat');
    const chat = await metrics('chat-call');
    assert.equal(chat.source.scrollWidth, chat.source.clientWidth,
      `a common source label must remain readable in chat: ${JSON.stringify(chat)}`);
    const chatHeader = await headerGeometry('chat');
    assert(chatHeader.dotToState >= 0 && chatHeader.dotToState < 20, JSON.stringify(chatHeader));
    assert(chatHeader.actionStateCenterDelta < 12, JSON.stringify(chatHeader));

    await page.click('#chat header [data-action="dismiss"]');
    await page.click('#pet');
    await page.click('#menu-settings');
    const settings = await metrics('settings-call');
    assert.equal(settings.source.scrollWidth, settings.source.clientWidth,
      `a common source label must remain readable in settings: ${JSON.stringify(settings)}`);
    const settingsHeader = await headerGeometry('settings');
    assert(settingsHeader.dotToState >= 0 && settingsHeader.dotToState < 20, JSON.stringify(settingsHeader));
    assert(settingsHeader.actionStateCenterDelta < 12, JSON.stringify(settingsHeader));
  } finally {
    await page.close();
  }
});

test('compact call journey keeps badge, chat, unread, card controls and work truth usable', async () => {
  const page = await openPreview({ width: 460, height: 720 });
  try {
    await page.click('#pet');
    await page.waitForFunction(() => !document.getElementById('work-overview').hidden);
    assert.equal(await page.locator('#work-active-list .work-overview-row').count(), 1);
    assert.equal(await page.locator('#work-delivery-list .work-overview-row').count(), 1);

    await page.click('#menu-size-toggle');
    await page.waitForFunction(() => document.getElementById('anchor').dataset.ballSize === '43');
    assert.equal(await page.locator('#menu-size-toggle .label').textContent(), '放大');
    const compact = await page.evaluate(() => {
      document.getElementById('pending-count').textContent = '5';
      document.getElementById('pending-badge').hidden = false;
      const pet = document.getElementById('pet').getBoundingClientRect();
      const anchor = document.getElementById('anchor').getBoundingClientRect();
      const badge = document.getElementById('pending-badge').getBoundingClientRect();
      const hit = document.elementFromPoint((badge.left + badge.right) / 2, (badge.top + badge.bottom) / 2);
      return {
        pet: { width: Math.round(pet.width), height: Math.round(pet.height) },
        badgeInside: badge.left >= anchor.left - .5 && badge.right <= anchor.right + .5
          && badge.top >= anchor.top - .5 && badge.bottom <= anchor.bottom + .5,
        badgeContentFits: document.getElementById('pending-badge').scrollWidth
          <= document.getElementById('pending-badge').clientWidth,
        badgeHit: hit?.id === 'pending-badge' || hit?.closest?.('#pending-badge')?.id === 'pending-badge',
        badgeRightInset: anchor.right - badge.right,
        badgeTopInset: badge.top - anchor.top,
      };
    });
    assert.deepEqual(compact.pet, { width: 72, height: 78 });
    assert.equal(compact.badgeInside, true);
    assert.equal(compact.badgeContentFits, true);
    assert.equal(compact.badgeHit, true);
    assert.ok(Math.abs(compact.badgeRightInset) < .5, 'compact badge stays on the top-right corner by default');
    assert.ok(Math.abs(compact.badgeTopInset) < .5, 'compact badge stays on the top edge');
    const dockedBadgeOffset = await page.evaluate(() => {
      document.getElementById('pet').dataset.dockEdge = 'right';
      const anchor = document.getElementById('anchor').getBoundingClientRect();
      const badge = document.getElementById('pending-badge').getBoundingClientRect();
      return Math.abs(badge.left - anchor.left);
    });
    assert.ok(dockedBadgeOffset < .5, 'right-edge docking flips the complete badge to the left corner');

    await page.click('#begin');
    await page.waitForFunction(() => document.getElementById('call-state')?.textContent.includes('通话中'));
    assert.deepEqual((await visibleClipping(page, 'actions')).clippedButtons, []);
    await page.click('#call-chat');
    await page.waitForFunction(() => !document.getElementById('chat').hidden);
    const conversationHistoryChrome = await page.evaluate(() => ({
      presentation: document.getElementById('chat').dataset.historyPresentation,
      composeVisible: !document.getElementById('compose').hidden,
      scopeVisible: !document.getElementById('chat-scope').hidden,
    }));
    assert.deepEqual(conversationHistoryChrome,
      { presentation: 'conversation', composeVisible: true, scopeVisible: true },
      JSON.stringify(conversationHistoryChrome));
    await page.waitForFunction(() => document.getElementById('call-transcript-log').children.length >= 2);
    await page.click('#chat header [data-action="dismiss"]');
    await page.waitForFunction(() => !document.getElementById('actions').hidden);
    await page.evaluate(() => window.__pushTranscript({
      messageId: 'preview-voice-new', role: 'assistant', text: '收起以后来的消息',
      source: { kind: 'voice', nativeThreadId: 'preview-thread', realtimeSessionId: 'preview-realtime-session', nativeItemId: 'preview-output-new' },
    }));
    await page.waitForFunction(() => document.getElementById('call-chat-unread').textContent === '1');
    assert.equal(await page.locator('#call-state').textContent(), '通话中');

    await page.click('#pet');
    await page.waitForFunction(() => !document.getElementById('menu').hidden);
    assert.equal(await page.locator('#menu-call-context').isVisible(), true);
    assert.equal(await page.locator('#menu-mic').isVisible(), true);
    assert.equal(await page.locator('#menu-call-share').isVisible(), true);
    assert.equal(await page.locator('#menu-call-chat').isVisible(), true);
    assert.equal(await page.locator('#menu-hide-label').textContent(), '结束通话并隐藏');
    const fixedCardEdges = await page.evaluate(() => {
      const menu = document.getElementById('menu').getBoundingClientRect();
      const call = document.getElementById('menu-call-context').getBoundingClientRect();
      const footer = document.querySelector('.menu-footer').getBoundingClientRect();
      return { callTop: call.top - menu.top, footerBottom: menu.bottom - footer.bottom, height: menu.height };
    });
    assert.ok(fixedCardEdges.callTop >= -.5);
    assert.ok(fixedCardEdges.footerBottom >= -.5);
    assert.ok(fixedCardEdges.height <= 500);
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

test('first subtitle observation waits for a real visible panel and remains single-shot', async () => {
  const page = await openPreview({ width: 460, height: 620 }, { autoTranscript: false });
  try {
    await page.click('#pet');
    await page.click('#begin');
    await page.waitForFunction(() => document.getElementById('call-state')?.textContent === '通话中');
    await page.click('#pet');
    await page.waitForFunction(() => !document.getElementById('menu').hidden);

    await page.evaluate(() => window.__emitAudio({
      kind: 'audio', type: 'transcript',
      callId: '11111111-1111-4111-8111-111111111111',
      role: 'assistant', text: '这条字幕先写入隐藏面板。', itemId: 'hidden-output-1',
    }));
    await page.waitForTimeout(100);
    assert.equal(await page.evaluate(() => window.__presentationObservations.length), 0);

    await page.click('#pet');
    await page.waitForFunction(() => !document.getElementById('actions').hidden);
    await page.waitForFunction(() => window.__presentationObservations.length === 1, null, { timeout: 1_500 });
    const observation = await page.evaluate(() => window.__presentationObservations[0]);
    assert.equal(Number.isSafeInteger(observation.observedAt) && observation.observedAt > 0, true);
    const { observedAt: _observedAt, ...bounded } = observation;
    assert.deepEqual(bounded, {
      kind: 'presentation.observe',
      event: 'first_text_visible',
      callId: '11111111-1111-4111-8111-111111111111',
      reference: { kind: 'native-item', nativeItemId: 'hidden-output-1' },
    });

    await page.evaluate(() => window.__emitAudio({
      kind: 'audio', type: 'transcript',
      callId: '11111111-1111-4111-8111-111111111111',
      role: 'assistant', text: '重复内容不会再报。', itemId: 'hidden-output-1',
    }));
    await page.waitForTimeout(100);
    assert.equal(await page.evaluate(() => window.__presentationObservations.length), 1);
  } finally {
    await page.close();
  }
});

test('the narrow call bar keeps both speaker labels and the newest streamed tail visibly on screen', async () => {
  const page = await openPreview({ width: 390, height: 620 });
  try {
    await page.click('#pet');
    await page.click('#begin');
    await page.waitForFunction(() => document.getElementById('call-state')?.textContent === '通话中');
    await page.evaluate(() => {
      const callId = '11111111-1111-4111-8111-111111111111';
      window.__emitAudio({ kind: 'audio', type: 'transcript', callId, role: 'user', itemId: 'long-user',
        text: `${'这是一段很长的用户实时输入'.repeat(18)}用户最新尾部。` });
      window.__emitAudio({ kind: 'audio', type: 'transcript', callId, role: 'assistant', itemId: 'long-assistant',
        text: `${'这是猫猫正在持续回答的长句'.repeat(18)}assistant tail!` });
    });

    const userLabel = await textRangeVisibility(page, '.call-recent p[data-role="user"]', '语音：');
    const userTail = await textRangeVisibility(page, '.call-recent p[data-role="user"]', '用户最新尾部。');
    const assistantLabel = await textRangeVisibility(page, '.call-recent p[data-role="assistant"]', '宪宪：');
    const assistantTail = await textRangeVisibility(page, '.call-recent p[data-role="assistant"]', 'assistant tail!');
    assert.equal(userLabel.visible, true, JSON.stringify(userLabel));
    assert.equal(userTail.visible, true, JSON.stringify(userTail));
    assert.equal(assistantLabel.visible, true, JSON.stringify(assistantLabel));
    assert.equal(assistantTail.visible, true, JSON.stringify(assistantTail));

    await page.evaluate(async () => {
      const { RecentBubble } = await import('/recent-bubble.mjs');
      const bubble = new RecentBubble([
        document.getElementById('call-bubble-first'), document.getElementById('call-bubble-second'),
      ]);
      bubble.append('user', 'hi', '语音');
      bubble.append('assistant', '好的。', '宪宪');
    });
    for (const role of ['user', 'assistant']) {
      const presentation = await recentRowPresentation(page, `.call-recent p[data-role="${role}"]`);
      assert(Math.abs(presentation.gap) <= 0.5, JSON.stringify(presentation));
      assert.equal(presentation.textOverflow, 'ellipsis');
      assert.equal(presentation.textDirection, 'ltr');
    }

    const callbar = await visibleClipping(page, 'actions');
    assert(callbar.height <= 500);
    assert.deepEqual(callbar.clippedButtons, []);
  } finally {
    await page.close();
  }
});

test('the narrow call bar keeps the logical tail visible for right-to-left messages', async () => {
  const page = await openPreview({ width: 390, height: 620 });
  try {
    await page.click('#pet');
    await page.click('#begin');
    await page.waitForFunction(() => document.getElementById('call-state')?.textContent === '通话中');
    await page.evaluate(async () => {
      const { RecentBubble } = await import('/recent-bubble.mjs');
      const bubble = new RecentBubble([
        document.getElementById('call-bubble-first'), document.getElementById('call-bubble-second'),
      ]);
      bubble.append('user', `${'مرحبا '.repeat(40)}نهاية الجملة`, '语音');
      bubble.append('assistant', `${'שלום '.repeat(40)}סוף המשפט`, '宪宪');
    });

    const arabic = await textRangeVisibility(page, '.call-recent p[data-role="user"]', 'نهاية الجملة');
    const hebrew = await textRangeVisibility(page, '.call-recent p[data-role="assistant"]', 'סוף המשפט');
    assert.equal(arabic.visible, true, JSON.stringify(arabic));
    assert.equal(hebrew.visible, true, JSON.stringify(hebrew));
    assert.equal((await recentRowPresentation(page, '.call-recent p[data-role="user"]')).textDirection, 'rtl');
    assert.equal((await recentRowPresentation(page, '.call-recent p[data-role="assistant"]')).textDirection, 'rtl');

    await page.evaluate(async () => {
      const { RecentBubble } = await import('/recent-bubble.mjs');
      const bubble = new RecentBubble([
        document.getElementById('call-bubble-first'), document.getElementById('call-bubble-second'),
      ]);
      bubble.append('user', `${'ك'.repeat(50)}iPad  ${'مرحبا '.repeat(17)}نهاية الجملة`, '语音');
      bubble.append('assistant', `${'word '.repeat(60)}مرحبا  ${'word '.repeat(20)}final words!`, '宪宪');
    });
    const mixedRtl = await textRangeVisibility(page, '.call-recent p[data-role="user"]', 'نهاية الجملة');
    const mixedLtr = await textRangeVisibility(page, '.call-recent p[data-role="assistant"]', 'final words!');
    assert.equal(mixedRtl.visible, true, JSON.stringify(mixedRtl));
    assert.equal(mixedLtr.visible, true, JSON.stringify(mixedLtr));
    assert.equal((await recentRowPresentation(page, '.call-recent p[data-role="user"]')).textDirection, 'rtl');
    assert.equal((await recentRowPresentation(page, '.call-recent p[data-role="assistant"]')).textDirection, 'ltr');

    const adlamTail = String.fromCodePoint(0x1e922, 0x1e923, 0x1e924, 0x1e925, 0x1e926);
    await page.evaluate(async ({ adlamPrefix, adlamTail }) => {
      const { RecentBubble } = await import('/recent-bubble.mjs');
      const row = document.getElementById('call-bubble-first');
      const bubble = new RecentBubble([row, document.getElementById('call-bubble-second')]);
      bubble.append('user', `${`${adlamPrefix} `.repeat(30)}${adlamTail}`, '语音');
    }, {
      adlamPrefix: String.fromCodePoint(0x1e927, 0x1e928, 0x1e929, 0x1e92a, 0x1e92b),
      adlamTail,
    });
    const adlam = await textRangeVisibility(page, '.call-recent p[data-role="user"]', adlamTail);
    assert.equal(adlam.visible, true, JSON.stringify(adlam));
    assert.equal((await recentRowPresentation(page, '.call-recent p[data-role="user"]')).textDirection, 'rtl');

    const streaming = await page.evaluate(async () => {
      const { RecentBubble } = await import('/recent-bubble.mjs');
      const row = document.getElementById('call-bubble-first');
      const bubble = new RecentBubble([row, document.getElementById('call-bubble-second')]);
      bubble.append('assistant', 'hello world ', '宪宪');
      const bad = [];
      for (let index = 0; index < 60; index += 1) {
        const delta = `كلمة${index} `;
        bubble.append('assistant', delta, '宪宪');
        const message = row.querySelector('.recent-message');
        const text = row.querySelector('.recent-message-text').firstChild;
        const offset = text.data.lastIndexOf(delta);
        const range = document.createRange();
        range.setStart(text, offset);
        range.setEnd(text, offset + delta.length);
        const tail = range.getBoundingClientRect();
        const bounds = message.getBoundingClientRect();
        const hit = document.elementFromPoint((tail.left + tail.right) / 2, (tail.top + tail.bottom) / 2);
        if (tail.left < bounds.left - 0.5 || tail.right > bounds.right + 0.5 || !message.contains(hit)) bad.push(index);
      }
      return bad;
    });
    assert.deepEqual(streaming, []);
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

test('durable letter journey retries one identity, waits for a complete reply, then keeps history anchored', async () => {
  const page = await openPreview({ width: 460, height: 720 });
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  try {
    await page.evaluate(() => {
      window.__textV2 = [];
      window.__bridgeCommands = [];
      const bridge = window.clowderCompanion;
      const original = bridge.request.bind(bridge);
      bridge.request = command => {
        window.__bridgeCommands.push({ ...command });
        if (command.kind === 'text' && command.v === 2) window.__textV2.push({ ...command });
        return original(command);
      };
    });
    await page.click('#pet');
    await page.click('#name-card-actions [data-action="write"]');
    await page.waitForFunction(() => document.getElementById('chat')?.dataset.replyMode === 'compose');
    const emptyComposeLayout = await page.evaluate(() => {
      const feedback = document.querySelector('.chat-feedback');
      return { feedbackHidden: feedback.hidden, feedbackHeight: feedback.getBoundingClientRect().height };
    });
    assert.deepEqual(emptyComposeLayout, { feedbackHidden: true, feedbackHeight: 0 },
      JSON.stringify(emptyComposeLayout));
    await page.fill('#message', '把刚才那一步再讲慢一点');
    const focusRing = await page.locator('#message').evaluate(element => {
      const style = getComputedStyle(element);
      return {
        borderColor: style.borderColor,
        outlineColor: style.outlineColor,
        outlineOffset: Number.parseFloat(style.outlineOffset),
        outlineWidth: Number.parseFloat(style.outlineWidth),
      };
    });
    assert(focusRing.outlineWidth > 0 && focusRing.outlineOffset <= 0
      && (focusRing.borderColor === 'rgba(0, 0, 0, 0)' || focusRing.borderColor === focusRing.outlineColor),
    JSON.stringify(focusRing));
    await page.evaluate(() => { window.__previewUnconfirmNextText = true; });
    await page.click('#compose button[type="submit"]');
    try {
      await page.waitForFunction(() => document.getElementById('chat-status')?.textContent === '发送结果未确认',
        null, { timeout: 5_000 });
    } catch (error) {
      const diagnostic = await page.evaluate(() => ({
        chatStatus: document.getElementById('chat-status')?.textContent,
        connectionStatus: document.getElementById('chat-connection-status')?.textContent,
        input: document.getElementById('message')?.value,
        retryHidden: document.getElementById('reply-retry')?.hidden,
        mode: document.getElementById('chat')?.dataset.replyMode,
        sends: window.__textV2,
        draft: window.__getDraft?.(),
        commands: window.__bridgeCommands,
        submitHandler: typeof document.getElementById('compose')?.onsubmit,
        submitDisabled: document.querySelector('#compose button')?.disabled,
        composeHidden: document.getElementById('compose')?.hidden,
      }));
      throw new Error(`unconfirmed letter was not rendered: ${JSON.stringify({ ...diagnostic, pageErrors })}`, { cause: error });
    }
    assert.equal(await page.inputValue('#message'), '把刚才那一步再讲慢一点');

    await page.click('#reply-retry');
    await page.waitForFunction(() => !document.getElementById('reply-sent').hidden);
    const sentLayout = await page.evaluate(() => {
      const panel = document.getElementById('chat').getBoundingClientRect();
      const letter = document.getElementById('reply-letter-text');
      return {
        panel: { width: panel.width, height: panel.height },
        repeatedText: letter?.textContent ?? '',
        repeatedTextVisible: letter ? !letter.hidden : false,
        status: document.getElementById('reply-sent-status').textContent,
      };
    });
    assert.equal(sentLayout.repeatedText, '', JSON.stringify(sentLayout));
    assert.equal(sentLayout.repeatedTextVisible, false, JSON.stringify(sentLayout));
    assert(sentLayout.panel.width <= 150 && sentLayout.panel.height <= 90, JSON.stringify(sentLayout));
    assert.equal(sentLayout.status, '已发送');
    const sends = await page.evaluate(() => window.__textV2);
    assert.equal(sends.length, 2);
    assert.deepEqual(sends[1], sends[0], 'explicit retry must preserve scope, text, id and revision');
    assert.equal(await page.inputValue('#message'), '');

    const source = sends[0];
    const inputMessageId = `preview-text-${source.clientMessageId}`;
    const userRow = {
      id: inputMessageId, role: 'user', name: '预览输入', text: source.text,
      inputMessageIds: [], responsePhase: null,
      body: { revision: `preview-${inputMessageId}`, complete: true, continuation: null },
      deliveryReceipt: {
        kind: 'delivery', v: 2, delivery: 'accepted', clientMessageId: source.clientMessageId,
        messageId: inputMessageId, callId: null,
      },
    };
    await page.evaluate(({ userRow, inputMessageId }) => window.__setConversation([
      userRow,
      { id: 'reply-a', role: 'assistant', name: '宪宪', text: '正在整理第一段',
        inputMessageIds: [inputMessageId], responsePhase: 'processing',
        body: { revision: 'reply-a-draft', complete: true, continuation: null } },
    ]), { userRow, inputMessageId });
    await page.waitForFunction(() => document.getElementById('reply-sent-status')?.textContent === '正在回复');
    assert.equal(await page.locator('#reply-card').isHidden(), true);

    await page.evaluate(({ userRow, inputMessageId }) => {
      window.__setBodyReply('body.reply-a.1', {
        kind: 'conversation-body', v: 2, status: 'available', messageId: 'reply-a',
        text: '第二段把细节补全。',
        body: { revision: 'reply-a-final', complete: true, continuation: null },
      });
      window.__setConversation([
        userRow,
        { id: 'reply-a', role: 'assistant', name: '宪宪', text: '第一段先从起点讲。',
          inputMessageIds: [inputMessageId], responsePhase: 'completed',
          body: { revision: 'reply-a-final', complete: false, continuation: 'body.reply-a.1' } },
      ]);
    }, { userRow, inputMessageId });
    await page.waitForFunction(() => document.getElementById('reply-body')?.textContent.includes('第二段把细节补全。'));
    assert.equal(await page.locator('#reply-retain').isVisible(), true);
    const countdownRing = await page.evaluate(() => {
      const ring = getComputedStyle(document.getElementById('reply-retain'));
      const progress = getComputedStyle(document.querySelector('.reply-ring-progress'));
      return { controlColor: ring.color, progressColor: progress.stroke,
        strokeWidth: Number.parseFloat(progress.strokeWidth) };
    });
    assert.equal(countdownRing.progressColor, countdownRing.controlColor, JSON.stringify(countdownRing));
    assert(countdownRing.strokeWidth <= 1, JSON.stringify(countdownRing));
    assert.deepEqual((await visibleClipping(page, 'chat')).clippedButtons, []);
    await page.click('#reply-retain');
    assert.equal(await page.locator('#reply-close').isVisible(), true);
    const replyCloseLayout = await page.evaluate(() => {
      const button = document.getElementById('reply-close').getBoundingClientRect();
      const icon = document.querySelector('#reply-close svg')?.getBoundingClientRect();
      return { hasIcon: Boolean(icon), button: { x: button.x, y: button.y, width: button.width, height: button.height },
        icon: icon ? { x: icon.x, y: icon.y, width: icon.width, height: icon.height } : null,
        deltaX: icon ? (icon.left + icon.width / 2) - (button.left + button.width / 2) : null,
        deltaY: icon ? (icon.top + icon.height / 2) - (button.top + button.height / 2) : null };
    });
    assert.equal(replyCloseLayout.hasIcon, true, JSON.stringify(replyCloseLayout));
    assert(Math.abs(replyCloseLayout.deltaX) < .5 && Math.abs(replyCloseLayout.deltaY) < .5,
      JSON.stringify(replyCloseLayout));
    await page.evaluate(({ userRow, inputMessageId }) => {
      const olderRows = Array.from({ length: 18 }, (_, index) => ({
        id: `history-${String(index + 1).padStart(2, '0')}`,
        role: index % 2 ? 'assistant' : 'user',
        name: index % 2 ? '宪宪' : '你',
        text: `更早的第 ${index + 1} 条聊天，用足够长的正文让真实 transcript 产生可滚动高度。`,
        inputMessageIds: [], responsePhase: null,
        body: { revision: `history-${index + 1}`, complete: true, continuation: null },
      }));
      window.__setConversationPage({
        messages: [...olderRows, userRow,
          { id: 'reply-a', role: 'assistant', name: '宪宪', text: '第一段先从起点讲。第二段把细节补全。',
            inputMessageIds: [inputMessageId], responsePhase: 'completed',
            body: { revision: 'reply-a-final', complete: true, continuation: null } }],
        hasMoreOlder: true,
        olderCursor: 'history.before-01',
      });
      window.__setOlderConversationPage('history.before-01', {
        messages: [
          { id: 'history-00a', role: 'user', name: '你', text: '最早一页 A', inputMessageIds: [], responsePhase: null,
            body: { revision: 'history-00a', complete: true, continuation: null } },
          { id: 'history-00b', role: 'assistant', name: '宪宪', text: '最早一页 B', inputMessageIds: [], responsePhase: null,
            body: { revision: 'history-00b', complete: true, continuation: null } },
        ],
        hasMoreOlder: false,
        olderCursor: null,
      });
    }, { userRow, inputMessageId });
    await page.waitForFunction(() => document.querySelectorAll('#chat-transcript > p[data-message-id]').length >= 20);
    assert.equal(await page.locator('#chat-transcript').isHidden(), true,
      'the long page must first be projected while transcript geometry is hidden');
    await page.click('#reply-history-open');
    await page.waitForFunction(() => !document.getElementById('chat-transcript').hidden);
    const replyHistoryChrome = await page.evaluate(() => ({
      presentation: document.getElementById('chat').dataset.historyPresentation,
      composeHidden: document.getElementById('compose').hidden,
      feedbackHidden: document.querySelector('.chat-feedback').hidden,
      scopeHidden: document.getElementById('chat-scope').hidden,
      emptyConnectionHeight: document.getElementById('chat-connection-status').getBoundingClientRect().height,
      titleHidden: document.getElementById('chat-name').hidden,
      fullDismissHidden: document.getElementById('chat-history-dismiss')?.hidden,
      replyCloseVisible: document.getElementById('reply-history-close')
        ? !document.getElementById('reply-history-close').hidden : false,
    }));
    assert.deepEqual(replyHistoryChrome, {
      presentation: 'reply', composeHidden: true, feedbackHidden: true, scopeHidden: true,
      emptyConnectionHeight: 0, titleHidden: true, fullDismissHidden: true, replyCloseVisible: true,
    }, JSON.stringify(replyHistoryChrome));
    const selectedVisibility = await page.evaluate(() => {
      const transcript = document.getElementById('chat-transcript');
      const viewport = transcript.getBoundingClientRect();
      const selected = transcript.querySelector('[data-message-id="reply-a"]').getBoundingClientRect();
      return { visible: selected.bottom > viewport.top && selected.top < viewport.bottom,
        selected: { top: selected.top, bottom: selected.bottom },
        viewport: { top: viewport.top, bottom: viewport.bottom } };
    });
    assert.equal(selectedVisibility.visible, true, JSON.stringify(selectedVisibility));

    const topAnchor = await page.evaluate(() => {
      const transcript = document.getElementById('chat-transcript');
      transcript.scrollTop = 0;
      const viewport = transcript.getBoundingClientRect();
      const row = transcript.querySelector('p[data-message-id]');
      const rect = row.getBoundingClientRect();
      return { id: row.dataset.messageId, offset: rect.top - viewport.top };
    });
    await page.locator('#chat-transcript').hover();
    await page.mouse.wheel(0, -200_000);
    await page.waitForFunction(() => window.__getConversationReads()
      .filter(read => read.before === 'history.before-01').length === 1);
    await page.waitForFunction(() => document.querySelector('[data-message-id="history-00a"]'));
    const preservedAnchor = await page.evaluate(anchor => {
      const transcript = document.getElementById('chat-transcript');
      const viewport = transcript.getBoundingClientRect();
      const row = transcript.querySelector(`[data-message-id="${anchor.id}"]`);
      return { id: row.dataset.messageId, offset: row.getBoundingClientRect().top - viewport.top,
        olderReads: window.__getConversationReads().filter(read => read.before !== null).length };
    }, topAnchor);
    assert.equal(preservedAnchor.id, topAnchor.id);
    assert(Math.abs(preservedAnchor.offset - topAnchor.offset) < 1,
      JSON.stringify({ topAnchor, preservedAnchor }));
    assert.equal(preservedAnchor.olderReads, 1);

    assert.equal(await page.locator('#compose').isHidden(), true,
      'retained-reply history stays read-only while newer conversation arrives');
    const secondMessageId = 'preview-text-external-newer';
    const secondUser = {
      id: secondMessageId, role: 'user', name: '你', text: '第二封信',
      inputMessageIds: [], responsePhase: null,
      body: { revision: `preview-${secondMessageId}`, complete: true, continuation: null },
      deliveryReceipt: {
        kind: 'delivery', v: 2, delivery: 'accepted', clientMessageId: 'external-newer',
        messageId: secondMessageId, callId: null,
      },
    };
    await page.evaluate(({ userRow, inputMessageId, secondUser, secondMessageId }) => window.__setConversation([
      userRow,
      { id: 'reply-a', role: 'assistant', name: '宪宪', text: '第一段先从起点讲。第二段把细节补全。',
        inputMessageIds: [inputMessageId], responsePhase: 'completed',
        body: { revision: 'reply-a-final', complete: true, continuation: null } },
      secondUser,
      { id: 'reply-b', role: 'assistant', name: '宪宪', text: '第二封也回来了。',
        inputMessageIds: [secondMessageId], responsePhase: 'completed',
        body: { revision: 'reply-b-final', complete: true, continuation: null } },
    ]), { userRow, inputMessageId, secondUser, secondMessageId });
    await page.waitForFunction(() => !document.getElementById('reply-return-latest').hidden);
    const returnLatestLayout = await page.evaluate(() => {
      const bounds = selector => {
        const rect = document.querySelector(selector).getBoundingClientRect();
        return { top: rect.top, right: rect.right, bottom: rect.bottom, left: rect.left };
      };
      const intersects = (left, right) => Math.min(left.right, right.right) > Math.max(left.left, right.left)
        && Math.min(left.bottom, right.bottom) > Math.max(left.top, right.top);
      const button = bounds('#reply-return-latest');
      const transcript = bounds('#chat-transcript');
      const compose = bounds('#compose');
      const input = bounds('#message');
      const send = bounds('#compose button[type="submit"]');
      return {
        button, transcript, compose, input, send,
        buttonInsideTranscript: button.left >= transcript.left && button.right <= transcript.right
          && button.top >= transcript.top && button.bottom <= transcript.bottom,
        horizontallyCentered: Math.abs((button.left + button.right) / 2
          - (transcript.left + transcript.right) / 2) < 1,
        overlaps: {
          compose: intersects(button, compose),
          input: intersects(button, input),
          send: intersects(button, send),
        },
      };
    });
    assert.equal(returnLatestLayout.buttonInsideTranscript, true, JSON.stringify(returnLatestLayout));
    assert.equal(returnLatestLayout.horizontallyCentered, true, JSON.stringify(returnLatestLayout));
    assert.deepEqual(returnLatestLayout.overlaps, { compose: false, input: false, send: false },
      JSON.stringify(returnLatestLayout));
    await page.click('#reply-return-latest');
    assert.equal(await page.locator('#reply-return-latest').isHidden(), true);
    assert.equal(await page.locator('#chat-transcript').isVisible(), true);
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
