export type VideoAnalysisProvider = 'gemini' | 'zhipu';

export interface VideoAnalysisProviderConfig {
  readonly provider: VideoAnalysisProvider;
  readonly apiKey: string;
  readonly baseUrl?: string;
  readonly model?: string;
}

export interface VideoAnalysisInput {
  readonly videoUrl: string;
  readonly prompt: string;
  readonly mimeType?: string;
}

const DEFAULT_BASE_URL: Readonly<Record<VideoAnalysisProvider, string>> = {
  gemini: 'https://generativelanguage.googleapis.com',
  zhipu: 'https://open.bigmodel.cn',
};

const DEFAULT_MODEL: Readonly<Record<VideoAnalysisProvider, string>> = {
  gemini: 'gemini-2.0-flash',
  zhipu: 'glm-4.6v-flash',
};

const RESPONSE_BYTE_LIMIT = 4 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;
const TRANSIENT_STATUS_CODES = new Set([429, 500, 502, 503, 504]);
const RETRY_BASE_MS = 1_000;
const MAX_RETRIES = 2;

class ResponseBodyLimitError extends Error {
  constructor() {
    super(`provider response exceeded ${RESPONSE_BYTE_LIMIT} bytes`);
    this.name = 'ResponseBodyLimitError';
  }
}

function scrub(text: string, secrets: readonly string[]): string {
  let result = text;
  for (const secret of [...secrets].filter((value) => value.length > 0).sort((a, b) => b.length - a.length)) {
    result = result.replaceAll(secret, '***');
  }
  return result;
}

function credentialArtifacts(apiKey: string): readonly string[] {
  const percentEncoded = encodeURIComponent(apiKey);
  const formEncoded = new URLSearchParams([['key', apiKey]]).toString().slice('key='.length);
  return [...new Set([apiKey, percentEncoded, formEncoded, `Bearer ${apiKey}`])];
}

function isLoopback(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

function requireBaseUrl(value: string): URL {
  const url = new URL(value);
  if (url.username !== '' || url.password !== '') {
    throw new TypeError('video-analysis base URL must not contain credentials');
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback(url.hostname))) {
    throw new TypeError('video-analysis base URL must use HTTPS or an isolated loopback HTTP fixture');
  }
  return url;
}

function requireVideoUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') {
    throw new TypeError('video URL must be an HTTPS URL without embedded credentials');
  }
  return url.toString();
}

function requireConfig(config: VideoAnalysisProviderConfig): Required<VideoAnalysisProviderConfig> {
  if (config.provider !== 'gemini' && config.provider !== 'zhipu') {
    throw new TypeError('video-analysis provider must be gemini or zhipu');
  }
  if (config.apiKey.trim() === '') throw new TypeError('video-analysis API key is required');
  return {
    provider: config.provider,
    apiKey: config.apiKey,
    baseUrl: requireBaseUrl(config.baseUrl ?? DEFAULT_BASE_URL[config.provider]).toString(),
    model: config.model?.trim() || DEFAULT_MODEL[config.provider],
  };
}

