import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { lstat, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const lock = JSON.parse(await readFile(join(packageRoot, 'source-lock.json'), 'utf8'));
const sourceRoot = join(packageRoot, '.tmp', 'source', lock.rootDirectory);
const rendererRoot = join(packageRoot, 'renderer');
const upstreamGenerator = join(sourceRoot, 'tools', 'gen-third-party-notices.mjs');
const generatedUpstreamNotice = join(sourceRoot, 'apps', 'shell', 'build', 'THIRD-PARTY-NOTICES.txt');
const rendererGenerator = join(sourceRoot, 'tools', `.cat-cafe-renderer-notices-${randomUUID()}.mjs`);
const FONT_NOTICE_LABELS = [
  ['Liberation', 'Liberation Sans / Serif / Mono'],
  ['Carlito', 'Carlito'],
  ['Caladea', 'Caladea'],
  ['NotoSansCJK', 'Noto Sans CJK SC'],
  ['NotoSerifCJK', 'Noto Serif CJK SC'],
  ['GenOfficeSansKR', 'GenOffice Sans KR'],
  ['GenOfficeSerifKR', 'GenOffice Serif KR'],
  ['GenOfficeCheLatinKR', 'GenOffice Che Latin KR'],
  ['NotoNaskhArabic', 'Noto Naskh Arabic'],
  ['NotoSansArabic', 'Noto Sans Arabic'],
  ['GenOfficeGothicKR', 'GenOffice Gothic KR'],
  ['GenOfficePoppins', 'GenOffice Poppins'],
  ['GenOfficeTamil', 'GenOffice Tamil'],
];

const frozenGenerator = await readFile(upstreamGenerator, 'utf8');
const rendererSourceGlobs = await discoverRendererSourceGlobs(sourceRoot);
const scopedGenerator = frozenGenerator
  .replace(
    /const SRC_GLOBS = \[[\s\S]*?\n\]\nconst CODE_EXT/,
    `const SRC_GLOBS = ${JSON.stringify(rendererSourceGlobs, null, 2)}\nconst CODE_EXT`,
  )
  .replace("const IMPLICIT = ['electron']", 'const IMPLICIT = []')
  .replace('new Set([...IMPLICIT, ...extraResourceSeeds()])', 'new Set([...IMPLICIT])')
  .replace('const crates = rustCrates()', 'const crates = []');
if (
  scopedGenerator === frozenGenerator ||
  scopedGenerator.includes('...extraResourceSeeds()') ||
  scopedGenerator.includes("'apps/markdown/src'") ||
  !scopedGenerator.includes(JSON.stringify(rendererSourceGlobs[0]))
) {
  throw new Error('frozen upstream notice generator no longer accepts the renderer-only scope transform');
}
await writeFile(rendererGenerator, scopedGenerator);
try {
  const result = spawnSync(process.execPath, [rendererGenerator], {
    cwd: sourceRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, CARGO_NET_OFFLINE: 'true' },
  });
  if (result.status !== 0) {
    throw new Error(`upstream notice generator failed: ${result.stderr || result.stdout}`);
  }
} finally {
  await unlink(rendererGenerator).catch(() => undefined);
}

const upstreamNotice = (await readFile(generatedUpstreamNotice, 'utf8')).replace(
  /Chromium \(bundled via Electron\)[\s\S]*?next to this file\.\n/,
  'Electron and Chromium are not included in this renderer-only artifact.\n',
);
const bundledPackageNames = await bundledPackagesFromSourceMaps(rendererRoot);
const upstreamPackages = parseNoticePackages(upstreamNotice);
const packageByName = new Map(upstreamPackages.map((item) => [item.name, item]));
const missingPackages = [...bundledPackageNames].filter((name) => !packageByName.has(name));
if (missingPackages.length > 0) {
  throw new Error(`renderer dependencies missing notices: ${missingPackages.join(', ')}`);
}
const packages = [...bundledPackageNames]
  .sort((left, right) => left.localeCompare(right))
  .map((name) => packageByName.get(name))
  .filter(Boolean);
