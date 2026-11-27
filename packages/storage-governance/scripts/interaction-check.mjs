import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const chromePath = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const preview = join(root, 'test-output', 'preview.html');
const profile = join(root, 'test-output', 'chrome-cdp-profile');
const port = 9333;
const errors = [];

const chrome = spawn(
  chromePath,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--window-size=1440,2200',
    `file:///${preview.replaceAll('\\', '/')}`,
  ],
  { stdio: 'ignore' },
);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function target() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      const list = await response.json();
      const page = list.find((item) => item.type === 'page' && String(item.url).includes('preview.html'));
      if (page) return page;
    } catch {
      // Chrome is still starting.
    }
    await sleep(250);
  }
  throw new Error('Chrome DevTools target did not appear');
}

const page = await target();
const socket = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true });
  socket.addEventListener('error', reject, { once: true });
});

let sequence = 0;
const pending = new Map();
socket.addEventListener('message', (event) => {
  const message = JSON.parse(event.data);
  if (message.method === 'Runtime.exceptionThrown') {
    errors.push(message.params.exceptionDetails.text || 'runtime exception');
  }
  if (message.id === undefined) return;
  const waiter = pending.get(message.id);
  if (!waiter) return;
  pending.delete(message.id);
  if (message.error) waiter.reject(new Error(message.error.message));
  else waiter.resolve(message.result);
});

function send(method, params = {}) {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expression) {
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'evaluation failed');
  }
  return result.result?.value;
}

