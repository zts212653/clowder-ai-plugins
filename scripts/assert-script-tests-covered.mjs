import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';

const repoRoot = new URL('../', import.meta.url);
const workflow = await readFile(
  new URL('../.github/workflows/contract-ci.yml', import.meta.url),
  'utf8',
);
// CI delegates its check sequence to `pnpm gate:ci`, so the gate script is
// part of the reachable CI surface, not just the workflow YAML.
const gateSource = await readFile(new URL('./ci-gate.mjs', import.meta.url), 'utf8');
const packageJson = JSON.parse(
  await readFile(new URL('../package.json', import.meta.url), 'utf8'),
);
const scriptTests = (await readdir(new URL('./', import.meta.url)))
  .filter((name) => name.endsWith('.test.mjs'))
  .sort();

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

const reachableCommands = [workflow];
let grew = true;
while (grew) {
  grew = false;
  const reachableText = `${reachableCommands.join('\n')}\n${gateSource}`;
  for (const [name, command] of Object.entries(packageJson.scripts ?? {})) {
    const invocation = new RegExp(
      `\\bpnpm(?:\\s+run)?\\s+${escapeRegExp(name)}(?=[\\s'\"]|$)`,
      'mu',
    );
    if (invocation.test(reachableText) && !reachableCommands.includes(command)) {
      reachableCommands.push(command);
      grew = true;
    }
  }
}
const reachableText = `${reachableCommands.join('\n')}\n${gateSource}`;
const uncovered = scriptTests.filter(
  (name) => !reachableText.includes(`scripts/${name}`),
);

assert.deepEqual(
  uncovered,
  [],
  `scripts/*.test.mjs without a Contract CI entrypoint: ${uncovered.join(', ')}`,
);
process.stdout.write(`script test coverage: ${scriptTests.length}/${scriptTests.length}\n`);
