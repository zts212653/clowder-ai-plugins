import type {
  PhysicalLimbAction,
  PhysicalLimbActionResult,
  PhysicalLimbCancel,
  PhysicalLimbSafePose,
} from '@clowder-ai/plugin-contract';

import type { StackChanMcpToolCaller } from './gateway-client.js';

export type StackChanGatewayFace =
  | 'idle'
  | 'happy'
  | 'thinking'
  | 'sad'
  | 'surprised'
  | 'embarrassed';

export interface StackChanVoiceProfile {
  readonly voice: string;
  readonly speakerId?: number;
  readonly speakerName?: string;
}

export interface StackChanActionExecutorOptions {
  readonly nodeId: string;
  readonly caller: StackChanMcpToolCaller;
  readonly safePose: PhysicalLimbSafePose;
  readonly expressionFaces: Readonly<Record<string, StackChanGatewayFace>>;
  readonly voiceProfiles: Readonly<Record<string, StackChanVoiceProfile>>;
  readonly now?: () => number;
}

export interface StackChanActionExecutor {
  execute(
    instruction: PhysicalLimbAction | PhysicalLimbCancel,
  ): Promise<PhysicalLimbActionResult>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toolError(result: unknown): string | undefined {
  if (!isRecord(result)) {
    return undefined;
  }
  if (result.isError === true) {
    return 'stackchan-mcp reported a tool error';
  }
  if (!Array.isArray(result.content)) {
    return undefined;
  }

  for (const block of result.content) {
    if (!isRecord(block) || block.type !== 'text' || typeof block.text !== 'string') {
      continue;
    }
    try {
      const payload: unknown = JSON.parse(block.text);
      if (isRecord(payload)) {
        if (typeof payload.error === 'string' && payload.error.length > 0) {
          return payload.error;
        }
        if (payload.ok === false) {
          return typeof payload.message === 'string'
            ? payload.message
            : 'stackchan-mcp reported ok=false';
        }
      }
    } catch {
      // Some gateway tools return plain text. Transport success is sufficient.
    }
  }
  return undefined;
}

function reasonFrom(error: unknown): string {
  return error instanceof Error && error.message.length > 0
    ? error.message
    : 'StackChan action failed';
}

function validateOptions(options: StackChanActionExecutorOptions): void {
  const { yawDeg, pitchDeg, timeoutMs } = options.safePose;
  if (
    options.nodeId.length === 0 ||
    !Number.isFinite(yawDeg) ||
    yawDeg < -90 ||
    yawDeg > 90 ||
    !Number.isFinite(pitchDeg) ||
    pitchDeg < 5 ||
    pitchDeg > 85 ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 100 ||
    timeoutMs > 30_000
  ) {
    throw new TypeError('Invalid StackChan action executor configuration');
  }

  for (const profile of Object.values(options.voiceProfiles)) {
    if (
      profile.voice.length === 0 ||
      (profile.speakerId !== undefined && !Number.isSafeInteger(profile.speakerId)) ||
      (profile.speakerName !== undefined && profile.speakerName.length === 0)
    ) {
      throw new TypeError('Invalid StackChan voice profile');
    }
  }
}

export function createStackChanActionExecutor(
  options: StackChanActionExecutorOptions,
): StackChanActionExecutor {
  validateOptions(options);
  const now = options.now ?? Date.now;
  const inFlight = new Map<string, AbortController>();

  function result(
    actionId: string,
    outcome: PhysicalLimbActionResult['outcome'],
    reason?: string,
  ): PhysicalLimbActionResult {
    return {
      v: 1,
      actionId,
      nodeId: options.nodeId,
      outcome,
      ...(reason === undefined ? {} : { reason: reason.slice(0, 512) }),
      observedAt: new Date(now()).toISOString(),
    };
  }

  async function callTool(
    name: string,
    input: Readonly<Record<string, unknown>>,
    signal: AbortSignal,
  ): Promise<void> {
    const raw = await options.caller.callTool(name, input, { signal });
    const error = toolError(raw);
    if (error) {
      throw new Error(error);
    }
  }

  async function moveToSafePose(): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.safePose.timeoutMs);
    try {
      await callTool(
        'move_head',
        {
          yaw: Math.round(options.safePose.yawDeg),
          pitch: Math.round(options.safePose.pitchDeg),
          speed: 'low',
        },
        controller.signal,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async execute(
      instruction: PhysicalLimbAction | PhysicalLimbCancel,
    ): Promise<PhysicalLimbActionResult> {
      if (instruction.nodeId !== options.nodeId) {
        return result(instruction.actionId, 'refused', 'node mismatch');
      }

      if (!('kind' in instruction)) {
        inFlight.get(instruction.cancelToken)?.abort();
        try {
          await moveToSafePose();
          return result(instruction.actionId, 'canceled');
        } catch (error) {
          return result(instruction.actionId, 'failed', reasonFrom(error));
        }
      }

      const remainingMs = instruction.deadlineUnixMs - now();
      if (remainingMs <= 0) {
        return result(instruction.actionId, 'refused', 'action deadline expired');
      }
      if (inFlight.has(instruction.cancelToken)) {
        return result(instruction.actionId, 'refused', 'cancel token already active');
      }

      const controller = new AbortController();
      inFlight.set(instruction.cancelToken, controller);
      const timer = setTimeout(
        () => controller.abort(),
        Math.min(instruction.timeoutMs, remainingMs),
      );

      try {
        switch (instruction.kind) {
          case 'motion':
            await callTool(
              'move_head',
              {
                yaw: Math.round(instruction.payload.yawDeg),
                pitch: Math.round(instruction.payload.pitchDeg),
                speed: Math.round(instruction.payload.speedDps),
              },
              controller.signal,
            );
            break;

          case 'display': {
            const face = options.expressionFaces[instruction.payload.expression];
            if (!face) {
              return result(instruction.actionId, 'refused', 'expression is not approved');
            }
            await callTool('set_avatar', { face }, controller.signal);
            break;
          }

          case 'light':
            if (instruction.payload.colors.length > 12) {
              return result(instruction.actionId, 'refused', 'body supports at most 12 LEDs');
            }
            await callTool(
              'set_leds',
              { colors: instruction.payload.colors.map((color) => [...color]) },
              controller.signal,
            );
            break;

          case 'speaker': {
            const profile = options.voiceProfiles[instruction.payload.voiceProfileRef];
            if (!profile) {
              return result(instruction.actionId, 'refused', 'voice profile is not approved');
            }
            await callTool(
              'set_volume',
              { volume: instruction.payload.volumePercent },
              controller.signal,
            );
            await callTool(
              'say',
              {
                text: instruction.payload.text,
                voice: profile.voice,
                ...(profile.speakerId === undefined
                  ? {}
                  : { speaker_id: profile.speakerId }),
                ...(profile.speakerName === undefined
                  ? {}
                  : { speaker_name: profile.speakerName }),
              },
              controller.signal,
            );
            break;
          }
        }

        return controller.signal.aborted
          ? result(instruction.actionId, 'canceled', 'action canceled or timed out')
          : result(instruction.actionId, 'succeeded');
      } catch (error) {
        return controller.signal.aborted
          ? result(instruction.actionId, 'canceled', 'action canceled or timed out')
          : result(instruction.actionId, 'failed', reasonFrom(error));
      } finally {
        clearTimeout(timer);
        if (inFlight.get(instruction.cancelToken) === controller) {
          inFlight.delete(instruction.cancelToken);
        }
      }
    },
  };
}
