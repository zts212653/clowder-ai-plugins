import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, cp, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { validateManifest } from '@clowder-ai/plugin-contract';

const root = new URL('../', import.meta.url);
const renderer = new URL('renderer/', root);
await rm(renderer, { recursive: true, force: true });
await mkdir(renderer, { recursive: true });
await cp(new URL('src/', root), renderer, { recursive: true });
await cp(new URL('assets/skins/', root), new URL('skins/', renderer), { recursive: true });
const client = await readFile(fileURLToPath(import.meta.resolve('@clowder-ai/plugin-sdk/companion')), 'utf8');
if (/\b(?:import|require)\s*\(/u.test(client) || /\bfrom\s*['"]/u.test(client)) throw new Error('Companion browser client gained runtime imports; audit its dependency closure');
await writeFile(new URL('client.mjs', renderer), client.replace(/\/\/# sourceMappingURL=.*$/mu, ''));
const pkg = JSON.parse(await readFile(new URL('package.json', root)));
const html = await readFile(new URL('index.html', renderer));
const manifest = {
  pluginId: 'official.companion', version: pkg.version, contractVersion: '0.1.0', name: '猫猫球',
  icon: { type: 'png', src: 'renderer/skins/ragdoll-v1.png' },
  description: { default: 'Talk, think and find your shared history with your companion.', translations: { 'zh-CN': '和猫猫说话、查资料，回到同一段聊天继续工作。' } },
  runtime: { transport: 'builtin' },
  features: [{ id: 'companion', name: '猫猫球', resources: [], capabilities: ['windows.create'], contributions: [{ type: 'desktop-window', id: 'companion' }] }],
  contributions: [{ type: 'desktop-window', id: 'companion', role: 'companion', bridgeVersion: '1.1.0',
    surface: { entrypoint: 'renderer/index.html', integrity: `sha256-${createHash('sha256').update(html).digest('base64')}` },
    presentation: { width: 300, height: 270, frame: false, transparent: true, alwaysOnTop: true, skipTaskbar: true } }],
};
const validation = validateManifest(manifest);
if (!validation.valid) throw new Error(JSON.stringify(validation.errors));
// JSON is valid YAML; both public entry points derive from this one manifest.
const serialized = `${JSON.stringify(manifest, null, 2)}\n`;
await writeFile(new URL('manifest.json', root), serialized);
await writeFile(new URL('plugin.yaml', root), serialized);
