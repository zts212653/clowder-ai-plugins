import {ConnectorTransportError, type CollectiveLocalTransport} from './business/connector/service-client.js';
import type {CollectiveServiceStore} from './business/service/store.js';

/** Calls the plugin's own listener and store, without Host binding or framing. */
export function createLocalServiceTransport(origin: string, assertActive: () => void, store: CollectiveServiceStore): CollectiveLocalTransport {
  return {
    matches: serviceUrl => new URL(serviceUrl).origin===origin,
    async assertCurrent() {assertActive();},
    async readRecovery(connection, clientEventId) {
      assertActive();
      if (!connection.endpointCredential || !connection.authorizedHumanId) throw new Error('Recovery authority is unavailable');
      return store.readLocalRecoverySnapshot(connection.endpointCredential, {
        serviceInstanceId:connection.serviceInstanceId, collectiveId:connection.collectiveId, connectionId:connection.connectionId,
        endpointId:connection.endpointId, authorizedHumanId:connection.authorizedHumanId,
      },clientEventId);
    },
    async fetch(input, init) {
      try {assertActive();} catch {throw new ConnectorTransportError('Collective service stopped',undefined,'COLLECTIVE_SERVICE_STOPPED',{code:'COLLECTIVE_SERVICE_STOPPED',effect:'not_started',automaticRetry:false});}
      if (!(typeof input==='string' || input instanceof URL)) throw new Error('Collective local transport requires a URL');
      const url=new URL(input);
      if (url.origin!==origin || url.username || url.password || url.hash) throw new Error('Collective local origin mismatch');
      try {
        const result=await fetch(url,init);
        assertActive();
        return result;
      } catch {throw new ConnectorTransportError('Local operation outcome is unknown',undefined,'COLLECTIVE_SERVICE_UNAVAILABLE',{code:'COLLECTIVE_SERVICE_UNAVAILABLE',effect:'unknown',automaticRetry:false});}
    },
  };
}
