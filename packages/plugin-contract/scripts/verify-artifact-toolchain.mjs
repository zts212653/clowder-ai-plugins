import { execFileSync } from 'node:child_process';

const expected = {
  node: process.env.ARTIFACT_NODE_VERSION,
  npm: process.env.ARTIFACT_NPM_VERSION,
  zlib: process.env.ARTIFACT_ZLIB_VERSION,
};

for (const [name, version] of Object.entries(expected)) {
  if (typeof version !== 'string' || version.length === 0) {
    throw new Error(`missing expected ${name} version`);
  }
}

const actual = {
  node: process.version.replace(/^v/, ''),
  npm: execFileSync('npm', ['--version'], { encoding: 'utf8' }).trim(),
  zlib: process.versions.zlib,
};

for (const name of Object.keys(expected)) {
  if (actual[name] !== expected[name]) {
    throw new Error(
      `artifact ${name} version mismatch: ${actual[name]} != ${expected[name]}`,
    );
  }
}

process.stdout.write(`${JSON.stringify(actual)}\n`);
