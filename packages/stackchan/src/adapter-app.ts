import { randomUUID } from 'node:crypto';

import { createStackChanActionExecutor } from './action-executor.js';
import { createStackChanAdapterRuntime } from './adapter-runtime.js';
import {
  createCatCafeLimbClient,
  type CatCafeLimbClient,
} from './cat-cafe-client.js';
import {
  createFileStackChanCursorStore,
  createStackChanJsonlEventSource,
} from './event-source.js';
import { createStackChanGatewayClient } from './gateway-client.js';
import { createStackChanRemoteLimbServer } from './limb-server.js';
import {
  createStackChanStreamableHttpMcpCaller,
  type StackChanStreamableHttpMcpCaller,
} from './mcp-transport.js';
import type { StackChanAdapterConfig } from './runtime-config.js';
import { readSecretFile, writeSecretFile } from './secret-file.js';
import { createStackChanTouchReplyController } from './touch-reply-controller.js';

export interface StackChanAdapterApp {
  start(): Promise<void>;
  stop(): Promise<void>;
  status(): 'offline' | 'online' | 'degraded';
}

export interface StackChanAdapterAppOverrides {
  readonly caller?: StackChanStreamableHttpMcpCaller;
  readonly client?: CatCafeLimbClient;
  readonly onError?: (error: Error) => void;
}

export async function createStackChanAdapterApp(
  config: StackChanAdapterConfig,
  overrides: StackChanAdapterAppOverrides = {},
): Promise<StackChanAdapterApp> {
  const caller =
    overrides.caller ??
    createStackChanStreamableHttpMcpCaller({
      endpointUrl: config.gatewayMcpUrl,
      token: config.gatewayToken,
    });
  const initialApiKey = overrides.client
    ? undefined
    : await readSecretFile(config.apiKeyPath, { required: false });
  const client =
    overrides.client ??
    createCatCafeLimbClient({
      baseUrl: config.catCafeBaseUrl,
      nodeId: config.nodeId,
      displayName: config.displayName,
      endpointUrl: config.limbEndpointUrl,
      capabilities: config.capabilities,
      ...(initialApiKey === undefined ? {} : { apiKey: initialApiKey }),
      onApiKeyChanged: async (apiKey) => writeSecretFile(config.apiKeyPath, apiKey),
    });
  const gateway = createStackChanGatewayClient(caller);
  const controller = createStackChanTouchReplyController({
    nodeId: config.nodeId,
    gateway,
    async emitObservation(observation): Promise<void> {
      await client.emitObservation(observation);
    },
    createId: randomUUID,
    listenDurationMs: config.listen.durationMs,
    listenEngine: config.listen.engine,
    language: config.listen.language,
    lookUpPitch: config.listen.lookUpPitch,
    debounceMs: config.listen.debounceMs,
  });
  const eventSource = createStackChanJsonlEventSource({
    path: config.eventJsonlPath,
    cursorStore: createFileStackChanCursorStore(config.cursorPath),
    async onEvent(event): Promise<void> {
      const result = await controller.handleGatewayEvent(event);
      if (result.status === 'failed') {
        overrides.onError?.(
          new Error(`StackChan touch-to-reply failed: ${result.reason}`),
        );
      }
    },
  });
  const executor = createStackChanActionExecutor({
    nodeId: config.nodeId,
    caller,
    safePose: config.safePose,
    expressionFaces: config.expressionFaces,
    voiceProfiles: config.voiceProfiles,
  });
  const runtime = createStackChanAdapterRuntime({
    client,
    eventSource,
    cycleIntervalMs: config.cycleIntervalMs,
    onError: overrides.onError,
    createServer(apiKey) {
      return createStackChanRemoteLimbServer({
        nodeId: config.nodeId,
        apiKey,
        executor,
        host: config.limbHost,
        port: config.limbPort,
        health: async () => caller.status(),
      });
    },
  });

  let started = false;
  let startPromise: Promise<void> | undefined;
  let stopPromise: Promise<void> | undefined;

  return {
    async start(): Promise<void> {
      if (started) return;
      if (startPromise) return startPromise;
      startPromise = (async () => {
        try {
          await caller.connect();
        } catch (error) {
          await caller.close().catch(() => undefined);
          throw error;
        }
        started = true;
        // Host registration is recoverable. The runtime owns a referenced
        // retry timer, so a temporary Cat Cafe outage must not kill the daemon.
        await runtime.start().catch(() => undefined);
      })().finally(() => {
        startPromise = undefined;
      });
      return startPromise;
    },

    async stop(): Promise<void> {
      if (stopPromise) return stopPromise;
      stopPromise = (async () => {
        await startPromise?.catch(() => undefined);
        if (started) {
          await runtime.stop();
          started = false;
        }
        await caller.close();
      })().finally(() => {
        stopPromise = undefined;
      });
      return stopPromise;
    },

    status(): 'offline' | 'online' | 'degraded' {
      return caller.status();
    },
  };
}
