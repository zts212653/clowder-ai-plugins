import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { collectOfficialExport } from '../plugins/tripo-studio/runtime/official-export.mjs';
function glb() {
  const json = Buffer.from(
    JSON.stringify({
      asset: { version: '2.0' },
      meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
      accessors: [{ count: 6, min: [0, 0, 0], max: [1, 2, 3] }],
      skins: [{}],
      animations: [{ name: 'idle' }, { name: 'walk' }],
    }).padEnd(256, ' '),
  );
  const bytes = Buffer.alloc(20 + json.length);
  bytes.write('glTF');
  bytes.writeUInt32LE(2, 4);
  bytes.writeUInt32LE(bytes.length, 8);
  bytes.writeUInt32LE(json.length, 12);
  bytes.writeUInt32LE(0x4e4f534a, 16);
  json.copy(bytes, 20);
  return bytes;
}
test('only completed supplier bytes are collected; counts come from mesh bytes and existing files are preserved', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'tripo-official-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'supplier.glb'),
    bytes = glb();
  await writeFile(source, bytes);
  const receipt = {
    state: 'complete',
    filename: source,
    format: 'glb',
    bytes: bytes.length,
    modelId: '11111111-1111-4111-8111-111111111111',
  };
  await assert.rejects(
    collectOfficialExport(
      { ...receipt, state: 'in_progress' },
      root,
      'cat.glb',
    ),
    /NOT_COMPLETE/,
  );
  const result = await collectOfficialExport(receipt, root, 'cat.glb');
  assert.equal(result.mesh.triangles, 2);
  assert.deepEqual(result.mesh.animations, ['idle', 'walk']);
  assert.deepEqual(await readFile(result.filename), bytes);
  await assert.rejects(
    collectOfficialExport(receipt, root, 'cat.glb'),
    /EEXIST/,
  );
  assert.deepEqual(await readFile(result.filename), bytes);
});
