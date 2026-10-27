import type { ModulePluginSettingsHost } from '@clowder-ai/plugin-sdk';

/** The documented module ABI; no ambient Host identity or filesystem target is accepted as input. */
export type MusicHost = ModulePluginSettingsHost;
export interface OwnerCall {
  readonly signal?: AbortSignal;
  assertCurrent(): void | Promise<void>;
}
export interface MusicActionCall extends OwnerCall {
  /** Supplied only by the Host's admitted output dispatcher. Not a tool parameter. */
  readonly outputOperation?: { readonly id: string };
}
export interface GoogleCredentials {
  readonly type: 'authorized_user';
  readonly client_id: string;
  readonly client_secret: string;
  readonly refresh_token: string;
  readonly quota_project_id: string;
}
export interface MusicInput {
  readonly prompt: string;
  readonly model: 'lyria-3-clip-preview' | 'lyria-3-pro-preview';
  readonly instrumental: boolean;
  readonly durationSeconds?: number;
  readonly bpm?: number;
}
export interface ConnectionCheck {
  readonly projectId: string;
  readonly billingEnabled: boolean;
  readonly vertexEnabled: boolean;
}
export interface GeneratedMusic {
  readonly bytes: Uint8Array;
  readonly responseId?: string;
  readonly modelVersion?: string;
}
export interface MusicDependencies {
  readonly readAdc: () => Promise<GoogleCredentials>;
  readonly verifyConnection: (grant: GoogleCredentials, signal?: AbortSignal) => Promise<ConnectionCheck>;
  readonly generate: (input: MusicInput, grant: GoogleCredentials, signal: AbortSignal) => Promise<GeneratedMusic>;
}
export class MusicError extends Error {
  constructor(readonly code: string, readonly uncertain = false) { super(code); }
}
export function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
export function projectId(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/.test(value)) throw new MusicError('oauth_project_required');
  return value;
}
export function credentials(value: unknown, project?: string): GoogleCredentials {
  const parsed: unknown = typeof value === 'string' ? JSON.parse(value) : value;
  if (!object(parsed) || parsed.type !== 'authorized_user' ||
      (parsed.universe_domain !== undefined && parsed.universe_domain !== 'googleapis.com') ||
      ![parsed.client_id, parsed.client_secret, parsed.refresh_token].every(v => typeof v === 'string' && v.length > 0 && v.length <= 16_384))
    throw new MusicError('oauth_credentials_invalid');
  const selected = projectId(parsed.quota_project_id);
  if (project !== undefined && selected !== project) throw new MusicError('oauth_project_mismatch');
  return { type: 'authorized_user', client_id: String(parsed.client_id), client_secret: String(parsed.client_secret), refresh_token: String(parsed.refresh_token), quota_project_id: selected };
}
export async function current(call?: OwnerCall): Promise<void> {
  if (!call) throw new MusicError('owner_operation_required');
  call.signal?.throwIfAborted();
  await call.assertCurrent();
  call.signal?.throwIfAborted();
}
export function musicInput(value: unknown): MusicInput {
  if (!object(value) || Object.keys(value).some(key => !['prompt', 'model', 'instrumental', 'durationSeconds', 'bpm'].includes(key)) ||
      typeof value.prompt !== 'string' || !value.prompt.trim() || value.prompt.length > 12_000 ||
      (value.model !== undefined && !['lyria-3-clip-preview', 'lyria-3-pro-preview'].includes(String(value.model))) ||
      (value.instrumental !== undefined && typeof value.instrumental !== 'boolean')) throw new MusicError('invalid_input');
  const model = value.model === 'lyria-3-pro-preview' ? value.model : 'lyria-3-clip-preview';
  const number = (key: string, min: number, max: number) => {
    const n = value[key];
    if (n !== undefined && (typeof n !== 'number' || !Number.isInteger(n) || n < min || n > max)) throw new MusicError('invalid_input');
    return n as number | undefined;
  };
  const durationSeconds = number('durationSeconds', 5, 180);
  const bpm = number('bpm', 20, 300);
  if (model === 'lyria-3-clip-preview' && durationSeconds !== undefined && durationSeconds !== 30) throw new MusicError('invalid_input');
  return { prompt: value.prompt.trim(), model, instrumental: value.instrumental !== false,
    ...(durationSeconds === undefined ? {} : { durationSeconds }), ...(bpm === undefined ? {} : { bpm }) };
}