function requestShape(
  config: Required<VideoAnalysisProviderConfig>,
  input: VideoAnalysisInput,
): { readonly url: URL; readonly headers: Readonly<Record<string, string>>; readonly body: unknown } {
  const videoUrl = requireVideoUrl(input.videoUrl);
  if (input.prompt.trim() === '') throw new TypeError('video-analysis prompt is required');
  const base = new URL(config.baseUrl);
  if (config.provider === 'gemini') {
    const url = new URL(`/v1beta/models/${encodeURIComponent(config.model)}:generateContent`, base);
    url.searchParams.set('key', config.apiKey);
    return {
      url,
      headers: { 'content-type': 'application/json' },
      body: {
        contents: [
          {
            role: 'user',
            parts: [
              { fileData: { mimeType: input.mimeType ?? 'video/mp4', fileUri: videoUrl } },
              { text: input.prompt },
            ],
          },
        ],
        generationConfig: { temperature: 0.2, responseMimeType: 'application/json' },
      },
    };
  }
  return {
    url: new URL('/api/paas/v4/chat/completions', base),
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${config.apiKey}`,
    },
    body: {
      model: config.model,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: input.prompt },
            { type: 'video_url', video_url: { url: videoUrl } },
          ],
        },
      ],
      temperature: 0.2,
      response_format: { type: 'json_object' },
    },
  };
}

function readPath(value: unknown, path: readonly (string | number)[]): unknown {
  let current = value;
  for (const segment of path) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string | number, unknown>)[segment];
  }
  return current;
}

async function boundedResponseText(response: Response): Promise<string> {
  if (response.body === null) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > RESPONSE_BYTE_LIMIT) {
        await reader.cancel().catch(() => undefined);
        throw new ResponseBodyLimitError();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && (error.name === 'AbortError' || error.name === 'TimeoutError');
}

function retryDelayMs(response: Response | undefined, attempt: number): number {
  const retryAfter = response?.headers.get('retry-after');
  if (retryAfter !== null && retryAfter !== undefined) {
    if (/^[0-9]+$/.test(retryAfter)) return Number(retryAfter) * 1_000;
    const retryAt = Date.parse(retryAfter);
    if (!Number.isNaN(retryAt)) return Math.max(0, retryAt - Date.now());
  }
  return RETRY_BASE_MS * 2 ** attempt;
}

async function waitForRetry(
  response: Response | undefined,
  attempt: number,
  signal: AbortSignal | undefined,
): Promise<void> {
  signal?.throwIfAborted();
  const delayMs = retryDelayMs(response, attempt);
  if (delayMs === 0) return;
  await new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, delayMs);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Execute the real provider request owned by this package. */
export async function analyzeVideo(
  candidate: VideoAnalysisProviderConfig,
  input: VideoAnalysisInput,
  signal?: AbortSignal,
): Promise<string> {
  const config = requireConfig(candidate);
  const request = requestShape(config, input);
  const secrets = credentialArtifacts(config.apiKey);
  let responseText = '';
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    signal?.throwIfAborted();
    const requestSignal = signal === undefined
      ? AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      : AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]);
    let response: Response | undefined;
    try {
      response = await fetch(request.url, {
        method: 'POST',
        headers: request.headers,
        body: JSON.stringify(request.body),
        signal: requestSignal,
      });
      responseText = await boundedResponseText(response);
    } catch (error) {
      if (isAbortError(error)) throw error;
      if (error instanceof ResponseBodyLimitError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      const failure = new Error(scrub(message, secrets));
      const responseCanRetry = response === undefined
        || response.ok
        || TRANSIENT_STATUS_CODES.has(response.status);
      if (!responseCanRetry || attempt === MAX_RETRIES) throw failure;
      await waitForRetry(response, attempt, signal);
      continue;
    }
    if (response === undefined) throw new Error('video-analysis request completed without a response');
    if (response.ok) break;
    const failure = new Error(
      `provider HTTP ${response.status}: ${scrub(responseText.slice(0, 1000), secrets)}`,
    );
    if (!TRANSIENT_STATUS_CODES.has(response.status) || attempt === MAX_RETRIES) throw failure;
    await waitForRetry(response, attempt, signal);
  }
  let json: unknown;
  try {
    json = JSON.parse(responseText) as unknown;
  } catch (error) {
    throw new Error(
      `provider returned invalid JSON: ${scrub(responseText.slice(0, 1000), secrets)}`,
      { cause: error },
    );
  }
  const rawResult = config.provider === 'gemini'
    ? readPath(json, ['candidates', 0, 'content', 'parts', 0, 'text'])
    : readPath(json, ['choices', 0, 'message', 'content']);
  if (typeof rawResult !== 'string' || rawResult.length === 0) {
    throw new Error(
      `provider response did not contain a result: ${scrub(responseText.slice(0, 1000), secrets)}`,
    );
  }
  return scrub(rawResult, secrets);
}

export function readVideoAnalysisProviderConfig(
  environment: NodeJS.ProcessEnv,
): VideoAnalysisProviderConfig {
  const provider = environment.VIDEO_ANALYSIS_PROVIDER;
  if (provider !== 'gemini' && provider !== 'zhipu') {
    throw new TypeError('VIDEO_ANALYSIS_PROVIDER must be gemini or zhipu');
  }
  return requireConfig({
    provider,
    apiKey: environment.VIDEO_ANALYSIS_API_KEY ?? '',
    baseUrl: environment.VIDEO_ANALYSIS_BASE_URL,
    model: environment.VIDEO_ANALYSIS_MODEL,
  });
}
