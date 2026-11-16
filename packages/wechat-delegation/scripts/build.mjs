import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
const root = new URL('../', import.meta.url);
await rm(new URL('dist/', root), { recursive: true, force: true });
await mkdir(new URL('dist/', root));
await cp(new URL('src/', root), new URL('dist/', root), { recursive: true });
const css = await readFile(new URL('ui/style.css', root), 'utf8');
const js = (await Promise.all(['target-picker.js', 'keychain-repair.js', 'connection.js', 'panel.js'].map(file => readFile(new URL(`ui/${file}`, root), 'utf8')))).join('\n').replaceAll('</script', '<\\/script');
await writeFile(new URL('dist/panel.html', root), `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>微信代聊</title><style>${css}</style><body><main id="app"></main><script>${js}</script></body></html>`);
await cp(new URL('../../LICENSE', root), new URL('LICENSE', root));
