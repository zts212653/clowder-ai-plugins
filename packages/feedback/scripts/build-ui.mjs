import { build } from 'esbuild';
import { readFile, writeFile } from 'node:fs/promises';
const root = new URL('../', import.meta.url);
const { outputFiles } = await build({ entryPoints: [new URL('ui/main.js', root).pathname.replace(/^\/([A-Z]:)/i, '$1')], bundle: true, write: false, format: 'iife', target: 'es2022', minify: true });
const css = await readFile(new URL('ui/style.css', root), 'utf8');
const js = outputFiles[0].text.replaceAll('</script', '<\\/script');
await writeFile(new URL('dist/panel.html', root), `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>问题反馈</title><style>${css}</style><body><main id="app"></main><script>${js}</script></body></html>`);