const fontSection = upstreamNotice.match(/^={72}\n3\. Bundled fonts[\s\S]*?(?=^={72}\n4\. )/m)?.[0];
if (!fontSection) throw new Error('upstream notice generator did not emit bundled font notices');
for (const label of await bundledFontNoticeLabels(rendererRoot)) {
  if (!fontSection.includes(label)) throw new Error(`renderer font is missing its notice: ${label}`);
}
const noticePreamble = `GenOffice DOCX renderer — Third-Party Software Notices

Generated from the exact GenOffice ${lock.tag} source with its frozen
tools/gen-third-party-notices.mjs algorithm, scoped to renderer sources and
without Electron/native application seeds. The npm package inventory is derived
from the built renderer source maps; bundled font files are checked against the
upstream-generated font notice section. This package ships only the renderer
files enumerated in SBOM.spdx.json; Electron, Chromium, other Office
applications, native sidecars, and enterprise code are excluded.

`;
const scopedNotice = `${noticePreamble}${noticeSection(packages)}${fontSection}`;
await writeFile(join(rendererRoot, 'THIRD-PARTY-NOTICES.txt'), scopedNotice);
await removeSourceMaps(rendererRoot);

const files = await walkFiles(rendererRoot);
const fileInventory = await Promise.all(
  files.map(async (path, index) => {
    const bytes = await readFile(join(rendererRoot, path));
    return {
      fileName: `./${path}`,
      SPDXID: `SPDXRef-File-${index + 1}`,
      checksums: [
        { algorithm: 'SHA1', checksumValue: digest('sha1', bytes) },
        { algorithm: 'SHA256', checksumValue: digest('sha256', bytes) },
      ],
      licenseConcluded: 'NOASSERTION',
      copyrightText: 'NOASSERTION',
    };
  }),
);
const packageVerificationCodeValue = digest(
  'sha1',
  Buffer.from(
    fileInventory
      .map((file) => file.checksums.find((checksum) => checksum.algorithm === 'SHA1').checksumValue)
      .sort()
      .join(''),
  ),
);
const sbom = {
  spdxVersion: 'SPDX-2.3',
  dataLicense: 'CC0-1.0',
  SPDXID: 'SPDXRef-DOCUMENT',
  name: `genoffice-docx-renderer-${lock.tag}`,
  documentNamespace: `https://clowder.ai/spdx/genoffice-docx/${lock.commit}`,
  creationInfo: {
    creators: ['Tool: genoffice-docx/generate-renderer-compliance.mjs'],
    created: '2026-09-04T00:00:00Z',
  },
  packages: [
    {
      name: 'GenOffice DOCX renderer',
      SPDXID: 'SPDXRef-Package-GenOffice-DOCX',
      versionInfo: lock.tag,
      downloadLocation: lock.archiveUrl,
      filesAnalyzed: true,
      licenseConcluded: 'NOASSERTION',
      licenseDeclared: 'Apache-2.0',
      checksums: [{ algorithm: 'SHA256', checksumValue: lock.archiveSha256 }],
      packageVerificationCode: { packageVerificationCodeValue },
    },
    ...packages.map((item, index) => ({
      name: item.name,
      SPDXID: `SPDXRef-Dependency-${index + 1}`,
      versionInfo: item.version,
      downloadLocation: 'NOASSERTION',
      filesAnalyzed: false,
      licenseConcluded: 'NOASSERTION',
      licenseDeclared: item.license,
    })),
  ],
  files: fileInventory,
  relationships: [
    ...files.map((_path, index) => ({
      spdxElementId: 'SPDXRef-Package-GenOffice-DOCX',
      relationshipType: 'CONTAINS',
      relatedSpdxElement: `SPDXRef-File-${index + 1}`,
    })),
    ...packages.map((_item, index) => ({
      spdxElementId: 'SPDXRef-Package-GenOffice-DOCX',
      relationshipType: 'DEPENDS_ON',
      relatedSpdxElement: `SPDXRef-Dependency-${index + 1}`,
    })),
  ],
};
await writeFile(join(rendererRoot, 'SBOM.spdx.json'), `${JSON.stringify(sbom, null, 2)}\n`);
process.stdout.write(
  `${JSON.stringify({ notices: packages.length, rendererFiles: files.length, sourceGlobs: rendererSourceGlobs, source: relative(packageRoot, upstreamGenerator) })}\n`,
);

async function walkFiles(root, directory = root) {
  const paths = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === 'SBOM.spdx.json') continue;
    const absolute = join(directory, entry.name);
    const metadata = await lstat(absolute);
    if (metadata.isSymbolicLink()) throw new Error(`renderer compliance input symlink is forbidden: ${absolute}`);
    if (metadata.isDirectory()) paths.push(...(await walkFiles(root, absolute)));
    else if (metadata.isFile()) paths.push(relative(root, absolute).replaceAll('\\', '/'));
  }
  return paths.sort();
}

