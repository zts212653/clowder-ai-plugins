import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { readMeetingSource } from '../src/source-reader.js';
import type { OwnedLarkCommand } from '../src/owned-lark-command.js';

// Pinned CLI1.0.85 docs +fetch emits data.document.content in its JSON
// envelope. It does not support an --output file flag (docs_fetch_v2.go).
test('normal meeting note reads the actual docs JSON output and rechecks its generation', async () => {
  const home = await mkdtemp(join(tmpdir(), 'meeting-note-source-'));
  let generationChecks = 0;
  const command: OwnedLarkCommand = async args => {
    if (args[0] === 'vc') { generationChecks++; return { ok: true, data: { meetings: [{ meeting_id: 'meeting1', note_id: 'note1', end_time: '1786381200000' }] } }; }
    if (args[0] === 'note') return { ok: true, data: { note_display_type: 'normal', verbatim_doc_token: 'doc1' } };
    assert.deepEqual(args, ['docs', '+fetch', '--doc', 'doc1', '--doc-format', 'markdown', '--format', 'json', '--as', 'user']);
    return { ok: true, data: { document: { content: 'Authorized source text' } } };
  };
  try {
    const result = await readMeetingSource({ artifactId: 'note1', kind: 'note', meetingId: 'meeting1', revision: '1786381200000', generatedAt: '2026-08-10T17:00:00.000Z' }, command, home, new AbortController().signal);
    assert.equal(result.text, 'Authorized source text');
    assert.equal(generationChecks, 2);
    assert.match(result.textSha256, /^[a-f0-9]{64}$/);
    assert.deepEqual(await readdir(home), [], 'temporary source files are removed');
  } finally { await rm(home, { recursive: true, force: true }); }
});
