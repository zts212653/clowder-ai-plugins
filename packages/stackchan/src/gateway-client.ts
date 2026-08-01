import type {
  StackChanGatewayClient,
  StackChanListenRequest,
  StackChanListenResult,
} from './touch-reply-controller.js';

const MAX_TRANSCRIPT_CODE_POINTS = 4_096;
const MAX_TOOL_TEXT_BYTES = 64 * 1_024;

export interface StackChanMcpToolCaller {
  callTool(
    name: string,
    input: Readonly<Record<string, unknown>>,
    options?: { readonly signal?: AbortSignal },
  ): Promise<unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseListenResponse(
  raw: unknown,
  request: StackChanListenRequest,
): StackChanListenResult {
  if (!isRecord(raw) || !Array.isArray(raw.content) || raw.content.length !== 1) {
    throw new Error('stackchan-mcp listen returned an invalid content envelope');
  }

  const block = raw.content[0];
  if (
    !isRecord(block) ||
    block.type !== 'text' ||
    typeof block.text !== 'string' ||
    Buffer.byteLength(block.text, 'utf8') > MAX_TOOL_TEXT_BYTES
  ) {
    throw new Error('stackchan-mcp listen returned non-text or oversized content');
  }

  let payload: unknown;
  try {
    payload = JSON.parse(block.text);
  } catch {
    throw new Error('stackchan-mcp listen returned malformed JSON');
  }
  if (!isRecord(payload)) {
    throw new Error('stackchan-mcp listen returned a non-object result');
  }
  if (typeof payload.error === 'string' && payload.error.length > 0) {
    throw new Error(payload.error);
  }

  const text = payload.text;
  const language = payload.language;
  const capturedAudioDurationMs = payload.duration_ms;
  if (
    typeof text !== 'string' ||
    Array.from(text).length > MAX_TRANSCRIPT_CODE_POINTS ||
    (language !== undefined &&
      (typeof language !== 'string' || language.length > 32)) ||
    !Number.isSafeInteger(capturedAudioDurationMs) ||
    (capturedAudioDurationMs as number) < 0 ||
    (capturedAudioDurationMs as number) > 30_000
  ) {
    throw new Error('stackchan-mcp listen returned invalid transcript metadata');
  }

  return {
    text,
    ...(typeof language === 'string' && language.length > 0 ? { language } : {}),
    // The gateway field counts received Opus frames. The contract field is the
    // explicit capture window, which remains the requested duration even when
    // silence or packet loss produces zero frames.
    durationMs: request.durationMs,
  };
}

export function createStackChanGatewayClient(
  caller: StackChanMcpToolCaller,
): StackChanGatewayClient {
  return {
    async listen(request): Promise<StackChanListenResult> {
      if (
        !Number.isSafeInteger(request.durationMs) ||
        request.durationMs < 100 ||
        request.durationMs > 30_000 ||
        request.motion !== 'look-up' ||
        typeof request.lookUpPitch !== 'number' ||
        !Number.isFinite(request.lookUpPitch) ||
        request.lookUpPitch < 5 ||
        request.lookUpPitch > 85 ||
        typeof request.engine !== 'string' ||
        request.engine.length === 0 ||
        typeof request.language !== 'string' ||
        request.language.length === 0 ||
        request.language.length > 32
      ) {
        throw new TypeError('Invalid bounded StackChan listen request');
      }

      const result = await caller.callTool('listen', {
        duration_ms: request.durationMs,
        engine: request.engine,
        language: request.language,
        motion: request.motion,
        look_up_pitch: request.lookUpPitch,
      });
      return parseListenResponse(result, request);
    },
  };
}
