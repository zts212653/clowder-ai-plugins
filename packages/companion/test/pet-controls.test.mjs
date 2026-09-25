import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bindPetControls } from '../src/pet-controls.mjs';

function fixture() {
  const nodes = new Map();
  const calls = [], moves = [];
  const node = id => ({
    id, hidden: false, style: {}, offsetWidth: id === 'bubble' ? 240 : 120,
    offsetHeight: id === 'bubble' ? 80 : 130,
    dataset: {}, handlers: {}, setAttribute() {}, setPointerCapture() {},
    addEventListener(name, callback) { this.handlers[name] = callback; }, focus() {},
    querySelector: () => ({ focus() {} }),
  });
  for (const id of ['pet', 'anchor', 'actions', 'menu', 'chat', 'bubble', 'decisions', 'decision-reload', 'message']) nodes.set(id, node(id));
  const previous = { document: globalThis.document, window: globalThis.window, ResizeObserver: globalThis.ResizeObserver };
  globalThis.document = { getElementById: id => nodes.get(id), addEventListener() {}, querySelectorAll: () => [] };
  globalThis.window = { addEventListener() {} };
  globalThis.ResizeObserver = class { observe() {} disconnect() {} };
  const client = { drag: async () => ({ kind: 'ok' }), layout: async (panel, width, height) => {
    calls.push({ panel, width, height });
    return { pet: { x: 0, y: 0 }, panel: { x: 120, y: 0, height }, width: 360 };
  } };
  const controls = bindPetControls(client, { action() {}, error: cause => { throw cause; }, changed() {}, moved: (...args) => moves.push(args) });
  return { controls, calls, moves, nodes, restore() {
    for (const [key, value] of Object.entries(previous)) globalThis[key] = value;
  } };
}

test('recent speech keeps a small passive panel after menus dismiss, then releases it when voice ends', async () => {
  const f = fixture();
  try {
    await f.controls.setAmbient(true);
    assert.equal(f.controls.panel, 'bubble');
    assert.deepEqual(f.calls.at(-1), { panel: 'bubble', width: 240, height: 80 });
    await f.controls.show('chat');
    assert.equal(f.nodes.get('bubble').hidden, true);
    await f.controls.show('none');
    assert.equal(f.controls.panel, 'bubble');
    await f.controls.setAmbient(false);
    assert.equal(f.controls.panel, 'none');
  } finally { f.restore(); }
});

test('accepted drag direction reaches the pet motion and stops on release', async () => {
  const f = fixture();
  try {
    const pet = f.nodes.get('pet');
    pet.onpointerdown({ button: 0, pointerId: 1, screenX: 20, screenY: 20 });
    await Promise.resolve();
    pet.onpointermove({ screenX: 8, screenY: 20 });
    assert.deepEqual(f.moves[0], [-12, 0]);
    pet.handlers.pointerup();
    assert.deepEqual(f.moves.at(-1), ['stop']);
  } finally { f.restore(); }
});
