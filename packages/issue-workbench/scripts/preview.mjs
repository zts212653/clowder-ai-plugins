import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
const files = new Map([['/','index.html'],['/index.html','index.html'],['/browser.js','browser.js'],['/browser.css','browser.css'],['/demo.js','demo.js']]);
const types = { html:'text/html; charset=utf-8', js:'text/javascript; charset=utf-8', css:'text/css; charset=utf-8' };
export function preview(root = fileURLToPath(new URL('../dist/', import.meta.url))) {
  return createServer(async (req,res) => {
    const name = files.get((req.url ?? '/').split('?')[0]);
    if (req.method !== 'GET' || !name) { res.writeHead(404).end(); return; }
    try { const data = await readFile(join(root, name));
      res.writeHead(200, {'Content-Type':types[name.split('.').pop()], 'Cache-Control':'no-store'}).end(data);
    } catch { res.writeHead(404).end(); }
  });
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? 5196);
  preview().listen(port, '127.0.0.1', () => console.log('Synthetic preview: http://127.0.0.1:' + port));
}
