import { readFileSync } from 'node:fs';

interface CallbackCredentials {
  readonly apiUrl: string;
  readonly invocationId: string;
  readonly callbackToken: string;
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readRefreshFile(path: string | undefined): {
  invocationId?: string;
  callbackToken?: string;
} {
  if (!path) return {};
  try {
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
    const record = value as Record<string, unknown>;
    const invocationId = stringField(record.invocationId);
    const callbackToken = stringField(record.callbackToken);
    return {
      ...(invocationId === undefined ? {} : { invocationId }),
      ...(callbackToken === undefined ? {} : { callbackToken }),
    };
  } catch {
    return {};
  }
}

function callbackCredentials(): CallbackCredentials | undefined {
  const apiUrl = stringField(process.env.CAT_CAFE_API_URL);
  if (!apiUrl) return undefined;
  const refreshed = readRefreshFile(process.env.CAT_CAFE_CREDENTIAL_FILE);
  const invocationId = refreshed.invocationId ?? stringField(process.env.CAT_CAFE_INVOCATION_ID);
  const callbackToken = refreshed.callbackToken ?? stringField(process.env.CAT_CAFE_CALLBACK_TOKEN);
  if (!invocationId || !callbackToken) return undefined;
  return { apiUrl, invocationId, callbackToken };
}

/** Best-effort projection only. Provider completion never depends on this callback. */
export async function emitRichFileBlock(block: {
  readonly id: string;
  readonly kind: 'file';
  readonly v: 1;
  readonly url: string;
  readonly fileName: string;
  readonly mimeType: string;
}): Promise<boolean> {
  const credentials = callbackCredentials();
  if (!credentials) return false;
  try {
    const response = await fetch(new URL('/api/callbacks/create-rich-block', credentials.apiUrl), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-invocation-id': credentials.invocationId,
        'x-callback-token': credentials.callbackToken,
      },
      body: JSON.stringify({ block }),
      signal: AbortSignal.timeout(30_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}
