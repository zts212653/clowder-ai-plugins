import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import type { PluginOwnerOperationContext } from '@clowder-ai/plugin-sdk';
import type { MeetingRecord } from './record-delivery.js';
import { readPrivate, writePrivate } from './private-files.js';

// This provider-owned receipt is deliberately independent of Work-result publication.
const publicationSchema = z.object({
  publicationId: z.string().min(1).max(200),
  serviceInstanceId: z.string().min(1),
  collectiveId: z.string().min(1),
  connectionId: z.string().min(1),
  humanId: z.string().min(1),
  roadmapId: z.string().min(1),
  channelId: z.string().min(1),
  sourceEventId: z.string().startsWith('evt_'),
  provider: z.literal('feishu'),
  sourceId: z.string().min(1).max(2048),
});
const operationSchema = z.object({ action: z.enum(['publish', 'read']), publication: publicationSchema }).passthrough();
const receiptSchema = z
  .object({
    v: z.literal(1),
    ownerUserId: z.string(),
    pluginInstanceId: z.string(),
    publication: publicationSchema,
    recordId: z.string().regex(/^[a-f0-9]{64}$/),
    publishedWitness: z
      .object({
        digest: z.string().regex(/^[a-f0-9]{64}$/),
        readAt: z.string().datetime(),
        generationScope: z.string(),
      })
      .strict(),
  })
  .strict();
type ReadSource = { text: string; textSha256: string; readAt: string; generationRevision: string; title?: string };
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const absent = { status: 'unavailable', reason: 'not_published' } as const;

/** Only a Host-authenticated explicit publication can make a private record readable in a Channel. */
export function createMeetingSourcePublication(deps: {
  directory: string;
  getRecord(id: string): Promise<MeetingRecord | undefined>;
  readSource(record: MeetingRecord): Promise<ReadSource>;
}) {
  return async (unsafe: unknown, owner: PluginOwnerOperationContext) => {
    if (owner.kind !== 'owner-operation' || owner.operationKey !== 'sourceMaterial' || owner.actionId !== 'invoke')
      throw new Error('Meeting publication requires its authenticated owner operation');
    const { action, publication } = operationSchema.parse(unsafe);
    await owner.assertCurrent();
    owner.signal.throwIfAborted();
    const key = digest(JSON.stringify([owner.userId, owner.pluginInstanceId, publication.publicationId]));
    const path = join(deps.directory, key + '.json');
    const bytes = await readPrivate(path);
    const prior = bytes ? receiptSchema.parse(JSON.parse(bytes.toString('utf8'))) : undefined;
    if (
      prior &&
      (prior.ownerUserId !== owner.userId ||
        prior.pluginInstanceId !== owner.pluginInstanceId ||
        !isDeepStrictEqual(prior.publication, publication))
    )
      throw new Error('Meeting publication scope changed');
    if (!prior && action === 'read') return absent;
    let recordId = publication.sourceId;
    if (recordId.startsWith('feishu://meeting-artifacts/')) recordId = digest(recordId);
    if (!/^[a-f0-9]{64}$/.test(recordId)) return absent;
    const record = await deps.getRecord(recordId);
    await owner.assertCurrent();
    if (!record || record.pluginInstanceId !== owner.pluginInstanceId || (prior && prior.recordId !== record.id))
      return absent;
    let source: ReadSource;
    try {
      source = await deps.readSource(record);
    } catch {
      await owner.assertCurrent();
      return { status: 'unavailable', reason: 'owner_unavailable' } as const;
    }
    await owner.assertCurrent();
    owner.signal.throwIfAborted();
    const witness = { digest: source.textSha256, readAt: source.readAt, generationScope: source.generationRevision };
    if (!prior)
      await writePrivate(
        path,
        JSON.stringify(
          receiptSchema.parse({
            v: 1,
            ownerUserId: owner.userId,
            pluginInstanceId: owner.pluginInstanceId,
            publication,
            recordId: record.id,
            publishedWitness: witness,
          }),
        ),
        () => owner.assertCurrent(),
        true,
      );
    await owner.assertCurrent();
    // These are source passages, not invented Cat recommendations. A Cat can later suggest a target explicitly.
    const seen = new Map<string, number>();
    const clauses = source.text
      .split(/\n\s*\n|\n/)
      .map((text) => text.trim())
      .filter(Boolean)
      .slice(0, 200)
      .map((text) => {
        const hash = digest(text),
          occurrence = seen.get(hash) ?? 0;
        seen.set(hash, occurrence + 1);
        return { clauseId: `passage_${hash}_${occurrence}`, text: text.slice(0, 32_000) };
      });
    return {
      status: 'available',
      sourceKey: `feishu:${record.descriptor.kind}:${record.descriptor.artifactId}`,
      sourceRef: `feishu://meeting-artifacts/${record.descriptor.kind}/${record.descriptor.artifactId}?revision=${source.generationRevision}`,
      witness,
      material: {
        kind: 'meeting',
        title: (source.title?.trim() || record.descriptor.title?.trim() || '会议纪要').slice(0, 500),
        occurredAt: record.descriptor.generatedAt,
        clauses,
      },
    } as const;
  };
}
