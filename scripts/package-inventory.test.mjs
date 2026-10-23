import assert from 'node:assert/strict';
import { access, readFile, readdir, stat } from 'node:fs/promises';
import test from 'node:test';
import { parse } from 'yaml';
import { validateManifest, validatePluginCatalog } from '../packages/plugin-contract/dist/index.js';
import { collectPublishPackageDirectories } from './registry-publish-compatibility.mjs';

const root = new URL('../', import.meta.url);
const catalog = JSON.parse(await readFile(new URL('catalog/candidate.json', root), 'utf8'));
const workflowSource = await readFile(new URL('.github/workflows/contract-ci.yml', root), 'utf8');
const publishers = new Set(collectPublishPackageDirectories(workflowSource));
const plugins = [];
for (const directory of await readdir(new URL('packages/', root))) {
  const packageRoot = new URL(`packages/${directory}/`, root);
  let manifestText;
  try { manifestText = await readFile(new URL('plugin.yaml', packageRoot), 'utf8'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; continue; }
  plugins.push({ directory, root: packageRoot, manifest: parse(manifestText),
    pkg: JSON.parse(await readFile(new URL('package.json', packageRoot), 'utf8')) });
}

function declaredEntrypoints(value) {
  if (value === null || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, child]) => key === 'entrypoint' && typeof child === 'string'
    ? [child] : declaredEntrypoints(child));
}

function packagePath(plugin, relativePath) {
  const target = new URL(relativePath, plugin.root);
  assert.ok(target.href.startsWith(plugin.root.href), `${plugin.directory}: resource escapes its package`);
  return target;
}

test('current manifests have unique identities, matching package versions and valid declarations', () => {
  assert.ok(plugins.length > 0);
  assert.equal(validatePluginCatalog(catalog).valid, true);
  assert.equal(new Set(plugins.map(p => p.manifest.pluginId)).size, plugins.length);
  for (const plugin of plugins) {
    const result = validateManifest(plugin.manifest);
    assert.equal(result.valid, true, `${plugin.directory}: ${JSON.stringify(result.errors)}`);
    assert.equal(plugin.pkg.version, plugin.manifest.version, plugin.directory);
  }
});

test('catalog entries identify current public packages and their actual manifests', () => {
  for (const entry of catalog.plugins) {
    const plugin = plugins.find(p => p.manifest.pluginId === entry.pluginId);
    assert.ok(plugin, `${entry.pluginId}: catalog has no package manifest`);
    assert.notEqual(plugin.pkg.private, true, `${entry.pluginId}: private package is cataloged`);
    const current = entry.versions[0];
    assert.equal(current.version, plugin.pkg.version);
    assert.equal(current.artifact.packageName, plugin.pkg.name);
    assert.equal(current.artifact.provenance.sourceDirectory, `packages/${plugin.directory}`);
    assert.ok(publishers.has(`packages/${plugin.directory}`), `${entry.pluginId}: no protected publisher`);
  }
  for (const plugin of plugins.filter(p => !catalog.plugins.some(c => c.pluginId === p.manifest.pluginId))) {
    assert.equal(publishers.has(`packages/${plugin.directory}`), false,
      `${plugin.directory}: a package outside the release catalog must not be published`);
  }
});

test('every declared runtime entrypoint and static resource exists in the built package', async () => {
  for (const plugin of plugins) {
    const entries = new Set(declaredEntrypoints(plugin.manifest));
    assert.ok(entries.size > 0, `${plugin.directory}: no declared runtime`);
    for (const entry of entries) assert.equal((await stat(packagePath(plugin, entry))).isFile(), true,
      `${plugin.directory}: missing declared entrypoint ${entry}`);
    if (plugin.manifest.icon?.src) await access(packagePath(plugin, plugin.manifest.icon.src));
    for (const contribution of plugin.manifest.contributions ?? []) {
      if (['skill', 'limb'].includes(contribution.type) && contribution.path)
        await access(packagePath(plugin, contribution.path));
    }
  }
});


test('current packages provide a Chinese default and a separately packaged English guide', async () => {
  for (const plugin of plugins) {
    const chinese = await readFile(new URL('README.md', plugin.root), 'utf8');
    const english = await readFile(new URL('README.en.md', plugin.root), 'utf8');
    assert.match(chinese.split('\n')[0], /\p{Script=Han}/u, plugin.directory);
    for (const [file, text, other] of [['README.md', chinese, 'README.en.md'], ['README.en.md', english, 'README.md']]) {
      assert.ok(!text.startsWith('---\n'), `${plugin.directory}/${file}: internal frontmatter`);
      assert.ok(text.includes(`](${other})`), `${plugin.directory}/${file}: missing parallel guide link`);
      const prose = text.replace(/```[\s\S]*?```|`[^`]*`/gu, '');
      if (file === 'README.en.md') assert.doesNotMatch(prose, /\p{Script=Han}/u, plugin.directory);
      else assert.doesNotMatch(prose, /^[A-Za-z][A-Za-z ,/()-]{30,}[.!]?$/mu, plugin.directory);
    }
    assert.ok(plugin.pkg.files?.includes('README.en.md') || plugin.pkg.files?.includes('README*.md'), plugin.directory);
  }
});

test('initial installation selects unique current plugin identities and explicit enabled intent', async () => {
  const selection = JSON.parse(await readFile(new URL('catalog/initial-plugins.json', root), 'utf8'));
  assert.deepEqual(Object.keys(selection).sort(), ['plugins', 'schemaVersion']);
  assert.equal(selection.schemaVersion, 1);
  assert.ok(selection.plugins.length > 0);
  assert.equal(new Set(selection.plugins.map(p => p.pluginId)).size, selection.plugins.length);
  for (const item of selection.plugins) {
    assert.deepEqual(Object.keys(item).sort(), ['enabled', 'pluginId']);
    assert.equal(item.enabled, true);
    assert.ok(plugins.some(p => p.manifest.pluginId === item.pluginId), `${item.pluginId}: no source manifest`);
  }
});

test('publication requires the validated main branch', () => {
  const workflow = parse(workflowSource);
  assert.equal(workflow.jobs.publish.needs, 'validate');
  assert.equal(workflow.jobs.publish.if, "github.event_name == 'push' && github.ref == 'refs/heads/main'");
});
