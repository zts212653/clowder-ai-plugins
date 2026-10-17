import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { chromium } from 'playwright';
import { launchOwnedBrowser } from './owned-browser.mjs';

// Component journey: production repair/navigation/auth modules use an actual HTTP
// fixture. This proves browser wiring and scope guards, not CodeHub permissions.
const binding = 'a'.repeat(64),
  runId = 'b'.repeat(32),
  deliveryId = 'c'.repeat(24);
function fixture(code = 'ISSUE_AUTH_REQUIRED') {
  return {
    token: 'synthetic-csrf',
    connection: { revision: 'synthetic-revision' },
    workspace: { projectId: 'default' },
    config: {
      bindingId: binding,
      mode: 'continuous',
      targetBranch: 'main',
      platformApi: {
        mode: 'gitlab',
        apiUrl: 'https://synthetic-api.example/api/v4',
        projectId: 'team/core',
        authentication: { available: false },
      },
    },
    sourceAuthentication: { available: false },
    state: {
      automation: { id: runId, status: 'FAILED' },
      active: { id: deliveryId, status: 'PR_REQUIRED', error: { code, message: '认证过期；已创建对象保留' } },
    },
  };
}
let current = fixture();
const requests = [],
  actions = [];
const html = `<!doctype html><meta charset="utf-8"><title>Auth recovery component journey</title>
<style>body{font-family:sans-serif;max-width:1000px;margin:30px auto}button,input{margin:8px;padding:8px}details{padding:10px}</style>
<div id="error" hidden></div><main id="content"></main>
<script type="module">
import { createRecoveryNavigation } from '/recovery-navigation.mjs';
import { createIssueAuthentication, authenticationForm } from '/issue-auth.mjs';
import { createGithubAuthentication, githubAuthForm } from '/github-auth.mjs';
import { errorGuide } from '/error-guide.mjs';
let snapshot = await (await fetch('/api/status')).json();
let view = new URL(location.href).searchParams.get('view') ?? 'workbench';
const content = document.getElementById('content');
const recovery = createRecoveryNavigation({ snapshot: () => snapshot, changeView, action: async(input) => {
  const response = await fetch('/api/action', { method: 'POST', headers: {'Content-Type':'application/json'}, body:JSON.stringify(input) });
  if(!response.ok) throw Error('fixture resume failed');
} });
const issue = createIssueAuthentication(() => snapshot, refresh, document.getElementById('error'));
const github = createGithubAuthentication(() => snapshot, refresh);
function render() {
  content.innerHTML = view === 'workbench' ? errorGuide(snapshot.state.active.error, {deliveryId:snapshot.state.active.id})
    : '<details id="platform-details"><summary>平台设置</summary>' + authenticationForm(snapshot.config) + '</details>' + githubAuthForm(snapshot);
  recovery.mount(content,view);
}
function changeView(next) { view=next; const url=new URL(location.href);url.searchParams.set('view',view); history.replaceState(null,'',url);render(); }
async function refresh() { snapshot=await(await fetch('/api/status')).json();render(); }
window.refreshRepairFixture=refresh;
document.addEventListener('submit', async(event) => {
  event.preventDefault();
  if(event.target.matches('[data-secret-form]')) await issue.submit(event.target);
  if(event.target.matches('[data-github-auth]')) await github.submit(event.target);
});
render();
</script>`;
const server = createServer(async (request, response) => {
  response.setHeader('Cache-Control', 'no-store');
  const path = new URL(request.url, 'http://localhost').pathname;
  if (request.method === 'GET' && path === '/') {
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end(html);
    return;
  }
  if (request.method === 'GET' && /^\/[\w-]+\.mjs$/.test(path)) {
    try {
      const data = await readFile(new URL(`../web${path}`, import.meta.url));
      response.setHeader('Content-Type', 'text/javascript; charset=utf-8');
      response.end(data);
      return;
    } catch {
      response.writeHead(404).end();
      return;
    }
  }
  if (request.method === 'GET' && path === '/api/status') {
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify(current));
    return;
  }
  if (request.method === 'POST') {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (path === '/api/action') actions.push(value);
    else if (['/api/issue-auth', '/api/github-auth'].includes(path)) {
      assert.equal(request.headers['x-repo-sync-token'], current.token);
      assert.equal(value.expectedRevision, current.connection.revision);
      assert.equal(value.projectId, 'default');
      requests.push({ path, scope: value.expectedRevision, hasToken: Boolean(value.token) });
      if (path === '/api/issue-auth')
        current.config.platformApi.authentication.available = Boolean(value.token);
      else {
        assert.equal(value.expectedBinding, current.config.bindingId);
        current.sourceAuthentication.available = Boolean(value.token);
      }
    } else {
      response.writeHead(404).end();
      return;
    }
    response.setHeader('Content-Type', 'application/json');
    response.end('{}');
    return;
  }
  response.writeHead(404).end();
});
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const base = `http://127.0.0.1:${server.address().port}`;
const { browser, close: closeBrowser } = await launchOwnedBrowser(chromium, {
  headless: true,
  executablePath: process.env.REPO_SYNC_CHROME,
});
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
page.setDefaultTimeout(10000);
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
async function reset(code) {
  current = fixture(code);
  await page.goto(`${base}/?project=default`);
  await page.evaluate(() => sessionStorage.clear());
  await page.reload();
  await page.locator('[data-repair]').waitFor();
}
async function provide(kind) {
  const selector = kind === 'platform' ? '[data-secret-form]' : '[data-github-auth]';
  const label = kind === 'platform' ? '内部平台 Token' : 'GitHub 读取 Token';
  await page.getByLabel(label, { exact: true }).fill('synthetic-private-token');
  await page.locator(`${selector} button[type="submit"]`).click();
  await page.getByRole('button', { name: '继续原同步 →', exact: true }).waitFor();
  await page.waitForFunction(() => !document.querySelector('[data-recovery-resume]')?.disabled);
  assert.equal(await page.getByLabel(label, { exact: true }).inputValue(), '');
  assert.equal(
    await page.evaluate(() => JSON.stringify({ ...sessionStorage }).includes('synthetic-private-token')),
    false,
  );
}
try {
  for (const [kind, code, path] of [
    ['platform', 'ISSUE_API_REJECTED', '/api/issue-auth'],
    ['github', 'GITHUB_AUTH_REQUIRED', '/api/github-auth'],
  ]) {
    await reset(code);
    await page.locator(`[data-repair="${kind}"]`).click();
    assert.equal(new URL(page.url()).searchParams.get('view'), 'configuration');
    const resume = page.getByRole('button', { name: '继续原同步 →', exact: true });
    assert.equal(await resume.isDisabled(), true);
    const auth = kind === 'platform' ? '#issue-auth' : '#github-source-auth';
    await page.locator(`${auth} input[type="password"]`).waitFor({ state: 'visible' });
    if (kind === 'platform')
      assert.equal(await page.locator('#issue-auth .credential-scope').isVisible(), true);
    assert.equal(
      await page
        .locator(`${auth} input[type="password"]`)
        .evaluate((field) => document.activeElement === field),
      true,
    );
    await page.reload();
    await page.locator('#recovery-return').waitFor();
    assert.equal(await resume.isDisabled(), true);
    if (kind === 'github') await page.locator('#github-source-auth summary').click();
    else await page.locator('#platform-details summary').click();
    await provide(kind);
    assert.equal(requests.at(-1).path, path);
    await page.reload();
    await page.waitForFunction(() => !document.querySelector('[data-recovery-resume]')?.disabled);
    const previous = actions.length;
    await resume.click();
    await page.waitForFunction(() => new URL(location.href).searchParams.get('view') === 'workbench');
    await new Promise((done) => setTimeout(done, 50));
    assert.equal(actions.length, previous + 1);
    assert.deepEqual(actions.at(-1), { action: 'resume-sync', runId, deliveryId });
  }
  await reset('ISSUE_AUTH_REQUIRED');
  await page.locator('[data-repair="platform"]').click();
  await provide('platform');
  const previous = actions.length;
  current.state.active.id = 'd'.repeat(24);
  await page.evaluate(() => window.refreshRepairFixture());
  assert.equal(await page.locator('[data-recovery-resume]').isDisabled(), true);
  await page.locator('[data-recovery-resume]').dispatchEvent('click');
  assert.equal(actions.length, previous);
  current.state.active.id = deliveryId;
  current.state.automation.id = 'f'.repeat(32);
  await page.evaluate(() => window.refreshRepairFixture());
  await page.locator('[data-recovery-resume]').dispatchEvent('click');
  assert.equal(actions.length, previous);
  current.state.automation.id = runId;
  current.config.bindingId = 'e'.repeat(64);
  await page.evaluate(() => window.refreshRepairFixture());
  await page.locator('[data-recovery-resume]').dispatchEvent('click');
  assert.equal(actions.length, previous);
  await reset('ISSUE_AUTH_REQUIRED');
  await page.locator('[data-repair="platform"]').click();
  await provide('platform');
  current.config.platformApi.authentication.available = false;
  await page.reload();
  await page.locator('#recovery-return').waitFor();
  assert.equal(
    await page.locator('[data-recovery-resume]').isDisabled(),
    true,
    'a persisted provided flag must not substitute for missing credentials after a service restart',
  );
  await page.locator('#platform-details summary').click();
  await provide('platform');
  for (const status of ['IMPORTED', 'EXPORTED']) {
    current.transfer = { status };
    await page.evaluate(() => window.refreshRepairFixture());
    assert.equal(
      await page.locator('[data-recovery-resume]').isDisabled(),
      true,
      'a migration hold must disable resume visibly, not silently ignore an enabled button',
    );
  }
  await reset('ISSUE_AUTH_REQUIRED');
  await page.locator('[data-repair="platform"]').evaluate((button) => {
    button.dataset.repairDelivery = '1'.repeat(24);
  });
  await page.locator('[data-repair="platform"]').click();
  assert.equal(
    await page.locator('[data-recovery-resume]').count(),
    0,
    'a historical failure can repair authentication but cannot resume the unrelated live delivery',
  );
  await reset('ISSUE_AUTH_REQUIRED');
  await page.locator('[data-repair="platform"]').click();
  await page.locator('#github-source-auth summary').click();
  await page.getByLabel('GitHub 读取 Token', { exact: true }).fill('synthetic-wrong-channel-token');
  await page.locator('[data-github-auth] button[type="submit"]').click();
  await page.locator('[data-github-feedback]').filter({ hasText: '令牌已提供' }).waitFor();
  assert.equal(
    await page.locator('[data-recovery-resume]').isDisabled(),
    true,
    'providing GitHub credentials must not satisfy an internal-platform repair',
  );
  await reset('ISSUE_AUTH_REQUIRED');
  await page.locator('[data-repair="platform"]').click();
  current.state.active = null;
  current.state.automation.status = 'COMPLETE';
  await page.evaluate(() => window.refreshRepairFixture());
  assert.equal(
    await page.locator('[data-recovery-resume]').count(),
    0,
    'completed run cannot retain a resume button',
  );
  assert.equal(
    await page.evaluate(() => JSON.parse(sessionStorage.getItem('repo-sync-repair:default'))),
    null,
  );
  await page.reload();
  assert.equal(
    await page.locator('#recovery-return').count(),
    0,
    'retired context stays retired after refresh',
  );
  assert.equal(
    actions.some((item) => item.action === 'synchronize'),
    false,
  );
  assert.deepEqual(errors, []);
  console.log(
    'Auth repair browser journey passed: real local HTTP auth, original resume, refresh, scope and migration holds',
  );
} finally {
  await closeBrowser();
  await new Promise((done, reject) => server.close((error) => (error ? reject(error) : done())));
}
