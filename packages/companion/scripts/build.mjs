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
const sri = bytes => `sha256-${createHash('sha256').update(bytes).digest('base64')}`;
// JSON is valid YAML. The tracked declaration is also readable before a build.
const manifest = JSON.parse(await readFile(new URL('plugin.yaml', root), 'utf8'));
manifest.version = pkg.version;
const window = manifest.contributions.find(contribution => contribution.type === 'desktop-window' && contribution.id === 'companion');
window.surface.integrity = sri(await readFile(new URL(window.surface.entrypoint, root)));
// livingBody: the body page beside the surface; the Host verifies its entry bytes the same way.
if (window.body) window.body.integrity = sri(await readFile(new URL(window.body.entrypoint, root)));
const validation = validateManifest(manifest);
if (!validation.valid) throw new Error(JSON.stringify(validation.errors));
// Refresh derived coordinates and emit the same declaration for module consumers.
const serialized = `${JSON.stringify(manifest, null, 2)}\n`;
await writeFile(new URL('manifest.json', root), serialized);
await writeFile(new URL('plugin.yaml', root), serialized);
