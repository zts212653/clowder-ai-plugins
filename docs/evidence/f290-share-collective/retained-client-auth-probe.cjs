// Uses the retained, packaged Client with synthetic Service and identity responses.
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require(require.resolve('playwright', {
  paths: [path.resolve(__dirname, '../../../packages/companion')],
}));

const root = process.env.F290_CLIENT_ASSET_ROOT || path.resolve(__dirname, '../../../packages/collective-connector/assets/client');
const invited = 'col_12345678';
const other = 'col_87654321';
let completedTarget = invited;
let profileFailuresLeft = 0;
let beginPayload;
const requests = [];
const createdAt = '2026-01-01T00:00:00.000Z';
const membership = (collectiveId, name) => ({ collectiveId, name, createdByHumanId: 'human_owner', createdAt, role: 'member' });
const payloads = {
  '/api/meta': { serviceInstanceId: 'service-test', bootstrapNeeded: false, onboardingComplete: true, clientBuildId: 'test' },
  '/api/auth/providers': { providers: [{ id: 'github', ready: true }] },
  '/api/auth/github/begin': { authorizationUrl: 'https://github.com/login/oauth/authorize?client_id=fixture' },
  '/api/me': { human: { humanId: 'human_12345678', displayName: 'Friend', createdAt }, auth: { provider: 'github', handle: 'friend' }, collectives: [membership(other, 'Other Collective'), membership(invited, 'Invited Collective')] },
  '/api/events/human': { events: [] },
  '/api/participants': { participants: [] },
  '/api/members': { humans: [], cafes: [] },
  '/api/collaboration': { serviceInstanceId: 'service-test', collectiveId: invited, works: [], roadmaps: [], votes: [], bindingVotes: [], decisions: [] },
  '/api/channel-state': { draft: { serviceInstanceId: 'service-test', collectiveId: invited, channelId: 'general', humanId: 'human_12345678', revision: 0, content: { body: '', recipient: { kind: 'channel' }, recipientLabel: '' } }, read: { sequence: 0 }, unreadCount: 0 },
  '/api/artifacts': { artifacts: [] },
};
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  if (u.pathname.startsWith('/api/')) {
    requests.push(`${req.method} ${u.pathname}`);
    if (u.pathname === '/api/auth/github/begin') {
      let body = '';
      for await (const chunk of req) body += chunk;
      beginPayload = JSON.parse(body);
    }
    if (u.pathname === '/api/me' && profileFailuresLeft > 0) {
      profileFailuresLeft--;
      res.writeHead(503, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'Fixture network interrupted' } }));
    }
    if (u.pathname === '/api/auth/completions/exchange') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ sessionToken: 'verified-session-token', collectiveId: completedTarget }));
    }
    if (payloads[u.pathname]) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(payloads[u.pathname]));
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ error: { message: `Unexpected test endpoint ${u.pathname}` } }));
  }
  const file = u.pathname === '/' ? 'index.html' : u.pathname.replace(/^\//, '');
  try {
    const data = await fs.readFile(path.join(root, file));
    const contentType = file.endsWith('.html') ? 'text/html' : file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'image/png';
    res.writeHead(200, { 'content-type': contentType });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end('not found');
  }
});
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await context.route('https://github.com/login/oauth/authorize**', route => route.fulfill({ status: 302, headers: { location: `${base}/?authCompleted=1` }, body: '' }));
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', err => errors.push(String(err)));
    await page.goto(`${base}/#invite=example`, { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: /使用 GitHub 验证并加入/ }).click();
    await page.waitForURL(url => url.searchParams.get('collectiveId') === invited, { timeout: 10000 });
    await page.getByText('Invited Collective', { exact: true }).first().waitFor({ state: 'visible', timeout: 10000 });
    await page.waitForLoadState('networkidle');
    assert.equal(await page.getByText('暂时离线', { exact: true }).count(), 0);
    assert.equal(await page.getByText(/Unexpected test endpoint/).count(), 0);
    assert.equal(new URL(page.url()).searchParams.get('channelId'), 'general');
    assert.equal(new URL(page.url()).hash, '');
    assert.ok(requests.includes('POST /api/auth/github/begin'));
    assert.deepEqual(beginPayload, { intent: 'accept_invite', inviteToken: 'example' });
    assert.ok(requests.includes('POST /api/auth/completions/exchange'));
    assert.equal(errors.length, 0, errors.join('\n'));
    if (process.env.F290_SCREENSHOT_PATH) await page.screenshot({ path: process.env.F290_SCREENSHOT_PATH, fullPage: true });
    console.log(JSON.stringify({ scenario: 'invite-click-popup-to-multi-collective-target', result: 'pass', backend: 'synthetic', target: invited }));
    await context.close();
    completedTarget = 'col_99999999';
    const deniedContext = await browser.newContext();
    await deniedContext.route('https://github.com/login/oauth/authorize**', route => route.fulfill({ status: 302, headers: { location: `${base}/?authCompleted=1` }, body: '' }));
    const denied = await deniedContext.newPage();
    await denied.goto(`${base}/#invite=example`, { waitUntil: 'networkidle' });
    await denied.getByRole('button', { name: /使用 GitHub 验证并加入/ }).click();
    await denied.getByText('邀请的共同体暂时不可用，请联系邀请人。').waitFor({ state: 'visible', timeout: 10000 });
    const state = await denied.evaluate(() => ({ search: location.search, saved: sessionStorage.getItem(`collective-session:${location.origin}`) }));
    assert.equal(new URLSearchParams(state.search).has('collectiveId'), false);
    assert.equal(state.saved, null);
    console.log(JSON.stringify({ scenario: 'invite-target-not-in-memberships', result: 'pass', backend: 'synthetic' }));
    await deniedContext.close();
    completedTarget = invited;
    profileFailuresLeft = 1;
    const retryContext = await browser.newContext();
    await retryContext.route('https://github.com/login/oauth/authorize**', route => route.fulfill({ status: 302, headers: { location: `${base}/?authCompleted=1` }, body: '' }));
    const retry = await retryContext.newPage();
    await retry.goto(`${base}/#invite=example`, { waitUntil: 'networkidle' });
    await retry.getByRole('button', { name: /使用 GitHub 验证并加入/ }).click();
    await retry.getByText('Fixture network interrupted').waitFor({ state: 'visible', timeout: 10000 });
    assert.equal(new URL(retry.url()).searchParams.get('collectiveId'), invited);
    await retry.reload({ waitUntil: 'networkidle' });
    await retry.getByText('Invited Collective', { exact: true }).first().waitFor({ state: 'visible', timeout: 10000 });
    console.log(JSON.stringify({ scenario: 'invite-target-survives-profile-network-failure-and-reload', result: 'pass', backend: 'synthetic' }));
    await retryContext.close();
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
