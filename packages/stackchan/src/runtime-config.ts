import { readFile, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

import type { CatCafeLimbCapability } from './cat-cafe-client.js';
import type {
  StackChanGatewayFace,
  StackChanVoiceProfile,
} from './action-executor.js';
import { readSecretFile } from './secret-file.js';

const MAX_CONFIG_BYTES = 64 * 1_024;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/u;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
const CONFIG_KEYS = [
  'v',
  'nodeId',
  'displayName',
  'catCafeBaseUrl',
  'limbHost',
  'limbPort',
  'gatewayMcpUrl',
  'gatewayTokenPath',
  'eventJsonlPath',
  'cursorPath',
  'apiKeyPath',
  'listen',
  'safePose',
  'expressionFaces',
  'voiceProfiles',
  'cycleIntervalMs',
] as const;
const FACE_VALUES = new Set<StackChanGatewayFace>([
  'idle',
  'happy',
  'thinking',
  'sad',
  'surprised',
  'embarrassed',
]);

export interface StackChanAdapterListenConfig {
  readonly durationMs: number;
  readonly engine: string;
  readonly language: string;
  readonly lookUpPitch: number;
  readonly debounceMs: number;
}

export interface StackChanAdapterConfig {
  readonly nodeId: string;
  readonly displayName: string;
  readonly catCafeBaseUrl: string;
  readonly limbHost: '127.0.0.1' | '::1';
  readonly limbPort: number;
  readonly limbEndpointUrl: string;
  readonly gatewayMcpUrl: string;
  readonly gatewayToken: string;
  readonly eventJsonlPath: string;
  readonly cursorPath: string;
  readonly apiKeyPath: string;
  readonly listen: StackChanAdapterListenConfig;
  readonly safePose: {
    readonly yawDeg: number;
    readonly pitchDeg: number;
    readonly timeoutMs: number;
  };
  readonly expressionFaces: Readonly<Record<string, StackChanGatewayFace>>;
  readonly voiceProfiles: Readonly<Record<string, StackChanVoiceProfile>>;
  readonly cycleIntervalMs: number;
  readonly capabilities: readonly CatCafeLimbCapability[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  return (
    actual.length === sorted.length &&
    actual.every((key, index) => key === sorted[index])
  );
}

function requireIdentifier(name: string, value: unknown): string {
  if (typeof value !== 'string' || !IDENTIFIER_PATTERN.test(value)) {
    throw new TypeError(`${name} must be a bounded identifier`);
  }
  return value;
}

function requireAbsolutePath(name: string, value: unknown): string {
  if (typeof value !== 'string' || !isAbsolute(value)) {
    throw new TypeError(`${name} must be an absolute path`);
  }
  return value;
}

function requireLoopbackUrl(name: string, value: unknown, path?: string): string {
  if (typeof value !== 'string') {
    throw new TypeError(`${name} must be a loopback URL`);
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError(`${name} must be a loopback URL`);
  }
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    !LOOPBACK_HOSTS.has(url.hostname) ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.search.length > 0 ||
    url.hash.length > 0 ||
    (path === undefined
      ? url.pathname !== '/' && url.pathname !== ''
      : url.pathname !== path)
  ) {
    throw new TypeError(`${name} must be a loopback URL`);
  }
  return url.toString().replace(/\/$/u, '');
}

function parseListen(value: unknown): StackChanAdapterListenConfig {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'durationMs',
      'engine',
      'language',
      'lookUpPitch',
      'debounceMs',
    ]) ||
    !Number.isSafeInteger(value.durationMs) ||
    (value.durationMs as number) < 100 ||
    (value.durationMs as number) > 30_000 ||
    typeof value.engine !== 'string' ||
    value.engine.length === 0 ||
    value.engine.length > 128 ||
    typeof value.language !== 'string' ||
    value.language.length === 0 ||
    value.language.length > 32 ||
    typeof value.lookUpPitch !== 'number' ||
    !Number.isFinite(value.lookUpPitch) ||
    value.lookUpPitch < 5 ||
    value.lookUpPitch > 85 ||
    !Number.isSafeInteger(value.debounceMs) ||
    (value.debounceMs as number) < 0 ||
    (value.debounceMs as number) > 10_000
  ) {
    throw new TypeError('Invalid StackChan listen configuration');
  }
  return value as unknown as StackChanAdapterListenConfig;
}

function parseSafePose(value: unknown): StackChanAdapterConfig['safePose'] {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['yawDeg', 'pitchDeg', 'timeoutMs']) ||
    typeof value.yawDeg !== 'number' ||
    !Number.isFinite(value.yawDeg) ||
    value.yawDeg < -90 ||
    value.yawDeg > 90 ||
    typeof value.pitchDeg !== 'number' ||
    !Number.isFinite(value.pitchDeg) ||
    value.pitchDeg < 5 ||
    value.pitchDeg > 85 ||
    !Number.isSafeInteger(value.timeoutMs) ||
    (value.timeoutMs as number) < 100 ||
    (value.timeoutMs as number) > 30_000
  ) {
    throw new TypeError('Invalid StackChan safe pose');
  }
  return value as unknown as StackChanAdapterConfig['safePose'];
}

function parseExpressionFaces(
  value: unknown,
): Readonly<Record<string, StackChanGatewayFace>> {
  if (!isRecord(value) || Object.keys(value).length === 0) {
    throw new TypeError('expressionFaces must be a non-empty object');
  }
  const parsed: Record<string, StackChanGatewayFace> = {};
  for (const [key, face] of Object.entries(value)) {
    requireIdentifier('expression face key', key);
    if (typeof face !== 'string' || !FACE_VALUES.has(face as StackChanGatewayFace)) {
      throw new TypeError('Invalid StackChan expression face');
    }
    parsed[key] = face as StackChanGatewayFace;
  }
  return Object.freeze(parsed);
}

