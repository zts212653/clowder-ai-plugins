import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { PluginMember, PluginMemberHost } from '@clowder-ai/plugin-sdk';
import type { CollectiveConnector } from './business/connector/connector.js';
import { collectivePairingIntentSchema } from './business/contracts/types/collective.js';

interface ParticipationCat {
  readonly id: string;
  readonly displayName: string;
  readonly supported: boolean;
  readonly avatar?: string;
  readonly roleDescription?: string;
  readonly defaultModel?: string;
}
type RegisteredCat = Omit<PluginMember, 'catId' | 'supported'> & { readonly id: string };

/** Respect the Host member enable switch before applying Collective participation policy.
 * Disabled members stay in this local projection so reconciliation can retain their history. */
export function registeredCollectiveCats(
  cats: readonly RegisteredCat[],
  supportsParticipation: (catId: string) => boolean = () => true,
): ParticipationCat[] {
  const named = cats.map((cat) => {
    const qualifier = cat.variantLabel?.trim() || cat.nickname?.trim() || cat.defaultModel.trim();
    const displayName = cat.displayName.includes(qualifier) ? cat.displayName : `${cat.displayName}（${qualifier}）`;
    return { cat, displayName };
  });
  const counts = new Map<string, number>();
  for (const { displayName } of named) counts.set(displayName, (counts.get(displayName) ?? 0) + 1);
  return named.map(({ cat, displayName }) => ({
    id: cat.id,
    displayName: counts.get(displayName) === 1 ? displayName : `${displayName} · ${cat.id}`,
    supported: cat.available && supportsParticipation(cat.id),
    avatar: cat.avatar,
    roleDescription: cat.roleDescription,
    defaultModel: cat.defaultModel,
  }));
}

const pairBodySchema = z
  .object({
    serviceUrl: z.string().url(),
    endpointLabel: z.string().trim().min(1).max(160),
    intent: collectivePairingIntentSchema,
    rosterFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    excludedCatIds: z.array(z.string().trim().min(1).max(120)).max(100),
  })
  .strict();

export function entryRoster(cats: readonly ParticipationCat[]) {
  const cards = [...cats]
    .filter((cat) => cat.supported)
    .sort((left, right) => left.id.localeCompare(right.id))
    .map(({ id, displayName, supported, avatar, roleDescription, defaultModel }) => ({
      id,
      displayName,
      eligible: supported,
      ...(avatar ? { avatar } : {}),
      ...(roleDescription ? { roleDescription } : {}),
      ...(defaultModel ? { defaultModel } : {}),
    }));
  return { cats: cards, fingerprint: createHash('sha256').update(JSON.stringify(cards)).digest('hex') };
}

/** Original owner entry business caller. The surrounding owner webhook supplies
 * authentication/origin and the request lifetime; this is not a new authority lane. */
export function createCollectiveEntryCaller(options: {
  readonly members: PluginMemberHost;
  readonly connector: Pick<CollectiveConnector, 'pair'> | undefined;
  readonly assertCurrent: () => Promise<void>;
}) {
  const read = async (requestCurrent: () => Promise<void>) => {
    await requestCurrent(); await options.assertCurrent();
    const rows = await options.members.list();
    await requestCurrent(); await options.assertCurrent();
    return entryRoster(registeredCollectiveCats(rows.map(({ catId, ...row }) => ({ ...row, id: catId }))));
  };
  return Object.freeze({
    entryRoster: read,
    async pair(body: unknown, origin: string | undefined, requestCurrent: () => Promise<void>) {
      const parsed = pairBodySchema.safeParse(body);
      if (!parsed.success) return { status: 400, body: { code: 'PAIRING_INVALID', error: 'Invalid pairing request' } };
      const { rosterFingerprint, excludedCatIds, ...pair } = parsed.data;
      if (!origin || new URL(pair.intent.hostOrigin).origin !== origin)
        return { status: 403, body: { code: 'PAIRING_ORIGIN_MISMATCH', error: 'Pairing origin does not match this Host' } };
      const roster = await read(requestCurrent);
      if (roster.fingerprint !== rosterFingerprint || excludedCatIds.some(id => !roster.cats.some(cat => cat.id === id)))
        return { status: 409, body: { code: 'ENTRY_ROSTER_CHANGED', error: '伙伴名单已更新，请重新确认。' } };
      const connector = options.connector;
      if (!connector) return { status: 409, body: { code: 'CONNECTOR_INACTIVE', error: 'Collective Connector is not active' } };
      await requestCurrent(); await options.assertCurrent();
      let connection: Awaited<ReturnType<typeof connector.pair>>;
      try {
        connection = await connector.pair({ ...pair, initialExcludedCatIds: excludedCatIds });
      } catch (error) {
        await requestCurrent(); await options.assertCurrent();
        if (error instanceof Error && error.message === 'This Café is already connected to this Collective')
          return { status: 409, body: { code: 'COLLECTIVE_ALREADY_CONNECTED', error: '这台 Café 已连接此 Collective。' } };
        return { status: 502, body: { code: 'CONNECTOR_OPERATION_FAILED', error: 'Collective pairing failed' } };
      }
      await requestCurrent(); await options.assertCurrent();
      return { status: 200, body: connection };
    },
  });
}
