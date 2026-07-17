import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const releaseWorkflow = readFileSync(
  new URL('../../../../.github/workflows/contract-ci.yml', import.meta.url),
  'utf8',
);

function multilineRunBlocks(workflow: string): string[] {
  const lines = workflow.split('\n');
  const blocks: string[] = [];

  for (let index = 0; index < lines.length; index++) {
    const marker = lines[index]?.match(/^(\s*)run: \|\s*$/);
    if (!marker) continue;

    const markerIndent = marker[1]!.length;
    const contentIndent = markerIndent + 2;
    const block: string[] = [];
    for (index += 1; index < lines.length; index++) {
      const line = lines[index]!;
      const indentation = line.match(/^\s*/)?.[0].length ?? 0;
      if (line.trim().length > 0 && indentation <= markerIndent) {
        index -= 1;
        break;
      }
      block.push(line.length >= contentIndent ? line.slice(contentIndent) : '');
    }
    blocks.push(block.join('\n'));
  }

  return blocks;
}

test('every multiline workflow shell block parses with bash', () => {
  const blocks = multilineRunBlocks(releaseWorkflow);
  assert.equal(blocks.length, 3, 'update the syntax gate when adding a run block');

  for (const [index, block] of blocks.entries()) {
    const result = spawnSync('bash', ['-n'], {
      input: block,
      encoding: 'utf8',
    });
    assert.equal(
      result.status,
      0,
      `run block ${index + 1} is not valid bash:\n${result.stderr}`,
    );
  }
});
