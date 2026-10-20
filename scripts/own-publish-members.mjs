import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';

// npm's bundled-link walk can crash on a pnpm checkout even with scripts
// disabled. Enumerate only own files in an isolated copy; the lock materializer
// supplies dependencies independently, and the caller copies the ORIGINAL
// manifest into the final package. npm still applies files/ignore/bin rules.
export async function ownPublishMembers(source, { runNpm }) {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'clowder-own-publish-'));
  const isolated = join(temporaryRoot, 'package');
  try {
    await cp(source, isolated, { recursive: true, dereference: false,
      filter: path => !relative(source, path).split(sep).some(part =>
        part === 'node_modules' || part === '.git'),
    });
    const manifest = JSON.parse(await readFile(join(isolated, 'package.json'), 'utf8'));
    delete manifest.bundledDependencies;
    delete manifest.bundleDependencies;
    await writeFile(join(isolated, 'package.json'), JSON.stringify(manifest));
    const [artifact] = JSON.parse(runNpm(
      ['pack', '--json', '--ignore-scripts', '--dry-run', isolated], isolated,
    ));
    return artifact.files.map(file => file.path).filter(path => !path.startsWith('node_modules/'));
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}
