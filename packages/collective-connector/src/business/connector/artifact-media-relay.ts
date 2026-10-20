import type { Readable } from 'node:stream';
import {
  type CollectiveArtifactMediaOperation,
  type CollectiveMediaReadRequest,
  collectiveMediaRelaySlots,
} from '../contracts/index.js';
import type { CollectiveArtifactMediaReadPort, CollectiveArtifactMediaResult } from './artifact-media-owner-port.js';
import type { ConnectorPersistence } from './persistence.js';
import { type CollectiveServiceClient, ConnectorTransportError } from './service-client.js';
import { workCoordinates } from './work-policy-custody.js';

/** Tracked streaming jobs release the ordinary authority lock; slow media cannot stop Channel/Work synchronization. */
export class ConnectorArtifactMediaRelay {
  private owner: CollectiveArtifactMediaReadPort | undefined;
  private readonly jobs = new Map<
    string,
    { connectionId: string; controller: AbortController; promise: Promise<void> }
  >();
  private readonly readers = new Map<AbortController, Promise<void>>();
  private readonly polls = new Map<string, Promise<void>>();
  private generation = 0;
  private closed = false;
  constructor(
    private readonly persistence: ConnectorPersistence,
    private readonly service: CollectiveServiceClient,
  ) {}
  setOwner(owner: CollectiveArtifactMediaReadPort | undefined, enabled: boolean) {
    void this.stop();
    this.owner = owner;
    this.closed = !enabled;
  }
  async stop() {
    this.closed = true;
    this.generation++;
    const readers = [...this.readers];
    for (const [reader] of readers) reader.abort();
    for (const job of this.jobs.values()) job.controller.abort();
    await Promise.allSettled([
      ...readers.map(([, done]) => done),
      ...[...this.jobs.values()].map((job) => job.promise),
    ]);
  }
  readAdmission() {
    const generation = this.generation;
    const assertCurrent = () => {
      if (this.closed || generation !== this.generation)
        throw new ConnectorTransportError('Media read admission is stopped', 503, 'ARTIFACT_MEDIA_STOPPED');
    };
    assertCurrent();
    return assertCurrent;
  }
  sync(connectionId: string): Promise<void> {
    const current = this.polls.get(connectionId);
    if (current) return current;
    const job = this.poll(connectionId).finally(() => {
      if (this.polls.get(connectionId) === job) this.polls.delete(connectionId);
    });
    this.polls.set(connectionId, job);
    return job;
  }
  prepareRead(
    connectionId: string,
    ownerUserId: string,
    input: Omit<CollectiveMediaReadRequest, 'serviceInstanceId' | 'collectiveId' | 'connectionId'>,
    signal: AbortSignal,
    assertAdmission: () => void,
  ) {
    assertAdmission();
    const current = () => {
      const connection = this.connection(connectionId);
      if (this.persistence.snapshot().hostRoutes[connectionId]?.localOwnerUserId !== ownerUserId)
        throw new ConnectorTransportError(
          'This Host Human does not own the paired Cafe',
          403,
          'ARTIFACT_ACCESS_DENIED',
        );
      return connection;
    };
    const initial = current();
    return async () => {
      assertAdmission();
      signal.throwIfAborted();
      const connection = current();
      if (connection.endpointCredential !== initial.endpointCredential)
        throw new ConnectorTransportError('Cafe authority changed', 403, 'ARTIFACT_ACCESS_DENIED');
      if (this.readers.size >= collectiveMediaRelaySlots)
        throw new ConnectorTransportError('Media streams are busy', 429, 'ARTIFACT_BUSY');
      const controller = new AbortController();
      let finish = () => {};
      const done = new Promise<void>((resolve) => {
        finish = resolve;
      });
      this.readers.set(controller, done);
      const release = () => {
        this.readers.delete(controller);
        controller.abort();
        finish();
      };
      let body: Readable | undefined;
      try {
        const opened = await this.service.media.read(
          connection.serviceUrl,
          connection.endpointCredential,
          { ...input, ...workCoordinates(connection) },
          AbortSignal.any([signal, controller.signal]),
        );
        body = opened.body;
        assertAdmission();
        signal.throwIfAborted();
        const fresh = current();
        if (fresh.endpointCredential !== initial.endpointCredential)
          throw new ConnectorTransportError('Cafe authority changed', 403, 'ARTIFACT_ACCESS_DENIED');
        body.once('close', release);
        if (body.closed) release();
        return opened;
      } catch (error) {
        body?.destroy();
        release();
        throw error;
      }
    };
  }
  private async poll(connectionId: string) {
    const owner = this.owner;
    const generation = this.generation;
    if (
      this.closed ||
      !owner ||
      this.jobs.size >= 8 ||
      [...this.jobs.values()].filter((job) => job.connectionId === connectionId).length >= 4
    )
      return;
    const connection = this.connection(connectionId),
      coordinates = workCoordinates(connection);
    let operations: CollectiveArtifactMediaOperation[];
    try {
      operations = await this.service.media.poll(connection.serviceUrl, connection.endpointCredential, coordinates);
    } catch (error) {
      if (error instanceof ConnectorTransportError && error.statusCode === 404) return;
      throw error;
    }
    if (this.closed || generation !== this.generation || owner !== this.owner) return;
    for (const operation of operations) {
      if (this.jobs.has(operation.relayRef) || this.jobs.size >= 8) continue;
      const controller = new AbortController();
      const promise = this.deliver(connectionId, owner, operation, controller.signal)
        .catch(() => {})
        .finally(() => this.jobs.delete(operation.relayRef));
      this.jobs.set(operation.relayRef, { connectionId, controller, promise });
    }
  }
  private async deliver(
    connectionId: string,
    owner: CollectiveArtifactMediaReadPort,
    operation: CollectiveArtifactMediaOperation,
    signal: AbortSignal,
  ) {
    const connection = this.connection(connectionId),
      coordinates = workCoordinates(connection);
    let result: CollectiveArtifactMediaResult;
    const reauthorize = async () => {
      signal.throwIfAborted();
      if (this.connection(connectionId).endpointCredential !== connection.endpointCredential)
        throw new ConnectorTransportError('Cafe authority changed', 403, 'ARTIFACT_ACCESS_DENIED');
      return this.service.artifacts.reauthorize(connection.serviceUrl, connection.endpointCredential, coordinates, {
        ...operation,
        requestId: operation.relayRef,
        payload: {},
      });
    };
    try {
      await reauthorize();
      result = await owner.read(operation, { reauthorize }, signal);
      try {
        await reauthorize();
      } catch (error) {
        if (result.status === 'ok') result.body.destroy();
        throw error;
      }
    } catch (error) {
      result = {
        status: 'error',
        error: {
          code:
            error instanceof ConnectorTransportError && error.statusCode === 403
              ? 'access_denied'
              : 'owner_unavailable',
        },
      };
    }
    try {
      await this.service.media.respond(
        connection.serviceUrl,
        connection.endpointCredential,
        coordinates,
        operation,
        result,
        signal,
      );
    } catch {
      if (result.status === 'ok') result.body.destroy();
    }
  }
  private connection(id: string) {
    const connection = this.persistence.snapshot().connections[id];
    if (!connection || connection.authorityStatus !== 'connected' || !connection.endpointCredential)
      throw new ConnectorTransportError('Cafe authority is unavailable', 403, 'ARTIFACT_ACCESS_DENIED');
    return { ...connection, endpointCredential: connection.endpointCredential };
  }
}
