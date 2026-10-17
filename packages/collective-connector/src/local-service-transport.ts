import { validateBrowserServiceRequest, validateBrowserServiceDispatchResult } from '@clowder-ai/plugin-contract';
import type { BrowserServiceBinding, BrowserServiceHost, BrowserServiceMethod } from '@clowder-ai/plugin-sdk';
import { ConnectorTransportError, type CollectiveLocalTransport } from './business/connector/service-client.js';
import type { CollectiveServiceStore } from './business/service/store.js';
/** Exact bound origin takes the local port. A local refusal never invokes fetch. */
export function createLocalServiceTransport(host: BrowserServiceHost, binding: BrowserServiceBinding, store: CollectiveServiceStore): CollectiveLocalTransport {
  const assertCurrent = () => binding.assertCurrent();
  return {
    matches: serviceUrl => new URL(serviceUrl).origin === binding.origin,
    assertCurrent,
    async readRecovery(connection, clientEventId) {
      await assertCurrent();
      if (!connection.endpointCredential || !connection.authorizedHumanId) throw new Error('Recovery authority is unavailable');
      const snapshot = store.readLocalRecoverySnapshot(connection.endpointCredential, {
        serviceInstanceId: connection.serviceInstanceId, collectiveId: connection.collectiveId, connectionId: connection.connectionId,
        endpointId: connection.endpointId, authorizedHumanId: connection.authorizedHumanId,
      }, clientEventId);
      await assertCurrent(); return snapshot;
    },
    async fetch(input, init) {
      if (!(typeof input === 'string' || input instanceof URL)) throw new Error('Collective local transport requires a URL');
      const url = new URL(input);
      if (url.origin !== binding.origin || url.username || url.password || url.hash) throw new Error('Collective local origin mismatch');
      if (init?.body !== undefined && typeof init.body !== 'string') throw new Error('Collective local transport requires buffered JSON');
      const headers = [...new Headers(init?.headers).entries()].map(([name, value]) => ({ name, value }));
      const request = { version: 1 as const, method: (init?.method ?? 'GET') as BrowserServiceMethod, path: url.pathname,
        rawQuery: url.search.slice(1), headers, rawBodyBase64: Buffer.from(init?.body ?? '').toString('base64') };
      if (!validateBrowserServiceRequest(request)) throw new ConnectorTransportError('Invalid local request', 400, 'BROWSER_SERVICE_INVALID_REQUEST',
        { code: 'BROWSER_SERVICE_INVALID_REQUEST', effect: 'not_started', automaticRetry: false });
      try { await assertCurrent(); } catch {
        throw new ConnectorTransportError('Local binding is unavailable before dispatch', undefined, 'BROWSER_SERVICE_REVOKED',
          { code: 'BROWSER_SERVICE_REVOKED', effect: 'not_started', automaticRetry: false });
      }
      let outcome;
      try { outcome = await host.dispatchLocal(binding.contributionId, request, { ...(init?.signal ? { signal: init.signal } : {}) }); }
      catch {
        throw new ConnectorTransportError('Local dispatch did not settle', undefined, 'BROWSER_SERVICE_UNAVAILABLE',
          { code: 'BROWSER_SERVICE_UNAVAILABLE', effect: 'unknown', automaticRetry: false });
      }
      if (!validateBrowserServiceDispatchResult(outcome)) throw new ConnectorTransportError('Invalid local dispatch result', 502, 'BROWSER_SERVICE_INVALID_RESPONSE',
        { code: 'BROWSER_SERVICE_INVALID_RESPONSE', effect: 'unknown', automaticRetry: false });
      if (outcome.kind === 'transport-error') throw new ConnectorTransportError('Local operation result needs verification', undefined, outcome.code, outcome);
      try { await assertCurrent(); } catch {
        throw new ConnectorTransportError('Local result outlived its binding', undefined, 'BROWSER_SERVICE_REVOKED',
          { code: 'BROWSER_SERVICE_REVOKED', effect: 'unknown', automaticRetry: false });
      }
      const result = outcome.response; const responseHeaders = new Headers();
      for (const row of result.headers) responseHeaders.append(row.name, row.value);
      return new Response([204, 304].includes(result.status) ? null : Buffer.from(result.bodyBase64, 'base64'), { status: result.status, headers: responseHeaders });
    },
  };
}
