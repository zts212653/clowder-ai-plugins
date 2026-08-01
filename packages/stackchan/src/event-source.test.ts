import assert from 'node:assert/strict';
import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  createFileStackChanCursorStore,
  createStackChanJsonlEventSource,
  type StackChanEventCursor,
  type StackChanEventCursorStore,
} from './event-source.js';

class MemoryCursorStore implements StackChanEventCursorStore {
  cursor: StackChanEventCursor | undefined;

  async load(): Promise<StackChanEventCursor | undefined> {
    return this.cursor;
  }

  async save(cursor: StackChanEventCursor): Promise<void> {
    this.cursor = structuredClone(cursor);
  }
}

test('persists only validated cursor state in a private atomic file', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'stackchan-cursor-'));
  const path = join(directory, 'state', 'cursor.json');
  const store = createFileStackChanCursorStore(path);
  const cursor: StackChanEventCursor = {
    fileId: '1:2',
    offset: 42,
    pendingBase64: Buffer.from('摸头').toString('base64'),
    droppingOversize: false,
  };

  try {
    assert.equal(await store.load(), undefined);
    await store.save(cursor);
    assert.deepEqual(await store.load(), cursor);

    await writeFile(path, '{"fileId":"broken"}', 'utf8');
    assert.equal(await store.load(), undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('tails appended JSONL exactly once across restart and UTF-8 chunk boundaries', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'stackchan-events-'));
  const path = join(directory, 'events.jsonl');
  const cursorStore = new MemoryCursorStore();
  const seen: Record<string, unknown>[] = [];

  try {
    await writeFile(
      path,
      `${JSON.stringify({ event_type: 'touch', note: '摸头' })}\n${JSON.stringify({ event_type: 'touch', note: '第二次' })}`,
      'utf8',
    );
    const source = createStackChanJsonlEventSource({
      path,
      cursorStore,
      readChunkBytes: 5,
      onEvent(event) {
        seen.push(event);
      },
    });

    assert.equal(await source.pollOnce(), 1);
    assert.deepEqual([...seen], [{ event_type: 'touch', note: '摸头' }]);

    await appendFile(path, '\n', 'utf8');
    assert.equal(await source.pollOnce(), 1);
    assert.deepEqual([...seen], [
      { event_type: 'touch', note: '摸头' },
      { event_type: 'touch', note: '第二次' },
    ]);

    const restarted = createStackChanJsonlEventSource({
      path,
      cursorStore,
      readChunkBytes: 7,
      onEvent(event) {
        seen.push(event);
      },
    });
    assert.equal(await restarted.pollOnce(), 0);
    assert.equal(seen.length, 2);

    await appendFile(path, `${JSON.stringify({ event_type: 'touch', note: '第三次' })}\n`);
    assert.equal(await restarted.pollOnce(), 1);
    assert.equal(seen.length, 3);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('resets on file replacement and skips malformed or oversized lines fail-closed', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'stackchan-events-'));
  const path = join(directory, 'events.jsonl');
  const cursorStore = new MemoryCursorStore();
  const seen: Record<string, unknown>[] = [];

  try {
    await writeFile(path, `${JSON.stringify({ generation: 1 })}\n`, 'utf8');
    const source = createStackChanJsonlEventSource({
      path,
      cursorStore,
      maxLineBytes: 48,
      readChunkBytes: 11,
      onEvent(event) {
        seen.push(event);
      },
    });
    assert.equal(await source.pollOnce(), 1);

    await rm(path);
    await writeFile(
      path,
      `${'x'.repeat(80)}\nnot-json\n${JSON.stringify({ generation: 2 })}\n`,
      'utf8',
    );

    assert.equal(await source.pollOnce(), 1);
    assert.deepEqual([...seen], [{ generation: 1 }, { generation: 2 }]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
