import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createFileAttachmentOwner } from './file-owner.js';
import { attachmentDigest } from './file-store.js';

const toolsAvailable = ['ffmpeg', 'ffprobe'].every(
  (tool) => spawnSync(tool, ['-version'], { timeout: 5_000, stdio: 'ignore' }).status === 0,
);

it.skipIf(!toolsAvailable)(
  'decodes actual retained audio/video, reports unavailable transcription and returns an original-bound frame',
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'collective-independent-av-'));
    try {
      const videoPath = join(directory, 'sample.mp4');
      execFileSync(
        'ffmpeg',
        [
          '-v',
          'error',
          '-f',
          'lavfi',
          '-i',
          'color=c=blue:s=160x96:d=0.5',
          '-f',
          'lavfi',
          '-i',
          'sine=frequency=440:duration=0.5',
          '-c:v',
          'mpeg4',
          '-c:a',
          'aac',
          '-threads',
          '1',
          '-shortest',
          videoPath,
        ],
        { timeout: 15_000, stdio: 'pipe' },
      );
      const wav = execFileSync(
        'ffmpeg',
        ['-v', 'error', '-i', videoPath, '-vn', '-ac', '1', '-ar', '16000', '-f', 'wav', 'pipe:1'],
        { timeout: 15_000, maxBuffer: 4 * 1024 * 1024 },
      );
      const owner = createFileAttachmentOwner(join(directory, 'custody'));
      const scope = {
        serviceInstanceId: 'svc_original1',
        collectiveId: 'col_original1',
        humanId: 'human_original1',
        channelId: 'general',
        attachmentId: 'att_audio111',
      };
      const auth = {
        async reauthorize() {
          return scope;
        },
      };
      const signal = new AbortController().signal;
      const audio = await owner.retain(
        { scope, bytes: wav, blobDigest: attachmentDigest(wav), fileName: 'actual.wav', mediaType: 'audio/wav' },
        auth,
        signal,
      );
      expect(
        await owner.modelContent!(
          { scope, attachment: audio, selection: { eventId: 'event_actual', attachmentId: audio.attachmentId } },
          auth,
          signal,
        ),
      ).toMatchObject({
        sourceDigest: audio.blobDigest,
        content: { type: 'unavailable', reason: 'transcription_unavailable' },
      });
      const videoScope = { ...scope, attachmentId: 'att_video111' };
      const videoAuth = {
        async reauthorize() {
          return videoScope;
        },
      };
      const bytes = await readFile(videoPath);
      const video = await owner.retain(
        {
          scope: videoScope,
          bytes,
          blobDigest: attachmentDigest(bytes),
          fileName: 'actual.mp4',
          mediaType: 'video/mp4',
        },
        videoAuth,
        signal,
      );
      expect(
        await owner.modelContent!(
          {
            scope: videoScope,
            attachment: video,
            selection: { eventId: 'event_actual', attachmentId: video.attachmentId },
          },
          videoAuth,
          signal,
        ),
      ).toMatchObject({
        sourceDigest: video.blobDigest,
        content: {
          type: 'video',
          atSeconds: 0,
          frame: { sourceDigest: video.blobDigest, width: 160, height: 96 },
          audio: { status: 'unavailable', reason: 'transcription_unavailable' },
        },
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
