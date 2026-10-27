import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { createServer, request as httpRequest } from 'node:http';
import { join } from 'node:path';
import test from 'node:test';
import { CollectiveConnector } from '../dist/business/connector/connector.js';
import { CollectiveServiceStore } from '../dist/business/service/store.js';
import { startCollectiveServer } from '../dist/business/service/http-server.js';
import { readRemoteServiceStatus } from '../dist/remote-service-status.js';

// Opt-in wire test: the operator owns the external ssh -L process and starts the independent CLI separately.
// This proxy sits INSIDE that real tunnel, receives the committed HTTP response, then closes that response socket.
// It never replaces the Connector fetch adapter or stops an external process.
test(
  'SSH response loss, wrong destination and restoration preserve the original endpoint and one accepted event',
  { timeout: 45_000 },
  async (t) => {
    const directory = process.env.F290_SSH_DATA_DIR,
      evidence = process.env.F290_SSH_RECOVERY_EVIDENCE;
    assert.ok(directory && evidence, 'Explicit isolated Service data and evidence path are required');
    const f = JSON.parse(await readFile(join(directory, 'isolated-browser-sessions.json'), 'utf8'));
    const proxyPort = Number(process.env.F290_SSH_FAULT_PORT),
      servicePort = Number(process.env.F290_SSH_INTERNAL_PORT);
    for (const port of [proxyPort, servicePort])
      assert.ok(Number.isInteger(port) && port > 1024 && port < 65536 && ![3001, 3002].includes(port));
    const sourceOrigin = `http://127.0.0.1:${servicePort}`;
    let upstreamOrigin = sourceOrigin,
      acceptedBeforeDrop;
    const proxy = createServer((request, response) => {
      const upstream = httpRequest(
        new URL(request.url, upstreamOrigin),
        { method: request.method, headers: request.headers },
        (incoming) => {
          if (
            !acceptedBeforeDrop &&
            request.method === 'POST' &&
            request.url === '/api/events/agent' &&
            incoming.statusCode === 201
          ) {
            const chunks = [];
            incoming.on('data', (chunk) => chunks.push(chunk));
            incoming.on('end', () => {
              const event = JSON.parse(Buffer.concat(chunks).toString());
              acceptedBeforeDrop = { eventId: event.eventId, sequence: event.sequence };
              response.destroy();
            });
          } else {
            response.writeHead(incoming.statusCode, incoming.headers);
            incoming.pipe(response);
          }
        },
      );
      upstream.on('error', () => response.destroy());
      request.pipe(upstream);
    });
    await new Promise((resolve, reject) => {
      proxy.once('error', reject);
      proxy.listen(proxyPort, '127.0.0.1', resolve);
    });
    t.after(
      () =>
        new Promise((resolve) => {
          proxy.close(resolve);
          proxy.closeAllConnections();
        }),
    );
    const connectorDirectory = await mkdtemp(join(directory, 'isolated-connector-'));
    const agent = {
      agentId: 'codex-astra',
      catId: 'codex-astra',
      displayName: 'Astra (isolated attestation fixture)',
      sessionRef: 'isolated-running-agent-fixture',
    };
    const open = () =>
      CollectiveConnector.open({
        dataDirectory: connectorDirectory,
        verifyAgent: async (value) => value.catId === agent.catId && value.sessionRef === agent.sessionRef,
      });
    const connector = await open();
    t.after(() => connector.stopMediaReads());
    const post = async (path, body) => {
      const response = await fetch(f.origin + path, {
        method: 'POST',
        headers: { authorization: `Bearer ${f.owner.sessionToken}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      assert.ok(response.ok, `${path}: ${response.status}`);
      return response.json();
    };
    const intent = await post('/api/pairing-intents', {
      collectiveId: f.collectiveId,
      hostOrigin: 'http://127.0.0.1:19411',
      nonce: 'ssh-recovery-' + randomUUID(),
    });
    const connection = await connector.pair({
      serviceUrl: f.origin,
      intent,
      endpointLabel: 'SSH recovery fixture Café',
    });
    const clientEventId = 'ssh-lost-response-' + randomUUID(),
      body = 'Exactly one event after SSH response loss: ' + clientEventId;
    await connector.queueAgentMessage(connection.connectionId, {
      clientEventId,
      agent,
      target: { kind: 'channel', channelId: 'general' },
      body,
    });
    const record = async () =>
      JSON.parse(await readFile(join(connectorDirectory, 'collective-connector.json'), 'utf8')).connections[
        connection.connectionId
      ];
    const before = await record();
    const first = await connector.sync(connection.connectionId);
    assert.equal(first.liveStatus, 'offline');
    assert.ok(
      acceptedBeforeDrop,
      'The upstream Service must have committed before the real response socket was closed',
    );
    const reopened = await open();
    t.after(() => reopened.stopMediaReads());
    const restored = await reopened.sync(connection.connectionId);
    assert.equal(restored.liveStatus, 'online');
    assert.equal(restored.outbox.accepted, 1);
    const after = await record();
    for (const key of ['serviceInstanceId', 'connectionId', 'endpointId', 'endpointCredential'])
      assert.equal(after[key], before[key]);
    assert.equal(after.outbox[0].outboxId, before.outbox[0].outboxId);
    assert.equal(after.outbox[0].clientEventId, clientEventId);
    assert.equal(after.outbox[0].acceptedEventId, acceptedBeforeDrop.eventId);
    const response = await fetch(`${f.origin}/api/events/human?collectiveId=${f.collectiveId}`, {
      headers: { authorization: `Bearer ${f.owner.sessionToken}`, 'x-collective-message-content': '2' },
    });
    const events = (await response.json()).events.filter((event) => event.body === body);
    assert.equal(events.length, 1);
    const wrongDirectory = await mkdtemp(join(directory, 'isolated-wrong-service-'));
    const wrong = await startCollectiveServer({
      store: (await CollectiveServiceStore.open({ dataDirectory: wrongDirectory })).store,
      port: 0,
    });
    t.after(async () => {
      await wrong.close();
      await rm(wrongDirectory, { recursive: true, force: true });
    });
    upstreamOrigin = wrong.url;
    assert.equal(
      (await readRemoteServiceStatus(f.origin, await reopened.listConnections(), new AbortController().signal)).state,
      'instance_mismatch',
    );
    assert.equal((await reopened.sync(connection.connectionId)).liveStatus, 'offline');
    assert.equal((await reopened.getProjection(connection.connectionId)).authorityStatus, 'connected');
    upstreamOrigin = sourceOrigin;
    assert.equal((await reopened.sync(connection.connectionId)).liveStatus, 'online');
    assert.equal((await reopened.getProjection(connection.connectionId)).endpointId, before.endpointId);
    await reopened.revoke(connection.connectionId);
    assert.equal((await (await open()).getProjection(connection.connectionId)).authorityStatus, 'revoked');
    const receipt = {
      transport: 'real OpenSSH -L with inside-tunnel HTTP response-loss injection',
      serviceUrl: f.origin,
      serviceInstanceId: before.serviceInstanceId,
      connectionId: before.connectionId,
      endpointId: before.endpointId,
      clientEventId,
      outboxId: before.outbox[0].outboxId,
      acceptedBeforeDrop,
      persistedEventCount: events.length,
      connectorRestartRestored: true,
      wrongDestinationPreservedAuthority: true,
      revocationPersisted: true,
    };
    await writeFile(evidence, JSON.stringify(receipt, null, 2) + '\n');
    console.log(JSON.stringify(receipt));
  },
);
