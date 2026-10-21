import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { FeatureContext, PluginActionContext, PluginStorageHost } from '@clowder-ai/plugin-sdk';

const prefix = 'github.tracking-diagnostics.v1.';
export interface DiagnosticError {
  name: string; message: string; stack?: string; stderr?: string;
  code?: string | number; signal?: string; cause?: DiagnosticError; truncated?: boolean;
}
const errorSchema: z.ZodType<DiagnosticError> = z.lazy(() => z.object({
  name: z.string(), message: z.string(), stack: z.string().optional(), stderr: z.string().optional(),
  code: z.union([z.string(), z.number()]).optional(), signal: z.string().optional(),
  cause: errorSchema.optional(), truncated: z.boolean().optional(),
}).strict());
const schema = z.object({
  requestKey: z.string().regex(/^[a-f0-9]{64}$/), subject: z.string(), catId: z.string(), threadId: z.string(),
  at: z.number(), attempts: z.number().int().positive(),
  phase: z.enum(['verify_authority', 'load_subscription', 'read_github', 'save_subscription', 'complete']),
  status: z.enum(['started', 'failed', 'registered']),
  code: z.enum(['started', 'provider_read_failed', 'registration_rejected', 'storage_or_authority_failed', 'registered']),
  statusCode: z.number().int().optional(),
  error: errorSchema.optional(),
}).strict();
export type RegistrationDiagnostic = z.infer<typeof schema>;

/** Persist diagnostic exceptions privately after credential redaction; never send them as notifications. */
export async function writeRegistrationDiagnostic(storage: PluginStorageHost, caller: PluginActionContext,
  registrationId: string, subject: string, value: Pick<RegistrationDiagnostic, 'phase' | 'status' | 'code' | 'at' | 'statusCode' | 'error'>) {
  const requestKey = createHash('sha256').update(JSON.stringify([caller.userId, caller.catId, caller.threadId, registrationId])).digest('hex');
  const key = prefix + requestKey;
  for (let attempt = 0; attempt < 3; attempt++) {
    const current = await storage.get(key);
    const previous = current ? schema.parse(current.value) : undefined;
    const record = schema.parse({ requestKey, subject, catId: caller.catId, threadId: caller.threadId,
      attempts: (previous?.attempts ?? 0) + (value.status === 'started' ? 1 : 0), ...value });
    if ((await storage.compareAndSet(key, current?.revision ?? null, record)).applied) return;
  }
  throw new Error('Registration diagnostic write raced');
}

export async function readRegistrationDiagnostics(storage: PluginStorageHost): Promise<RegistrationDiagnostic[]> {
  return Object.entries(await storage.list()).filter(([key]) => key.startsWith(prefix))
    .map(([, entry]) => schema.parse(entry.value)).sort((a, b) => b.at - a.at).slice(0, 25);
}

export function registrationFailureCode(phase: RegistrationDiagnostic['phase'], rejected: boolean): RegistrationDiagnostic['code'] {
  return rejected ? 'registration_rejected' : phase === 'read_github' ? 'provider_read_failed' : 'storage_or_authority_failed';
}

/** Preserve actionable exception detail while removing known credentials before persistence. */
export async function diagnosticError(error: unknown, secrets: FeatureContext['secrets']): Promise<DiagnosticError> {
  const values = await Promise.allSettled(['token', 'mcpToken', 'webhookSecret'].map(key => Promise.resolve().then(() => secrets.get(key))));
  if (values.some(value => value.status === 'rejected')) {
    return { name: 'DiagnosticRedactionUnavailable', message: 'Exception detail unavailable because saved credential redaction could not be verified.' };
  }
  const known = [...values.flatMap(value => value.status === 'fulfilled' && value.value ? [value.value] : []),
    ...['GH_TOKEN', 'GITHUB_TOKEN', 'CLOWDER_PLUGIN_ACTION_TOKEN', 'CAT_CAFE_CALLBACK_TOKEN'].flatMap(key => process.env[key] ? [process.env[key]!] : [])]
    .flatMap(value => [value, encodeURIComponent(value)]).sort((a, b) => b.length - a.length);
  let remaining = 24_000;
  const text = (value: string, limit: number) => {
    let safe = value;
    for (const credential of known) safe = safe.split(credential).join('[redacted]');
    safe = safe.replace(/(?:github_pat_[A-Za-z0-9_]+|gh[pousr]_[A-Za-z0-9]+)/g, '[redacted]')
      .replace(/((?:authorization|proxy-authorization|x-callback-token|x-clowder-plugin-action-token|cookie|set-cookie)["']?\s*[:=]\s*)[^\r\n]+/gi, '$1[redacted]')
      .replace(/((?:access_token|refresh_token|client_secret|password|GH_TOKEN|GITHUB_TOKEN|CAT_CAFE_CALLBACK_TOKEN|CLOWDER_PLUGIN_ACTION_TOKEN)["']?\s*[:=]\s*["']?)[^\s"'&,]+/gi, '$1[redacted]')
      .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[redacted]@');
    const size = Math.max(0, Math.min(limit, remaining));
    remaining -= Math.min(size, safe.length);
    return safe.length > size ? safe.slice(0, size) + '[truncated]' : safe;
  };
  const seen = new Set<unknown>();
  const serialize = (value: unknown, depth: number): DiagnosticError => {
    if (seen.has(value) || depth > 3 || remaining <= 0) return { name: 'Error', message: '[cause truncated]', truncated: true };
    seen.add(value);
    if (!value || typeof value !== 'object') return { name: 'ThrownValue', message: text(String(value), 4096) };
    const source = value as { name?: unknown; message?: unknown; stack?: unknown; stderr?: unknown; code?: unknown; signal?: unknown; cause?: unknown };
    const result: DiagnosticError = { name: text(typeof source.name === 'string' ? source.name : 'Error', 128),
      message: text(typeof source.message === 'string' ? source.message : String(value), 4096) };
    if (typeof source.stack === 'string') result.stack = text(source.stack, 8192);
    if (typeof source.stderr === 'string') result.stderr = text(source.stderr, 8192);
    if (typeof source.code === 'string' || typeof source.code === 'number') result.code = typeof source.code === 'string' ? text(source.code, 256) : source.code;
    if (typeof source.signal === 'string') result.signal = text(source.signal, 128);
    if (source.cause !== undefined) result.cause = serialize(source.cause, depth + 1);
    return result;
  };
  return serialize(error, 0);
}
