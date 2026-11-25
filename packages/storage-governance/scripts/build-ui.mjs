import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const parts = ['bridge.js', 'format.js', 'model.js', 'render.js', 'app.js'];
const [shell, css] = await Promise.all([
  readFile(join(root, 'ui', 'shell.html'), 'utf8'),
  readFile(join(root, 'ui', 'style.css'), 'utf8'),
]);
const scripts = [];
for (const name of parts) {
  const source = await readFile(join(root, 'ui', name), 'utf8');
  scripts.push(`<script>\n${source.replaceAll('</script', '<\\/script')}\n</script>`);
}
const html = shell.replace('{{STYLE}}', css).replace('{{SCRIPTS}}', scripts.join('\n'));
await mkdir(join(root, 'dist'), { recursive: true });
await writeFile(join(root, 'dist', 'page.html'), html);
console.log(`page.html: ${Buffer.byteLength(html)} bytes`);