function parseNoticePackages(notice) {
  const entries = [];
  const pattern = /^-{72}\n(.+?) v([^\s]+) — (.+)\n-{72}\n([\s\S]*?)(?=^-{72}\n|^={72}\n|(?![\s\S]))/gm;
  for (const match of notice.matchAll(pattern)) {
    entries.push({
      name: match[1],
      version: match[2],
      license: normalizeSpdx(match[3]),
      body: match[4].trimEnd(),
    });
  }
  return entries;
}

function noticeSection(packages) {
  const separator = '='.repeat(72);
  const divider = '-'.repeat(72);
  const blocks = packages
    .map(
      (item) =>
        `${divider}\n${item.name} v${item.version} — ${item.license}\n${divider}\n${item.body}\n`,
    )
    .join('\n');
  return `${separator}\n1. Bundled npm packages (${packages.length})\n${separator}\n\n${blocks}\n`;
}

async function bundledPackagesFromSourceMaps(root) {
  const names = new Set();
  const maps = (await allFiles(root)).filter((path) => path.endsWith('.map'));
  if (maps.length === 0) throw new Error('renderer build emitted no source maps for dependency census');
  for (const mapPath of maps) {
    const sourceMap = JSON.parse(await readFile(mapPath, 'utf8'));
    if (!Array.isArray(sourceMap.sources)) throw new Error(`invalid renderer source map: ${mapPath}`);
    for (const source of sourceMap.sources) {
      if (typeof source !== 'string') continue;
      const matches = [...source.matchAll(/node_modules\/((?:@[^/]+\/)?[^/]+)/g)];
      const name = matches.at(-1)?.[1];
      if (name) names.add(name);
    }
  }
  return names;
}

async function bundledFontNoticeLabels(root) {
  const labels = new Set();
  for (const path of await allFiles(root)) {
    if (!/\.(?:ttf|woff2?)$/i.test(path)) continue;
    const name = basename(path);
    const label = FONT_NOTICE_LABELS.find(([prefix]) => name.startsWith(prefix))?.[1];
    if (!label) throw new Error(`renderer font has no frozen notice mapping: ${name}`);
    labels.add(label);
  }
  return labels;
}

async function removeSourceMaps(root) {
  for (const path of await allFiles(root)) {
    if (path.endsWith('.map')) await unlink(path);
  }
}

async function allFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await allFiles(absolute)));
    else if (entry.isFile()) files.push(absolute);
  }
  return files;
}

async function discoverRendererSourceGlobs(root) {
  const packageRoot = join(root, 'packages');
  const workspaceByName = new Map();
  for (const entry of await readdir(packageRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    try {
      const manifest = JSON.parse(await readFile(join(packageRoot, entry.name, 'package.json'), 'utf8'));
      if (typeof manifest.name === 'string') {
        workspaceByName.set(manifest.name, `packages/${entry.name}/src`);
      }
    } catch {
      // A package without a readable manifest cannot join the renderer graph.
    }
  }
  const seen = new Set(['apps/docs/src']);
  const queue = ['apps/docs/src'];
  const specifier = /\b(?:from\s*|import\s*\(\s*|import\s+|require\s*\(\s*)['"]([^'"\n]+)['"]/g;
  while (queue.length > 0) {
    const sourceGlob = queue.shift();
    if (!sourceGlob) break;
    for (const file of await sourceFiles(join(root, sourceGlob))) {
      const source = await readFile(file, 'utf8');
      for (const match of source.matchAll(specifier)) {
        const parts = match[1].split('/');
        const packageName = match[1].startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
        const next = workspaceByName.get(packageName);
        if (next && !seen.has(next)) {
          seen.add(next);
          queue.push(next);
        }
      }
    }
  }
  return [...seen].sort();
}

async function sourceFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'out') continue;
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await sourceFiles(absolute)));
    else if (entry.isFile() && /\.(?:[cm]?[jt]sx?)$/.test(entry.name)) files.push(absolute);
  }
  return files;
}

function normalizeSpdx(value) {
  const candidate = value.split(' (', 1)[0].trim();
  return /^[A-Za-z0-9.+-]+(?: (?:AND|OR) [A-Za-z0-9.+-]+)*$/.test(candidate) ? candidate : 'NOASSERTION';
}

function digest(algorithm, bytes) {
  return createHash(algorithm).update(bytes).digest('hex');
}
