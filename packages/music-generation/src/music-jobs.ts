import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { privateDirectory, readOptional, writeNew } from './private-files.js';
import { musicEstimate, musicProvenance } from './music-provenance.js';
import { current, MusicError, musicInput, object, projectId, type GoogleCredentials, type MusicActionCall, type MusicDependencies, type MusicHost, type MusicInput } from './types.js';

const digest = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
type Provenance = ReturnType<typeof musicProvenance>;
export type MusicJobResult =
  | { state: 'pending' | 'generation_unknown'; code?: string; retryable: false }
  | { state: 'rejected'; code: string; retryable: false }
  | { state: 'produced'; media: { sourceId: 'music-media'; reference: string; mimeType: 'audio/mpeg'; bytes: number; sha256: string }; provenance: Provenance };

/** Provider-owned durable media. No project target, Host token or credential is stored in these records. */
export class MusicJobs {
  private readonly running = new Map<string, Promise<void>>();
  private readonly lifetime = new AbortController();
  private stopped = false;
  constructor(private readonly host: MusicHost, private readonly dependencies: MusicDependencies) {}

  async begin(input: MusicInput, grant: GoogleCredentials, call?: MusicActionCall): Promise<MusicJobResult> {
    const id = await this.operation(call);
    const directory = await this.directory(id);
    const inputDigest = digest(JSON.stringify({ projectId: grant.quota_project_id, input }));
    const claim = { operationId: id, instanceId: this.host.pluginInstanceId, inputDigest, input, projectId: grant.quota_project_id, timestamp: new Date().toISOString(), estimatedUsd: musicEstimate(input) };
    try { await writeNew(join(directory, 'claim.json'), JSON.stringify(claim)); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const previous = await readOptional(join(directory, 'claim.json'));
      if (!object(previous) || previous.instanceId !== this.host.pluginInstanceId || previous.operationId !== id || previous.inputDigest !== inputDigest)
        throw new MusicError('operation_conflict');
      return this.result(call);
    }
    // The immutable claim is fsynced before provider work. A recovered claim is never redispatched.
    // This job owns no request-scoped Host client; only its captured grant and private data directory.
    await current(call);
    const pending = this.generate(id, directory, input, grant, claim.timestamp, claim.estimatedUsd).catch(() => {});
    this.running.set(id, pending);
    void pending.finally(() => { this.running.delete(id); });
    return { state: 'pending', retryable: false };
  }

  async result(call?: MusicActionCall): Promise<MusicJobResult> {
    const id = await this.operation(call);
    const directory = await this.directory(id);
    const claim = await readOptional(join(directory, 'claim.json'));
    if (!object(claim) || claim.operationId !== id || claim.instanceId !== this.host.pluginInstanceId) throw new MusicError('operation_unavailable');
    const result = await readOptional(join(directory, 'result.json'), 64 * 1024);
    if (result === undefined) {
      if (this.running.has(id)) return { state: 'pending', retryable: false };
      return await this.recoverAudio(id, directory, claim) ?? { state: 'generation_unknown', retryable: false };
    }
    if (!object(result) || !['produced', 'rejected', 'generation_unknown'].includes(String(result.state))) throw new MusicError('invalid_result_record');
    if (result.state === 'produced') {
      if (!object(result.provenance) || result.provenance.operationId !== id || !object(result.media) ||
          result.media.reference !== this.reference(id) || result.media.sourceId !== 'music-media') throw new MusicError('invalid_result_record');
      return result as MusicJobResult;
    }
    return { state: result.state as 'rejected' | 'generation_unknown', code: typeof result.code === 'string' ? result.code : 'generation_failed', retryable: false };
  }