async function waitFor(expression, label) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (await evaluate(expression)) return;
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${label}`);
}

function pass(label) {
  console.log(`PASS ${label}`);
}

async function screenshot(name) {
  const capture = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  await writeFile(join(root, 'test-output', name), Buffer.from(capture.data, 'base64'));
}

try {
  await send('Runtime.enable');
  await send('Page.enable');
  const previewUrl = 'file:///' + preview.replaceAll('\\', '/');
  await send('Page.navigate', { url: previewUrl + '?state=empty' });
  await waitFor("document.querySelector('#empty .empty-title')?.textContent === '还没有扫描结果'", 'empty page');
  assert.equal(await evaluate("[...document.querySelectorAll('button')].filter(button => !button.closest('[hidden]') && button.textContent === '开始扫描').length"), 1);
  pass('first scan has a single visible entry point');
  await send('Page.navigate', { url: previewUrl });
  await waitFor("document.querySelector('#totals .stat-value') !== null", 'initial screen');
  const initialRequests = await evaluate("window.__sgRequests || []");
  assert.ok(initialRequests.some((request) => request.method === 'GET' && request.path === 'scan'));
  assert.equal(initialRequests.filter((request) => request.method === 'POST').length, 0, 'opening must use the GET scan first page');

  const totals = await evaluate("Array.from(document.querySelectorAll('#totals .stat-value')).map(n=>n.textContent)");
  assert.ok(totals.some((value) => /TB|GB/.test(value)), `totals should show bytes: ${totals}`);
  assert.equal(await evaluate("document.querySelectorAll('#files-table tbody tr').length"), 50);
  assert.match(await evaluate("document.querySelector('#pager').textContent"), /13,970/u);
  pass('first page shows totals, 50 rows and the full pager count');

  assert.equal(await evaluate("document.querySelector('#totals .stat-label').textContent"), '磁盘占用');
  assert.deepEqual(
    await evaluate("Array.from(document.querySelectorAll('#files-table th.num')).map(th => th.textContent)"),
    ['磁盘占用', '文件大小'],
  );
  assert.match(await evaluate("document.querySelector('.capacity-note').textContent"), /稀疏或压缩/u);
  pass('disk usage is the primary metric and the first numeric file column');

  assert.match(await evaluate("document.querySelector('#result-count').textContent"), /重复路径/u);
  pass('duplicate path note is visible');

  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 440, deviceScaleFactor: 1, mobile: false });
  await waitFor("innerHeight === 440", "compact viewport");
  await evaluate("document.querySelectorAll('.file-row')[24].scrollIntoView({block:'center',behavior:'instant'})");
  const scrollPosition = "(document.querySelector('.page-scroll') || document.scrollingElement).scrollTop";
  const beforeDetails = await evaluate(scrollPosition);
  assert.ok(beforeDetails > 500, 'start deep in the file list');
  const rowPath = (index) => evaluate("document.querySelectorAll('.file-row')[" + index + "].getAttribute('aria-label')");
  const drawerPath = () => evaluate("document.querySelector('.drawer-path').textContent");
  for (const index of [24, 25]) {
    await evaluate("document.querySelectorAll('.file-row')[" + index + "].click()");
    await waitFor("document.querySelector('#drawer').hidden === false", 'file drawer');
    assert.equal(await drawerPath(), await rowPath(index));
    assert.equal(await evaluate(scrollPosition), beforeDetails, 'opening details preserves the list scroll');
  }
  assert.equal(await evaluate("document.scrollingElement.scrollTop"), 0, 'the list scrolls inside its pane');
  await evaluate("document.querySelector('#drawer').scrollTop = 100");
  assert.ok(await evaluate("document.querySelector('#drawer').scrollTop > 0"), 'details can scroll independently');
  assert.equal(await evaluate(scrollPosition), beforeDetails);
  await evaluate("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}))");
  await waitFor("document.querySelector('#drawer').hidden === true", 'drawer close');
  assert.equal(await evaluate(scrollPosition), beforeDetails, 'closing details preserves the list scroll');
  assert.equal(await evaluate("document.activeElement.getAttribute('aria-label')"), await rowPath(25));
  await send('Emulation.clearDeviceMetricsOverride');
  pass('opening, switching, scrolling and closing details preserve the list position');

  await evaluate(
    "Array.from(document.querySelectorAll('.category-row')).find(row=>row.textContent.includes('临时文件')).click()",
  );
  await waitFor("document.querySelector('#filter-category').value === 'temp'", 'category filter');
  await waitFor("/筛选后/.test(document.querySelector('#result-count').textContent)", 'filtered count');
  assert.match(await evaluate("document.querySelector('#result-count').textContent"), /1,600 个文件/u);
  pass('category filter narrows the table and count');

  await evaluate("document.querySelector('#clear-filters').click()");
  await waitFor("document.querySelector('#filter-category').value === ''", 'clear filters');
  assert.match(await evaluate("document.querySelector('#result-count').textContent"), /13,970 个文件/u);
  pass('clear filters restores the full table');

  await evaluate(
    "window.__staticVolumes = document.querySelector('#volumes .volume-card'); window.__staticCategories = document.querySelector('#categories .category-row')",
  );
  await evaluate("window.__sgDelay = 260");
  await evaluate(
    "document.querySelector('#filter-thread').value='thread_storage'; document.querySelector('#filter-thread').dispatchEvent(new Event('change'))",
  );
  await sleep(50);
  assert.equal(
    await evaluate("document.querySelector('#files-table').getAttribute('aria-busy')"),
    'true',
    'filter request should mark the table busy',
  );
  assert.equal(
    await evaluate("document.querySelectorAll('#files-table tbody tr').length"),
    50,
    'the last usable rows should remain while the filter request is in flight',
  );
  assert.match(await evaluate("document.querySelector('#result-count').textContent"), /正在更新/u);
  await waitFor("/筛选后/.test(document.querySelector('#result-count').textContent)", 'thread filter');
  await evaluate("window.__sgDelay = 0");
  assert.equal(await evaluate("document.querySelector('#files-table').getAttribute('aria-busy')"), 'false');
  assert.ok((await evaluate("document.querySelectorAll('#files-table tbody tr').length")) > 0);
  pass('filter keeps the last usable rows while loading');
  assert.equal(
    await evaluate("document.querySelector('#volumes .volume-card') === window.__staticVolumes"),
    true,
    'thread filter must not rebuild volume cards',
  );
  assert.equal(
    await evaluate("document.querySelector('#categories .category-row') === window.__staticCategories"),
    true,
    'thread filter must not rebuild the category table',
  );
  pass('thread filter narrows the table without rebuilding static summary');

  await evaluate("document.querySelector('#clear-filters').click()");
  await waitFor("document.querySelector('#filter-thread').value === ''", 'clear thread filter');
  pass('clear filters resets the thread filter');

  const pageRequests = (await evaluate("window.__sgRequests || []"))
    .filter((request) => request.method === 'POST' && request.body && request.body.query);
  assert.ok(pageRequests.length > 0);
  assert.ok(pageRequests.every((request) => request.body.query.summary === 'false'));

  await evaluate("document.querySelector('#file-search').value='worktrees'; document.querySelector('#file-search').dispatchEvent(new Event('input'))");
  await waitFor("/筛选后/.test(document.querySelector('#result-count').textContent)", 'search filter');
  assert.ok((await evaluate("document.querySelectorAll('#files-table tbody tr').length")) > 0);
  pass('search filters the table');

  await evaluate("document.querySelector('#clear-filters').click()");
  await waitFor("document.querySelector('#filter-category').value === ''", 'clear search');
  await evaluate("document.querySelector('#pager button:last-child').click()");
  await waitFor("/第 51–100 条/.test(document.querySelector('#pager').textContent)", 'second page');
  pass('pagination advances by offset');

  await evaluate("window.__sgNoWorktrees = true");
  await evaluate(
    "Array.from(document.querySelectorAll('.category-row')).find(row=>row.textContent.includes('工作树')).click()",
  );
  await waitFor("/工作树汇总不可用/.test(document.querySelector('#result-count').textContent)", 'worktree unavailable');
  assert.equal(await evaluate("document.querySelectorAll('.worktree-row').length"), 0);
  assert.match(await evaluate("document.querySelector('#files-table').textContent"), /没有返回完整的工作树汇总/u);
  await evaluate("window.__sgNoWorktrees = false");
  await evaluate(
    "Array.from(document.querySelectorAll('#view-switch button')).find(button => button.textContent.includes('按文件查看')).click()",
  );
  await waitFor("document.querySelector('#files-title').textContent === '文件'", 'worktree files fallback view');
  await evaluate(
    "Array.from(document.querySelectorAll('#view-switch button')).find(button => button.textContent.includes('按工作树汇总')).click()",
  );
  await waitFor("document.querySelector('#files-title').textContent === '工作树'", 'worktree summary');
  await waitFor("document.querySelectorAll('.worktree-row').length > 1", 'worktree rows');
  assert.match(await evaluate("document.querySelector('#result-count').textContent"), /个工作树/u);
  assert.match(await evaluate("document.querySelector('#result-count').textContent"), /文件数为各目录内路径数/u);
  assert.match(await evaluate("document.querySelector('.worktree-row .path-text').title"), /worktrees/u);
  assert.match(await evaluate("document.querySelector('#view-switch').textContent"), /按文件查看/u);
  await screenshot('worktree-summary.png');
  await evaluate("document.querySelector('.worktree-row').click()");
  await waitFor("/^工作树 · /.test(document.querySelector('#files-title').textContent)", 'worktree drill');
  await waitFor("document.querySelectorAll('#files-table tbody tr').length > 0", 'worktree files');
  assert.match(await evaluate("document.querySelector('#result-count').textContent"), /个文件/u);
  assert.match(await evaluate("document.querySelector('#result-count').textContent"), /当前工作树目录内/u);
  assert.ok(
    await evaluate("Array.from(document.querySelectorAll('.type-tag')).some(tag => tag.textContent === '磁盘映像')"),
    'a .img file must be labelled disk image, not image',
  );
  await screenshot('worktree-files.png');
  await evaluate(
    "Array.from(document.querySelectorAll('#view-switch button')).find(button => button.textContent.includes('返回工作树')).click()",
  );
  await waitFor("document.querySelector('#files-title').textContent === '工作树'", 'return to worktree summary');
  const requests = await evaluate("window.__sgRequests || []");
  assert.ok(requests.length > 0);
  assert.ok(requests.every((request) => !String(request.path).includes('?')), 'requests must not append a query to the GET path');
  assert.ok(
    requests.some((request) => request.method === 'POST' && request.body && request.body.query && request.body.query.view),
    'file/worktree pages must use POST query',
  );
  assert.equal(
    await evaluate("document.querySelector('.worktree-row .path-text').textContent === document.querySelector('.worktree-row .path-text').title"),
    true,
    'worktree path must be available in full',
  );
  pass('worktree summary drills into a directory and labels .img as disk image');

  await evaluate("document.querySelector('#clear-filters').click()");
  await waitFor("document.querySelector('#filter-category').value === ''", 'clear worktree view');
  await waitFor("document.querySelector('#files-title').textContent === '文件'", 'file view after worktrees');

  await evaluate("document.querySelector('#scan-btn').click()");
  await waitFor("document.querySelector('#progress .progress-card') !== null", 'scan progress');
  assert.ok(await evaluate("document.querySelector('#scan-btn').disabled"));
  assert.match(await evaluate("document.querySelector('#progress').textContent"), /已用/u);
  assert.match(await evaluate("document.querySelector('#progress').textContent"), /首次扫描|上次扫描|预计|\u4f30\u7b97/u);
  assert.ok(await evaluate("document.querySelector('.bar.is-indeterminate') !== null"));
  await screenshot('scan-progress.png');
  await waitFor("/扫描完成/.test(document.querySelector('#notice').textContent)", 'scan completion');
  assert.match(await evaluate("document.querySelector('#pager').textContent"), /13,970/u);
  pass('scan starts, shows progress and completes');

  await evaluate("document.querySelector('#scan-btn').click()");
  await waitFor("document.querySelector('#progress .progress-card') !== null", 'second scan progress');
  assert.match(await evaluate("document.querySelector('#progress').textContent"), /上次扫描|预计/u);
  await waitFor("/扫描完成/.test(document.querySelector('#notice').textContent)", 'second scan completion');
  pass('second scan uses the remembered duration for ETA');

  assert.deepEqual(errors, []);
  pass('no runtime exceptions');
} finally {
  socket.close();
  chrome.kill();
}
