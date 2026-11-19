import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

// Run only against an already-built, committed native source tree. Signing the
// packaged copy is mandatory; a raw linker artifact must never reach the vault.
if (process.platform !== 'darwin' || process.arch !== 'arm64' || ![3, 4].includes(process.argv.length)) throw Error('usage on darwin-arm64: node package-release.mjs /absolute/built/clowder-wechat-link [/absolute/built/clowder-wechat-desktop]');
const repo = fileURLToPath(new URL('../../../../', import.meta.url));
const assets = new URL('../../assets/native/', import.meta.url);
const git = args => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
if (git(['status', '--porcelain', '--untracked-files=all', '--', 'packages/wechat-delegation/native/'])) throw Error('commit native sources before packaging');
const sourceCommit = git(['rev-parse', 'HEAD']);
if (!/^[a-f0-9]{40}$/.test(sourceCommit) || process.argv.slice(2).some(path => !path.startsWith('/'))) throw Error('invalid source or binary coordinate');
const root = await mkdtemp(join(tmpdir(), 'wechat-hardened-release-'));
try {
  for (const [input, manifestName, product, identifier] of [
    [process.argv[2], 'manifest.json', 'clowder-wechat-link', 'ai.clowder.wechat-link'],
    ...(process.argv[3] ? [[process.argv[3], 'desktop-manifest.json', 'clowder-wechat-desktop', 'ai.clowder.wechat-desktop']] : []),
  ]) {
  const binary = join(root, product);
  await writeFile(binary, await readFile(input), { mode: 0o700 });
  execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', '--options', 'runtime', '--identifier', identifier, '--timestamp=none', binary], { stdio: 'pipe' });
  const signature = spawnSync('/usr/bin/codesign', ['-dvv', binary], { encoding: 'utf8' });
  if (signature.status !== 0 || !/flags=0x[0-9a-f]+\([^\n]*runtime/.test(signature.stderr)) throw Error('hardened runtime signing failed');
  execFileSync('/usr/bin/codesign', ['--verify', '--strict', binary], { stdio: 'pipe' });
  const bytes = await readFile(binary), gzip = gzipSync(bytes, { level: 9 });
  const hash = value => createHash('sha256').update(value).digest('hex');
  const manifest = JSON.parse(await readFile(new URL(manifestName, assets), 'utf8'));
  if (manifest.product !== product) throw Error('artifact product mismatch');
  Object.assign(manifest, {
    sourceCommit,
    cargoLockSha256: hash(await readFile(new URL('../Cargo.lock', import.meta.url))),
    signingCommand: `codesign --force --sign - --options runtime --identifier ${identifier} --timestamp=none`,
  });
  if (product === 'clowder-wechat-link') Object.assign(manifest, {
    sourceManifestSha256: hash(await readFile(new URL('../UPSTREAM.json', import.meta.url))),
    protocolPatchSha256: hash(await readFile(new URL('../protocol.patch', import.meta.url))),
  });
  if (product === 'clowder-wechat-desktop') {
    manifest.sourceFiles = Object.fromEntries(await Promise.all(['Cargo.toml', 'build.rs', 'src/main.rs', 'src/desktop.rs', 'src/desktop.m']
      .map(async file => [file, hash(await readFile(new URL('../desktop/' + file, import.meta.url)))])));
    manifest.artifacts['darwin-arm64'] ??= { fileName: 'clowder-wechat-desktop-0.1.0-darwin-arm64', minimumMacOS: '26.5', testedMacOS: '26.5', teamIdentifier: null };
  }
  Object.assign(manifest.artifacts['darwin-arm64'], { size: bytes.length, sha256: hash(bytes), compressedSha256: hash(gzip), signing: 'ad-hoc-hardened-runtime' });
  await writeFile(new URL(manifest.artifacts['darwin-arm64'].fileName + '.gz', assets), gzip);
  await writeFile(new URL(manifestName, assets), JSON.stringify(manifest, null, 2) + '\n');
  process.stdout.write(JSON.stringify({ product, sourceCommit, size: bytes.length, sha256: hash(bytes), signing: 'ad-hoc-hardened-runtime' }) + '\n');
  }
} finally { await rm(root, { recursive: true, force: true }); }
