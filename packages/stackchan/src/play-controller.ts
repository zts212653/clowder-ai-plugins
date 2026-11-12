import { setTimeout as delay } from 'node:timers/promises';

import type { StackChanVoiceProfile } from './action-executor.js';
import type { StackChanMcpToolCaller } from './gateway-client.js';
import type { PhysicalLimbSafePose } from '@clowder-ai/plugin-contract';

export type StackChanPlayScene = 'bicker' | 'dance' | 'stop';
export interface StackChanPlayResult {
  readonly scene: StackChanPlayScene;
  readonly outcome: 'completed' | 'stopped';
}

export function parseStackChanPlayScene(raw: unknown): StackChanPlayScene {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new TypeError('Expected one named scene: bicker, dance, or stop');
  }
  const value = raw as Record<string, unknown>;
  if (Object.keys(value).length !== 1 || typeof value.scene !== 'string' || !['bicker', 'dance', 'stop'].includes(value.scene)) {
    throw new TypeError('Expected one named scene: bicker, dance, or stop');
  }
  return value.scene as StackChanPlayScene;
}

function payload(result: unknown): Record<string, unknown> | undefined {
  if (typeof result !== 'object' || result === null) return undefined;
  const raw = result as Record<string, unknown>;
  if (raw.isError === true) throw new Error('StackChan gateway reported an error');
  if (!Array.isArray(raw.content)) return undefined;
  let parsed: Record<string, unknown> | undefined;
  for (const block of raw.content) {
    if (typeof block !== 'object' || block === null) continue;
    if (block.type !== 'text' || typeof block.text !== 'string') continue;
    let value: unknown;
    try { value = JSON.parse(block.text); } catch { continue; }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) continue;
    const data = value as Record<string, unknown>;
    if (data.error || data.ok === false) {
      throw new Error(typeof data.error === 'string' ? data.error : 'StackChan action failed');
    }
    parsed ??= data;
  }
  return parsed;
}

/** Gateway transport connectivity is not robot connectivity. */
export async function readStackChanDeviceHealth(caller: StackChanMcpToolCaller, signal?: AbortSignal): Promise<'online' | 'offline' | 'degraded'> {
  signal?.throwIfAborted();
  try {
    const status = payload(await caller.callTool('get_status', {}, { signal }));
    signal?.throwIfAborted();
    if (status?.connected === false) return 'offline';
    return status?.connected === true && typeof status.tools_count === 'number' && status.tools_count > 0
      ? 'online' : 'degraded';
  } catch {
    signal?.throwIfAborted();
    return 'degraded';
  }
}

const LINES = [
  { profile: 'xianxian:local', face: 'embarrassed', yaw: -18, color: [5, 10, 28], text: '宪宪：这个身体归我！' },
  { profile: 'shuosh:local', face: 'surprised', yaw: 18, color: [4, 24, 24], text: '烁烁：让开，我来开！' },
  { profile: 'yanyan:local', face: 'happy', yaw: 0, color: [28, 15, 3], text: '砚砚：别挤，先摸我。' },
] as const;

class PlayCleanupError extends AggregateError {}

export interface StackChanPlayController {
  run(scene: StackChanPlayScene): Promise<StackChanPlayResult>;
  stop(): Promise<void>;
  isActive(): boolean;
}

