import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const releaseWorkflow = readFileSync(
  new URL('../../../../.github/workflows/contract-ci.yml', import.meta.url),
  'utf8',
);

function extractLiteralRunBlocks(workflow: string): string[] {
  const lines = workflow.split('\n');
  const blocks: string[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const marker = lines[index]?.match(/^(\s*)run: \|$/);
    if (!marker) {
      continue;
    }

    const markerIndent = marker[1].length;
    const blockLines: string[] = [];
    index += 1;
    while (index < lines.length) {
      const line = lines[index] ?? '';
      const contentIndent = line.match(/^(\s*)/)?.[1].length ?? 0;
      if (line.length > 0 && contentIndent <= markerIndent) {
        index -= 1;
        break;
      }
      blockLines.push(line);
      index += 1;
    }

    const blockIndent = Math.min(
      ...blockLines.filter(Boolean).map((line) => line.match(/^(\s*)/)?.[1].length ?? 0),
    );
    blocks.push(
      blockLines
        .map((line) => (line.length > 0 ? line.slice(blockIndent) : line))
        .join('\n'),
    );
  }

  return blocks;
}

test('every literal workflow run block is valid bash', () => {
  const runBlocks = extractLiteralRunBlocks(releaseWorkflow);
  assert.equal(runBlocks.length, 3, 'all multiline Contract CI run blocks must be checked');

  for (const [index, runBlock] of runBlocks.entries()) {
    const result = spawnSync('bash', ['-n'], {
      encoding: 'utf8',
      input: runBlock,
    });
    assert.equal(
      result.status,
      0,
      `workflow run block ${index + 1} has invalid bash: ${result.stderr}`,
    );
  }
});
