import { constants } from 'node:fs';
import { mkdtemp, open, realpath, rm } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import { createHash } from 'node:crypto';
import type { FeishuGeneratedArtifact } from './gateway.js';
import type { OwnedLarkCommand } from './owned-lark-command.js';
import { createLarkCliFeishuArtifactInspector } from './lark-cli-artifact-inspector.js';
import { requireMeetingDetails, noteArtifact } from './lark-cli-polling-normalizer.js';

/** The old normalized revision is a generation timestamp, not a transcript edit
 * version. Verify that generation, fetch currently authorized text, and expose a
 * separate text digest/read time; never label this as an immutable provider version. */
export async function readMeetingSource(descriptor: FeishuGeneratedArtifact, command: OwnedLarkCommand, home: string, signal: AbortSignal) {
  const inspector = createLarkCliFeishuArtifactInspector({ homeDirectory: home, runCommand: command });
  const check = async () => {
    signal.throwIfAborted();
    if (descriptor.kind === 'minute') await inspector(descriptor, signal);
    else {
      if (!descriptor.meetingId) throw new Error('Note generation scope is unavailable');
      const meetings = requireMeetingDetails(await command(['vc','+detail','--meeting-ids',descriptor.meetingId,'--as','user','--format','json'], signal));
      const meeting = meetings.find(item => item.meetingId === descriptor.meetingId && item.noteId === descriptor.artifactId);
      if (!meeting || noteArtifact(meeting).revision !== descriptor.revision) throw new Error('Note generation revision is unavailable');
    }
  };
  await check();
  const temporary = await mkdtemp(join(home, 'source-'));
  try {
    let file = '', text: string | undefined;
    if (descriptor.kind === 'minute') {
      const result = await command(['minutes','+detail','--minute-tokens',descriptor.artifactId,'--transcript','--output-dir','.','--format','json','--as','user'], signal, temporary) as { data?: { minutes?: { minute_token: string; artifacts?: { transcript_file?: string } }[] } };
      const match = result.data?.minutes?.find(item => item.minute_token === descriptor.artifactId);
      file = match?.artifacts?.transcript_file ?? '';
    } else {
      const detail = await command(['note','+detail','--note-id',descriptor.artifactId,'--format','json','--as','user'], signal, temporary) as { data?: { note_display_type?: string; verbatim_doc_token?: string } };
      if (detail.data?.note_display_type === 'unified') {
        await command(['note','+transcript','--note-id',descriptor.artifactId,'--transcript-format','plain_text','--output','./note.txt','--format','json','--as','user'], signal, temporary);
      } else {
        const token = detail.data?.verbatim_doc_token;
        if (typeof token !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(token)) throw new Error('Note transcript document is unavailable');
        const result = await command(['docs','+fetch','--doc',token,'--doc-format','markdown','--format','json','--as','user'], signal, temporary) as { ok?: boolean; data?: { document?: { content?: unknown } } };
        const content = result.data?.document?.content;
        if (result.ok !== true || typeof content !== 'string' || Buffer.byteLength(content, 'utf8') > 2_000_000) throw new Error('Feishu note transcript is unavailable or exceeds its bound');
        text = content;
      }
      file = 'note.txt';
    }
    if (text === undefined) {
      if (!file || isAbsolute(file)) throw new Error('Feishu transcript output is invalid');
      const path = await realpath(join(temporary, file));
      const escaped = relative(await realpath(temporary), path);
      if (escaped === '..' || escaped.startsWith('../') || isAbsolute(escaped)) throw new Error('Feishu transcript output escaped its private directory');
      const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const stat = await fd.stat();
        if (!stat.isFile() || stat.size > 2_000_000) throw new Error('Feishu transcript exceeds its bound');
        const bytes = Buffer.alloc(2_000_001); let offset = 0;
        while (offset < bytes.length) { const { bytesRead } = await fd.read(bytes, offset, bytes.length - offset, offset); if (!bytesRead) break; offset += bytesRead; }
        if (offset > 2_000_000) throw new Error('Feishu transcript exceeds its bound');
        text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, offset));
      } finally { await fd.close(); }
    }
    await check(); signal.throwIfAborted();
    return { text, generationRevision: descriptor.revision, textSha256: createHash('sha256').update(text).digest('hex'), readAt: new Date().toISOString() };
  } finally { await rm(temporary, { recursive: true, force: true }); }
}
