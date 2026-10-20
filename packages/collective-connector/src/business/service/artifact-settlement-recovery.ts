import type { CollectiveArtifactRelayOperation } from '../contracts/index.js';
import { z } from 'zod';
import { denyArtifact, requireArtifact } from './artifact-authority.js';
import { artifactSettlementSchema, recordArtifactSettlement } from './artifact-settlement.js';
import type { MutableServiceState } from './state.js';

const recoverySchema = z
  .object({ v: z.literal(1), settlements: artifactSettlementSchema.array().min(1).max(30) })
  .strict();

/** Current reader/custody authority reveals only the receipt of an already completed historical effect. */
export function reconcileArtifactSettlements(
  state: MutableServiceState,
  operation: CollectiveArtifactRelayOperation,
  value: Record<string, unknown>,
  now: number,
) {
  const { settlementRecovery, ...publicValue } = value;
  const c = operation.constraint;
  if (c.agent || !['read', 'history'].includes(c.action)) denyArtifact();
  if (Buffer.byteLength(JSON.stringify(settlementRecovery)) > 64 * 1024) denyArtifact();
  const recovery = recoverySchema.parse(settlementRecovery);
  const before = requireArtifact(state, c.collectiveId, c.artifactId).revision;
  for (const settlement of recovery.settlements) recordArtifactSettlement(state, operation, settlement, now, true);
  const changed = requireArtifact(state, c.collectiveId, c.artifactId).revision !== before;
  return { ...publicValue, ...(changed ? { catalogueReconciled: true } : {}) };
}
