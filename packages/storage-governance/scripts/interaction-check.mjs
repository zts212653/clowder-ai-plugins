import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
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

try {
  await send('Runtime.enable');
  await waitFor("document.querySelector('#totals .stat-value') !== null", 'initial screen');

  const totals = await evaluate("Array.from(document.querySelectorAll('#totals .stat-value')).map(n=>n.textContent)");
  assert.ok(totals.some((value) => /TB|GB/.test(value)), `totals should show bytes: ${totals}`);
  assert.equal(await evaluate("document.querySelectorAll('#files-table tbody tr').length"), 50);
  assert.match(await evaluate("document.querySelector('#pager').textContent"), /13,970/u);
  pass('first page shows totals, 50 rows and the full pager count');

  assert.match(await evaluate("document.querySelector('#result-count').textContent"), /重复路径/u);
  pass('duplicate path note is visible');

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
    "document.querySelector('#filter-thread').value='thread_storage'; document.querySelector('#filter-thread').dispatchEvent(new Event('change'))",
  );
  await waitFor("/筛选后/.test(document.querySelector('#result-count').textContent)", 'thread filter');
  assert.ok((await evaluate("document.querySelectorAll('#files-table tbody tr').length")) > 0);
  pass('thread filter narrows the table by source');

  await evaluate("document.querySelector('#clear-filters').click()");
  await waitFor("document.querySelector('#filter-thread').value === ''", 'clear thread filter');
  pass('clear filters resets the thread filter');

  await evaluate("document.querySelector('#files-table tbody tr').click()");
  await waitFor("document.querySelector('#drawer').hidden === false", 'file drawer');
  assert.ok((await evaluate("document.querySelector('.drawer-path').textContent")).length > 20);
  await evaluate("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}))");
  await waitFor("document.querySelector('#drawer').hidden === true", 'drawer close');
  pass('file row opens details and Escape closes it');

  await evaluate("document.querySelector('#file-search').value='worktrees'; document.querySelector('#file-search').dispatchEvent(new Event('input'))");
  await waitFor("/筛选后/.test(document.querySelector('#result-count').textContent)", 'search filter');
  assert.ok((await evaluate("document.querySelectorAll('#files-table tbody tr').length")) > 0);
  pass('search filters the table');

  await evaluate("document.querySelector('#clear-filters').click()");
  await waitFor("document.querySelector('#filter-category').value === ''", 'clear search');
  await evaluate("document.querySelector('#pager button:last-child').click()");
  await waitFor("/第 51–100 条/.test(document.querySelector('#pager').textContent)", 'second page');
  pass('pagination advances by offset');

  await evaluate("document.querySelector('#scan-btn').click()");
  await waitFor("document.querySelector('#progress .progress-card') !== null", 'scan progress');
  assert.ok(await evaluate("document.querySelector('#scan-btn').disabled"));
  await waitFor("/扫描完成/.test(document.querySelector('#notice').textContent)", 'scan completion');
  assert.match(await evaluate("document.querySelector('#pager').textContent"), /13,970/u);
  pass('scan starts, shows progress and completes');

  assert.deepEqual(errors, []);
  pass('no runtime exceptions');
} finally {
  socket.close();
  chrome.kill();
}