  async *read(reference: string, signal?: AbortSignal): AsyncIterable<Uint8Array> {
    if (this.stopped) throw new MusicError('plugin_stopped');
    const match = /^pmr_music_([a-f0-9]{64})$/.exec(reference);
    if (!match) throw new MusicError('media_unavailable');
    const directory = join(this.host.dataPath, 'music-jobs', match[1]!);
    const result = await readOptional(join(directory, 'result.json'), 64 * 1024);
    if (!object(result) || result.state !== 'produced' || !object(result.media) || result.media.reference !== reference) throw new MusicError('media_unavailable');
    const handle = await open(join(directory, 'audio.mp3'), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.nlink !== 1 || stat.size !== result.media.bytes || stat.size > 48 * 1024 * 1024) throw new MusicError('media_unavailable');
      let offset = 0;
      for (;;) {
        if (this.stopped) throw new MusicError('plugin_stopped');
        signal?.throwIfAborted();
        const chunk = Buffer.alloc(64 * 1024);
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, offset);
        if (!bytesRead) break;
        offset += bytesRead;
        yield chunk.subarray(0, bytesRead);
      }
    } finally { await handle.close(); }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.lifetime.abort();
    await this.drain();
  }
  async drain(): Promise<void> { await Promise.all(this.running.values()); }

  private async operation(call?: MusicActionCall): Promise<string> {
    if (this.stopped) throw new MusicError('plugin_stopped');
    await current(call);
    const id = call?.outputOperation?.id;
    if (!id || !/^[a-zA-Z0-9_-]{1,160}$/.test(id)) throw new MusicError('host_output_required');
    return id;
  }
  private reference(id: string): string { return `pmr_music_${digest(`${this.host.pluginInstanceId}\0${id}`)}`; }
  private async directory(id: string) {
    const root = join(this.host.dataPath, 'music-jobs');
    await privateDirectory(root);
    const path = join(root, this.reference(id).slice('pmr_music_'.length));
    await privateDirectory(path);
    return path;
  }
  private async recoverAudio(id: string, directory: string, claim: Record<string, unknown>): Promise<MusicJobResult | undefined> {
    let file: FileHandle;
    try { file = await open(join(directory, 'audio.mp3'), constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.nlink !== 1 || stat.size < 4 || stat.size > 48 * 1024 * 1024 ||
          typeof claim.timestamp !== 'string' || !Number.isFinite(Date.parse(claim.timestamp)) ||
          typeof claim.estimatedUsd !== 'number' || claim.estimatedUsd < 0 || claim.estimatedUsd > 1_000_000) return undefined;
      const bytes = await file.readFile();
      if (!(bytes.toString('ascii', 0, 3) === 'ID3' || (bytes[0] === 255 && (bytes[1]! & 224) === 224))) return undefined;
      const media = { sourceId: 'music-media' as const, reference: this.reference(id), mimeType: 'audio/mpeg' as const, bytes: bytes.length, sha256: digest(bytes) };
      const provenance = musicProvenance({ operationId: id, music: musicInput(claim.input), timestamp: claim.timestamp,
        project: projectId(claim.projectId), estimatedUsd: claim.estimatedUsd, bytes: bytes.length, sha256: media.sha256, recovered: true });
      const recovered = { state: 'produced' as const, media, provenance };
      await writeNew(join(directory, 'result.json'), JSON.stringify(recovered)).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; });
      return recovered;
    } finally { await file.close(); }
  }
  private async generate(id: string, directory: string, input: MusicInput, grant: GoogleCredentials, timestamp: string, estimatedUsd: number): Promise<void> {
    try {
      const result = await this.dependencies.generate(input, grant, AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(600_000)]));
      if (result.bytes.length > 48 * 1024 * 1024) throw new MusicError('invalid_response', true);
      const media = { sourceId: 'music-media' as const, reference: this.reference(id), mimeType: 'audio/mpeg' as const, bytes: result.bytes.length, sha256: digest(result.bytes) };
      const provenance = musicProvenance({ operationId: id, music: input, timestamp, project: grant.quota_project_id,
        estimatedUsd, bytes: media.bytes, sha256: media.sha256,
        ...(result.responseId === undefined ? {} : { responseId: result.responseId }),
        ...(result.modelVersion === undefined ? {} : { modelVersion: result.modelVersion }) });
      await writeNew(join(directory, 'audio.mp3'), result.bytes);
      await writeNew(join(directory, 'result.json'), JSON.stringify({ state: 'produced', media, provenance }));
    } catch (error) {
      const known = error instanceof MusicError ? error : undefined;
      await writeNew(join(directory, 'result.json'), JSON.stringify({ state: known && !known.uncertain ? 'rejected' : 'generation_unknown', code: known?.code ?? 'generation_unknown', retryable: false }));
    }
  }
}