export function createStackChanPlayController(options: {
  readonly caller: StackChanMcpToolCaller;
  readonly safePose: PhysicalLimbSafePose;
  readonly voiceProfiles: Readonly<Record<string, StackChanVoiceProfile>>;
  readonly canPlay: () => boolean;
  readonly wait?: (ms: number, signal: AbortSignal) => Promise<void>;
}): StackChanPlayController {
  let active: { controller: AbortController; done: Promise<StackChanPlayResult> } | undefined;
  const wait = options.wait ?? ((ms, signal) => delay(ms, undefined, { signal }));
  const call = async (name: string, args: Readonly<Record<string, unknown>>, signal?: AbortSignal): Promise<void> => {
    signal?.throwIfAborted();
    payload(await options.caller.callTool(name, args, { signal }));
    signal?.throwIfAborted();
  };

  async function perform(scene: 'bicker' | 'dance', signal: AbortSignal): Promise<StackChanPlayResult> {
    let danceStarted = false;
    let outputStarted = false;
    let completed = false;
    try {
      if (scene === 'bicker') {
        for (const line of LINES) {
          if (!options.voiceProfiles[line.profile]) throw new Error(`缺少短剧声线配置：${line.profile}`);
        }
      }
      if (await readStackChanDeviceHealth(options.caller, signal) !== 'online') {
        throw new Error('机器人尚未连接网关；接通后再玩。');
      }
      signal.throwIfAborted();
      if (scene === 'dance') {
        // Mark ownership before dispatch: cancellation may race with the acknowledgement.
        danceStarted = true;
        outputStarted = true;
        await call('beat_mode_start', { motion_intensity: 0.3, sensitivity: 0.5, color: [8, 24, 24], duration_sec: 20 }, signal);
        await wait(20_000, signal);
      } else {
        outputStarted = true;
        await call('set_volume', { volume: 35 }, signal);
        for (const line of LINES) {
          const profile = options.voiceProfiles[line.profile];
          await call('set_avatar', { face: line.face }, signal);
          await call('set_leds', { colors: Array.from({ length: 12 }, () => [...line.color]) }, signal);
          await call('move_head', { yaw: line.yaw, pitch: 55, speed: 'mid' }, signal);
          await call('say', {
            text: line.text, voice: profile.voice,
            ...(profile.speakerId === undefined ? {} : { speaker_id: profile.speakerId }),
            ...(profile.speakerName === undefined ? {} : { speaker_name: profile.speakerName }),
          }, signal);
          await wait(700, signal);
        }
      }
      completed = true;
      return { scene, outcome: 'completed' };
    } catch (error) {
      if (signal.aborted && signal.reason instanceof Error && signal.reason.name === 'AbortError') {
        return { scene, outcome: 'stopped' };
      }
      throw error;
    } finally {
      // Cleanup uses its own bounded calls rather than the canceled scene signal.
      const cleanup: Array<() => Promise<void>> = [];
      if (danceStarted) cleanup.push(() => call('beat_mode_stop', {}));
      if (outputStarted && !completed) {
        cleanup.push(
          () => call('move_head', { yaw: options.safePose.yawDeg, pitch: options.safePose.pitchDeg, speed: 'low' }),
          () => call('clear_leds', {}),
        );
      }
      const failures: unknown[] = [];
      for (const action of cleanup) {
        try { await action(); } catch (error) { failures.push(error); }
      }
      if (failures.length > 0) throw new PlayCleanupError(failures, 'StackChan play cleanup failed');
    }
  }

  async function stop(): Promise<void> {
    const running = active;
    if (!running) return;
    running.controller.abort();
    try {
      await running.done;
    } catch (error) {
      // The initiating request owns a scene failure. Stop owns cleanup only.
      if (error instanceof PlayCleanupError) throw error;
    }
  }

  return {
    isActive: () => active !== undefined,
    stop,
    async run(scene) {
      if (scene === 'stop') {
        if (active) await stop();
        else {
          // Explicit owner stop can recover hardware even after a failed scene
          // has left the controller. Ordinary interruptions remain no-ops here.
          await call('beat_mode_stop', {});
          await call('move_head', { yaw: options.safePose.yawDeg, pitch: options.safePose.pitchDeg, speed: 'low' });
          await call('clear_leds', {});
        }
        return { scene, outcome: 'stopped' };
      }
      if (active || !options.canPlay()) throw new Error('机器人正在互动；先停止当前动作再开新场。');
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(new Error('桌面互动超时')), 45_000);
      const done = perform(scene, controller.signal).finally(() => {
        clearTimeout(timer);
        active = undefined;
      });
      active = { controller, done };
      return done;
    },
  };
}
