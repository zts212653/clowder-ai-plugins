/** Observations for this owned connection, not another policy store. Native
 * journal/epoch are authoritative; a fresh connection must catch up once. */
export class SyncState {
  constructor() { this.current = null; this.pending = null; }
  snapshot(identity) {
    const current = this.current;
    if (!identity?.stream || !current || current.instanceId !== identity.serverId || current.accountGeneration !== identity.accountGeneration || current.sourceRef !== identity.stream.sourceRef || current.resetEpoch !== identity.stream.resetEpoch)
      return { ready: false, initialized: false, sourceRef: identity?.stream?.sourceRef ?? null };
    return { ...current, ready: current.initialized && identity.stream.caughtUp === true && current.caughtUp === true };
  }
  pull(client, identity) {
    const key = JSON.stringify([identity.serverId, identity.accountGeneration, identity.stream.sourceRef, identity.stream.resetEpoch]);
    if (this.pending?.client === client && this.pending.key === key) return this.pending.promise;
    const previous = this.current;
    const request = { client, key, promise: null };
    const promise = (async () => {
      const page = await client.pull(identity);
      const same = previous?.instanceId === identity.serverId && previous.accountGeneration === identity.accountGeneration && previous.sourceRef === page.stream.sourceRef && previous.resetEpoch === page.stream.resetEpoch;
      const next = { instanceId: identity.serverId, accountGeneration: identity.accountGeneration, sourceRef: page.stream.sourceRef, resetEpoch: page.stream.resetEpoch,
        eventCursor: page.stream.eventCursor, caughtUp: page.stream.caughtUp, initialized: page.stream.caughtUp || same && previous.initialized && !page.reset };
      if (this.pending === request) this.current = next;
      return { ...next, reset: page.reset, changed: Boolean(previous && !same) };
    })().finally(() => { if (this.pending === request) this.pending = null; });
    request.promise = promise; this.pending = request; return promise;
  }
}
