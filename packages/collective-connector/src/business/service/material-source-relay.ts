import { z } from 'zod';
import { collectiveConnectionCoordinatesSchema } from '../contracts/types/collective.js';
import {
  collectiveMaterialSourceResultSchema,
  type CollectiveMaterialOperation,
  type CollectiveMaterialSourcePort,
  type CollectiveMaterialSourceResult,
} from '../contracts/types/collective-material.js';
import { assertConnectionCoordinates, requireAuthorizedHuman, requireConnection } from './connection-authority.js';
import { CollectiveServiceError } from './errors.js';
import type { PersistentServiceState } from './persistence.js';
import { authorizeMaterialPublication } from './project-material-authority.js';

interface Pending {
  operation: CollectiveMaterialOperation;
  resolve(value: CollectiveMaterialSourceResult): void;
  timer: ReturnType<typeof setTimeout>;
}
const responseSchema = collectiveConnectionCoordinatesSchema
  .extend({ relayRef: z.string().min(1).max(200), result: collectiveMaterialSourceResultSchema })
  .strict();
const absent = { status: 'unavailable', reason: 'owner_unavailable' } as const;

/** Bounded transient transport to the installed source owner. No source content is persisted. */
export class CollectiveMaterialSourceRelay implements CollectiveMaterialSourcePort {
  private readonly pending = new Map<string, Pending>();
  private active = true;
  constructor(private readonly persistence: PersistentServiceState) {}
  start() {
    this.active = true;
  }
  stop() {
    this.active = false;
    for (const [id, pending] of this.pending) this.finish(id, pending, absent);
  }
  async execute(
    operation: CollectiveMaterialOperation,
    authority: Parameters<CollectiveMaterialSourcePort['execute']>[1],
  ) {
    await authority.reauthorize();
    if (!this.active || this.pending.size >= 100) return absent;
    const result = await new Promise<CollectiveMaterialSourceResult>((resolve) => {
      const timer = setTimeout(() => {
        const current = this.pending.get(operation.relayRef);
        if (current) this.finish(operation.relayRef, current, absent);
      }, 10_000);
      timer.unref();
      this.pending.set(operation.relayRef, { operation: structuredClone(operation), resolve, timer });
    });
    await authority.reauthorize();
    return result;
  }
  poll(credential: string, unsafe: unknown) {
    const input = collectiveConnectionCoordinatesSchema.parse(unsafe);
    this.connection(credential, input);
    const operations: CollectiveMaterialOperation[] = [];
    for (const [id, pending] of this.pending) {
      if (pending.operation.publication.connectionId !== input.connectionId) continue;
      try {
        authorizeMaterialPublication(this.persistence.snapshot(), pending.operation.publication);
      } catch {
        this.finish(id, pending, absent);
        continue;
      }
      operations.push(structuredClone(pending.operation));
      if (operations.length === 8) break;
    }
    return { operations };
  }
  validate(credential: string, unsafe: unknown) {
    const input = collectiveConnectionCoordinatesSchema
      .extend({ relayRef: z.string().min(1).max(200) })
      .strict()
      .parse(unsafe);
    this.connection(credential, input);
    const pending = this.pending.get(input.relayRef);
    if (!pending || pending.operation.publication.connectionId !== input.connectionId)
      throw new CollectiveServiceError('MATERIAL_SOURCE_UNAVAILABLE', 'Material read is no longer current', 409);
    return { publication: authorizeMaterialPublication(this.persistence.snapshot(), pending.operation.publication) };
  }
  respond(credential: string, unsafe: unknown) {
    const input = responseSchema.parse(unsafe);
    const { result: _, ...target } = input;
    this.validate(credential, target);
    const pending = this.pending.get(input.relayRef)!;
    const result = Buffer.byteLength(JSON.stringify(input.result)) <= 1_048_576 ? input.result : absent;
    this.finish(input.relayRef, pending, result);
    return { acknowledged: true };
  }
  private connection(credential: string, input: z.infer<typeof collectiveConnectionCoordinatesSchema>) {
    const state = this.persistence.snapshot(),
      connection = requireConnection(state, credential, input.connectionId);
    assertConnectionCoordinates(state, connection, input);
    requireAuthorizedHuman(state, connection);
  }
  private finish(id: string, pending: Pending, value: CollectiveMaterialSourceResult) {
    clearTimeout(pending.timer);
    this.pending.delete(id);
    pending.resolve(value);
  }
}