function parseVoiceProfiles(
  value: unknown,
): Readonly<Record<string, StackChanVoiceProfile>> {
  if (!isRecord(value) || Object.keys(value).length === 0) {
    throw new TypeError('voiceProfiles must be a non-empty object');
  }
  const parsed: Record<string, StackChanVoiceProfile> = {};
  for (const [key, profile] of Object.entries(value)) {
    requireIdentifier('voice profile key', key);
    if (
      !isRecord(profile) ||
      !Object.keys(profile).every((field) =>
        ['voice', 'speakerId', 'speakerName'].includes(field),
      ) ||
      !Object.keys(profile).includes('voice') ||
      typeof profile.voice !== 'string' ||
      profile.voice.length === 0 ||
      profile.voice.length > 128 ||
      (profile.speakerId !== undefined &&
        (!Number.isSafeInteger(profile.speakerId) ||
          (profile.speakerId as number) < 0)) ||
      (profile.speakerName !== undefined &&
        (typeof profile.speakerName !== 'string' ||
          profile.speakerName.length === 0 ||
          profile.speakerName.length > 128))
    ) {
      throw new TypeError('Invalid StackChan voice profile');
    }
    parsed[key] = {
      voice: profile.voice,
      ...(profile.speakerId === undefined
        ? {}
        : { speakerId: profile.speakerId as number }),
      ...(profile.speakerName === undefined
        ? {}
        : { speakerName: profile.speakerName as string }),
    };
  }
  return Object.freeze(parsed);
}

const CAPABILITIES: readonly CatCafeLimbCapability[] = Object.freeze([
  { cap: 'limb.action.motion', commands: ['physical_limb.execute'], authLevel: 'leased' },
  { cap: 'limb.action.display', commands: ['physical_limb.execute'], authLevel: 'leased' },
  { cap: 'limb.action.light', commands: ['physical_limb.execute'], authLevel: 'leased' },
  { cap: 'limb.action.speaker', commands: ['physical_limb.execute'], authLevel: 'leased' },
  { cap: 'limb.observe.touch', commands: [], authLevel: 'free' },
  { cap: 'limb.sensor.microphone', commands: [], authLevel: 'gated' },
]);

export async function loadStackChanAdapterConfig(
  path: string,
): Promise<StackChanAdapterConfig> {
  if (!isAbsolute(path)) {
    throw new TypeError('StackChan adapter config path must be absolute');
  }
  const metadata = await stat(path);
  if (!metadata.isFile() || metadata.size > MAX_CONFIG_BYTES) {
    throw new Error('StackChan adapter config must be a bounded regular file');
  }
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch {
    throw new TypeError('StackChan adapter config must contain valid JSON');
  }
  if (!isRecord(raw) || !hasExactKeys(raw, CONFIG_KEYS)) {
    throw new TypeError('StackChan adapter config has unknown or missing fields');
  }
  if (raw.v !== 1) {
    throw new TypeError('Unsupported StackChan adapter config version');
  }

  const nodeId = requireIdentifier('nodeId', raw.nodeId);
  if (
    typeof raw.displayName !== 'string' ||
    raw.displayName.length === 0 ||
    raw.displayName.length > 128
  ) {
    throw new TypeError('displayName must be bounded');
  }
  const limbHost = raw.limbHost;
  if (limbHost !== '127.0.0.1' && limbHost !== '::1') {
    throw new TypeError('limbHost must be loopback');
  }
  if (
    !Number.isSafeInteger(raw.limbPort) ||
    (raw.limbPort as number) < 1 ||
    (raw.limbPort as number) > 65_535
  ) {
    throw new TypeError('limbPort must be a valid fixed port');
  }
  const gatewayTokenPath = requireAbsolutePath(
    'gatewayTokenPath',
    raw.gatewayTokenPath,
  );
  const gatewayToken = await readSecretFile(gatewayTokenPath, { required: true });
  if (gatewayToken === undefined || gatewayToken.length < 16) {
    throw new TypeError('Gateway token must contain at least 16 characters');
  }
  if (
    !Number.isSafeInteger(raw.cycleIntervalMs) ||
    (raw.cycleIntervalMs as number) < 100 ||
    (raw.cycleIntervalMs as number) > 60_000
  ) {
    throw new TypeError('Invalid adapter cycle interval');
  }

  const port = raw.limbPort as number;
  const bracketedHost = limbHost === '::1' ? '[::1]' : limbHost;
  return {
    nodeId,
    displayName: raw.displayName,
    catCafeBaseUrl: requireLoopbackUrl(
      'catCafeBaseUrl',
      raw.catCafeBaseUrl,
    ),
    limbHost,
    limbPort: port,
    limbEndpointUrl: `http://${bracketedHost}:${port}`,
    gatewayMcpUrl: requireLoopbackUrl(
      'gatewayMcpUrl',
      raw.gatewayMcpUrl,
      '/mcp',
    ),
    gatewayToken,
    eventJsonlPath: requireAbsolutePath('eventJsonlPath', raw.eventJsonlPath),
    cursorPath: requireAbsolutePath('cursorPath', raw.cursorPath),
    apiKeyPath: requireAbsolutePath('apiKeyPath', raw.apiKeyPath),
    listen: parseListen(raw.listen),
    safePose: parseSafePose(raw.safePose),
    expressionFaces: parseExpressionFaces(raw.expressionFaces),
    voiceProfiles: parseVoiceProfiles(raw.voiceProfiles),
    cycleIntervalMs: raw.cycleIntervalMs as number,
    capabilities: CAPABILITIES,
  };
}
