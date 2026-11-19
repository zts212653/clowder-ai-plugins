import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';
import { createPreviewServer } from '../scripts/preview.mjs';

// livingBody: with the living cat chosen, the Host's body window draws him. The panel page must not draw a second cat,
// while its menu, chat, settings, decisions badge and layout requests keep working.
let browser;
let origin;
let server;

before(async () => {
  server = createPreviewServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true });
});

after(async () => {
  await browser?.close();
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
});

async function openPanel() {
  const page = await browser.newPage({ viewport: { width: 600, height: 800 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${origin}/index.html?skin=xianxian-codex&pending=1&autoTranscript=0&appAssist=0`);
  await page.waitForLoadState('networkidle');
  await page.evaluate(() => {
    window.__requests = [];
    const bridge = window.clowderCompanion;
    const original = bridge.request.bind(bridge);
    bridge.request = command => { window.__requests.push(structuredClone(command)); return original(command); };
  });
  return { page, errors };
}

/** What a person sees of the panel's own cat. */
const panelCat = page => page.evaluate(() => {
  const pet = document.getElementById('pet');
  const box = pet.getBoundingClientRect();
  const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
  const style = getComputedStyle(pet);
  return {
    skin: pet.dataset.skin,
    shown: style.visibility !== 'hidden' && style.display !== 'none',
    clickable: hit === pet || pet.contains(hit),
    drawn: style.backgroundImage !== 'none'
      || ['living-sit', 'living-video', 'living-video-transition'].some(id => !document.getElementById(id).hidden),
  };
});

test('choosing 宪宪（活猫） removes the panel\'s own cat, switching back restores it, and menu, chat and the badge keep working', async () => {
  const { page, errors } = await openPanel();
  try {
    assert.deepEqual(await panelCat(page), { skin: 'xianxian-codex', shown: true, clickable: true, drawn: true });
    await page.click('#pet');
    await page.click('#menu-settings');
    await page.click('#settings-look-open');
    assert.equal(await page.locator('#settings-skin-xianxian-living').isVisible(), true, 'this package is on the livingBody line');
    assert.equal(await page.locator('#settings-skin-xianxian-living').textContent(), '宪宪（活猫）');

    await page.click('#settings-skin-xianxian-living');
    await page.waitForFunction(() => document.getElementById('pet').dataset.skin === 'xianxian-living');
    assert.deepEqual(await panelCat(page), { skin: 'xianxian-living', shown: false, clickable: false, drawn: false },
      'one cat on screen: the Host\'s body window draws him');
    assert.equal(await page.locator('#settings-look-value').textContent(), '宪宪（活猫）');
    assert.equal(await page.locator('#settings-notice').textContent(), '外观已保存');
    assert.ok((await page.evaluate(() => window.__requests)).some(command => command.kind === 'settings.update'
      && command.field === 'skin' && command.value === 'xianxian-living'), 'saved through the existing settings path');

    await page.click('#settings-skin-xianxian-codex');
    await page.waitForFunction(() => document.getElementById('pet').dataset.skin === 'xianxian-codex');
    assert.deepEqual(await panelCat(page), { skin: 'xianxian-codex', shown: true, clickable: true, drawn: true },
      'another skin brings the panel\'s cat back');

    await page.click('#settings-skin-xianxian-living');
    await page.waitForFunction(() => document.getElementById('pet').dataset.skin === 'xianxian-living');
    await page.waitForTimeout(1200);   // a state refresh from the Host agrees and keeps him away
    assert.equal((await panelCat(page)).shown, false);
    await page.evaluate(() => { window.__requests = []; });
    await page.click('#settings-back');
    await page.click('#settings-back');
    await page.waitForFunction(() => !document.getElementById('menu').hidden);
    await page.locator('#menu [data-action="write"]:visible').click();
    await page.waitForFunction(() => !document.getElementById('chat').hidden && !document.getElementById('compose').hidden);
    await page.fill('#message', '活猫在桌面上');
    assert.equal(await page.locator('#message').inputValue(), '活猫在桌面上', 'chat is usable');
    const layouts = (await page.evaluate(() => window.__requests)).filter(command => command.kind === 'view.layout').map(command => command.panel);
    assert.ok(layouts.includes('menu') && layouts.includes('chat'), `panels still ask the Host for their layout: ${layouts.join(', ')}`);

    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.getElementById('chat').hidden);
    const badge = await page.evaluate(() => {
      const node = document.getElementById('pending-badge');
      const box = node.getBoundingClientRect();
      const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      return { visible: !node.hidden && box.width > 0, hit: hit === node || node.contains(hit) };
    });
    assert.deepEqual(badge, { visible: true, hit: true }, 'the pending badge stays visible and clickable without the ball');
    await page.click('#pending-badge');
    await page.waitForFunction(() => !document.getElementById('decisions').hidden);

    const box = await page.locator('#anchor').boundingBox();
    await page.mouse.move(box.x + 30, box.y + 60);
    await page.mouse.down();
    await page.mouse.move(box.x + 80, box.y + 90, { steps: 4 });
    await page.mouse.up();
    assert.equal((await page.evaluate(() => window.__requests)).some(command => command.kind === 'view.drag'), false,
      'where the ball was there is nothing to drag');
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
});

/** The Host's answer to body.menu (a context click on the living cat in the body window). */
const hostOpensMenu = page => page.evaluate(() => window.__previewEmit({ kind: 'view-open', panel: 'menu' }));
const menuLayouts = page => page.evaluate(() => window.__requests.filter(command => command.kind === 'view.layout'
  && command.panel === 'menu').length);

test('a context click on the living cat opens the panel\'s own menu where the Host places it, and another panel gives way', async () => {
  const { page, errors } = await openPanel();
  try {
    await page.click('#pet');
    await page.click('#menu-settings');
    await page.click('#settings-look-open');
    await page.click('#settings-skin-xianxian-living');
    await page.waitForFunction(() => document.getElementById('pet').dataset.skin === 'xianxian-living');
    await page.evaluate(() => {
      // the Host places the menu beside the body's last anchor (placePanelForBody), not where the panel would put it
      const bridge = window.clowderCompanion;
      const request = bridge.request.bind(bridge);
      bridge.request = async command => {
        const reply = await request(command);
        return command.kind === 'view.layout' && command.panel === 'menu'
          ? { ...reply, panel: { ...reply.panel, x: 40, y: 24 } } : reply;
      };
      window.__requests = [];
    });
    assert.equal(await page.locator('#settings').isVisible(), true, 'settings is still open when the cat is right-clicked');

    await hostOpensMenu(page);
    await page.waitForFunction(() => !document.getElementById('menu').hidden);
    assert.equal(await page.locator('#settings').isHidden(), true, 'the open panel gives way to the menu, as for a context click');
    assert.equal(await menuLayouts(page), 1, 'the menu asks the Host for its layout through the ordinary view.layout path');
    assert.deepEqual(await page.evaluate(() => {
      const menu = document.getElementById('menu');
      return { left: menu.style.left, top: menu.style.top };
    }), { left: '40px', top: '24px' }, 'the menu stands where the Host placed it, beside the cat');

    await hostOpensMenu(page);
    await page.waitForTimeout(200);
    assert.equal(await page.locator('#menu').isVisible(), true, 'a second context click keeps the menu open, it does not toggle');

    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.getElementById('menu').hidden);
    await hostOpensMenu(page);
    await page.waitForFunction(() => !document.getElementById('menu').hidden);
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
});

test('with a ball skin the panel ignores view-open: the ball has its own context click', async () => {
  const { page, errors } = await openPanel();
  try {
    await hostOpensMenu(page);
    await page.waitForTimeout(300);
    assert.equal(await page.locator('#menu').isHidden(), true);
    assert.equal(await menuLayouts(page), 0, 'no layout is requested for a menu nobody asked for');

    await page.click('#pet');
    await page.click('#menu-settings');
    await page.waitForFunction(() => !document.getElementById('settings').hidden);
    await page.evaluate(() => { window.__requests = []; });
    await hostOpensMenu(page);
    await page.waitForTimeout(300);
    assert.equal(await page.locator('#settings').isVisible(), true, 'an open panel stays open');
    assert.equal(await menuLayouts(page), 0);
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
});
