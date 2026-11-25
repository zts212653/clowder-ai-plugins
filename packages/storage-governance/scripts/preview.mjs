import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeFixture } from './preview-fixture.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const html = await readFile(join(root, 'dist', 'page.html'), 'utf8');
const fixture = makeFixture('ready');
const data = { report: fixture.report, rows: fixture.rows };

const mock = `<script>
(function () {
  var data = ${JSON.stringify(data)};
  var params = new URLSearchParams(location.search);
  var mode = params.get('state') || 'ready';
  function selected(body) {
    return data.rows.filter(function (row) {
      if (body.volume && row.volume.toUpperCase() !== String(body.volume).toUpperCase()) return false;
      if (body.category && row.category !== body.category) return false;
      if (body.threadId && (row.threadIds || []).indexOf(body.threadId) < 0) return false;
      if (body.query) {
        var haystack = row.path.toLowerCase() + ' ' + (row.threadIds || []).join(' ').toLowerCase();
        if (haystack.indexOf(String(body.query).toLowerCase()) < 0) return false;
      }
      return true;
    });
  }
  function readyBody(query) {
    var offset = Number(query.offset || '0');
    var limit = Number(query.limit || '100');
    var body = {
      volume: query.volume || '',
      category: query.category || '',
      threadId: query.threadId || '',
      query: query.query || '',
    };
    var rows = selected(body);
    return Object.assign({}, data.report, {
      files: rows.slice(offset, offset + limit),
      total: rows.length,
      nextOffset: offset + limit < rows.length ? offset + limit : null,
    });
  }
  function queryFromUrl(url) {
    return {
      offset: url.searchParams.get('offset') || '0',
      limit: url.searchParams.get('limit') || '100',
      volume: url.searchParams.get('volume') || '',
      category: url.searchParams.get('category') || '',
      threadId: url.searchParams.get('threadId') || '',
      query: url.searchParams.get('query') || '',
    };
  }
  window.addEventListener('message', function (event) {
    if (event.source !== window) return;
    var message = event.data;
    if (!message || message.channel !== 'clowder-plugin-ui/v1' || !message.request) return;
    // A top-level preview receives its own outbound message; keep the page's bridge listener from resolving it.
    event.stopImmediatePropagation();
    var method = String(message.request.method || 'GET').toUpperCase();
    var path = String(message.request.path || 'scan');
    var url = new URL(path, 'http://preview.local/');
    var body = message.request.body && message.request.body.query;
    var reply;
    if (mode === 'empty') reply = { state: 'idle' };
    else if (mode === 'unavailable') reply = { state: 'error', error: 'host-capability-unavailable' };
    else if (mode === 'error') reply = { state: 'error', error: 'scan-failed' };
    else if (mode === 'scanning') reply = { state: 'running' };
    else if (method === 'POST' && body) reply = readyBody(body);
    else if (method === 'POST') reply = { state: 'running' };
    else reply = readyBody(queryFromUrl(url));
    parent.postMessage(
      {
        channel: 'clowder-plugin-ui/v1',
        nonce: window.name,
        requestId: message.requestId,
        result: { status: 200, body: reply },
      },
      '*',
    );
  });
})();
</script>`;

const index = html.indexOf('<script>');
if (index < 0) throw new Error('page.html has no inline scripts');
const preview = html.slice(0, index) + mock + html.slice(index) + `<script>
if (new URLSearchParams(location.search).get('open') === '1') {
  setTimeout(function () {
    document.querySelectorAll('details').forEach(function (node) { node.open = true; });
  }, 800);
}
</script>`;
await mkdir(join(root, 'test-output'), { recursive: true });
const target = join(root, 'test-output', 'preview.html');
await writeFile(target, preview);
console.log(target);
