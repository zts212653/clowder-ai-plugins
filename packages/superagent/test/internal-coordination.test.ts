import assert from 'node:assert/strict';
import test from 'node:test';
import { startSuperagent } from '../src/runtime.js';
import { fixture } from './fixture.js';

test('reuses retained coordination on upgrade and restart without a private thread extension', async () => {
  const f = fixture();
  await f.seed();
  const main = await f.host.threads.create({ title: f.preferences.name });
  const coord = await f.host.threads.create({ title: 'renamed old coordination', parentThreadId: main.id });
  await f.host.storage.set('runtime', { mainThreadId: main.id, coordinationThreadId: coord.id });
  const updates: string[] = [];
  const update = f.host.threads.update;
  f.host.threads.update = async (id, patch) => { updates.push(id); return update(id, patch); };
  const first = await startSuperagent(f.host);
  const marked = await f.host.threads.get(coord.id);
  assert.equal(marked?.title, f.preferences.name + ' · 内部协调');
  assert.ok(!('internal' in marked!));
  assert.ok(!('internal' in (await f.host.threads.get(main.id))!));
  assert.equal(f.threads.size, 5, 'reuse the two existing threads');
  await first.stop({ reason: 'restart' });
  const before = updates.length;
  const second = await startSuperagent(f.host);
  assert.equal(f.threads.size, 5);
  assert.equal(updates.length, before, 'already configured coordination needs no migration write');
  assert.equal(f.tasks.size, 0);
  await second.stop({ reason: 'test' });
});
