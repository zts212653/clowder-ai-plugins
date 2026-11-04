import { createStackChanActionExecutor, type StackChanActionExecutor } from './action-executor.js';
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
import { createFileStackChanObservationOutbox } from './observation-outbox.js';
import type { StackChanAdapterConfig } from './runtime-config.js';
import { readSecretFile, writeSecretFile } from './secret-file.js';
import { createStackChanTouchReplyController } from './touch-reply-controller.js';
import { createStackChanPlayController, readStackChanDeviceHealth } from './play-controller.js';

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
  const gateway = createStackChanGatewayClient(caller, config.safePose);
  const outbox = createFileStackChanObservationOutbox(
    `${config.cursorPath}.observations`,
  );
  const controller = createStackChanTouchReplyController({
    nodeId: config.nodeId,
    gateway,
    async beginInteraction(interactionId, touch): Promise<boolean> {
      return outbox.beginInteraction(interactionId, touch);
    },
    async emitObservation(observation): Promise<void> {
      await outbox.enqueue(observation);
    },
    listenDurationMs: config.listen.durationMs,
    listenEngine: config.listen.engine,
    language: config.listen.language,
    lookUpPitch: config.listen.lookUpPitch,
    debounceMs: config.listen.debounceMs,
    beforeInteraction: () => play.stop(),
  });
  let activeActions = 0;
  let shuttingDown = false;
  const play = createStackChanPlayController({
    caller,
    safePose: config.safePose,
    voiceProfiles: config.voiceProfiles,
    canPlay: () => !shuttingDown && !controller.isBusy() && activeActions === 0,
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
      await outbox
        .flush((observation) => client.emitObservation(observation))
        .catch((error: unknown) => {
          overrides.onError?.(
            error instanceof Error ? error : new Error(String(error)),
          );
        });
    },
  });
  const actionExecutor = createStackChanActionExecutor({
    nodeId: config.nodeId,
    caller,
    safePose: config.safePose,
    expressionFaces: config.expressionFaces,
    voiceProfiles: config.voiceProfiles,
  });
  const executor: StackChanActionExecutor = {
    async execute(instruction) {
      activeActions += 1;
      try {
        await play.stop();
        return await actionExecutor.execute(instruction);
      } finally {
        activeActions -= 1;
      }
    },
  };
  const runtime = createStackChanAdapterRuntime({
    client,
    eventSource,
    flushPending: () =>
      outbox.flush((observation) => client.emitObservation(observation)),
    cycleIntervalMs: config.cycleIntervalMs,
    onError: overrides.onError,
    createServer(apiKey) {
      return createStackChanRemoteLimbServer({
        nodeId: config.nodeId,
        apiKey,
        executor,
        host: config.limbHost,
        port: config.limbPort,
        health: async () => caller.status() === 'offline' ? 'offline' : readStackChanDeviceHealth(caller),
        play: (scene) => play.run(scene),
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
        shuttingDown = true;
        await startPromise?.catch(() => undefined);
        try {
          await play.stop();
        } finally {
          try {
            if (started) await runtime.stop();
          } finally {
            started = false;
            await caller.close();
          }
        }
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
