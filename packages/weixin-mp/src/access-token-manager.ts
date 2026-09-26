import type { TokenManager } from './handlers.js';

const TOKEN_ENDPOINT = 'https://api.weixin.qq.com/cgi-bin/token';
const TOKEN_EXPIRED_CODES = new Set([40001, 40014, 42001]);
const REFRESH_MARGIN_SECONDS = 300;
const REQUEST_TIMEOUT_MS = 15_000;

interface TokenResponse {
  readonly access_token?: unknown;
  readonly expires_in?: unknown;
  readonly errcode?: unknown;
  readonly errmsg?: unknown;
}

export interface WeixinAccessTokenManagerOptions {
  readonly appId: string;
  readonly appSecret: string;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
}

/** Package-owned ephemeral token cache; credentials remain Host-projected activation inputs. */
export class WeixinAccessTokenManager implements TokenManager {
  private readonly fetch: typeof fetch;
  private readonly now: () => number;
  private token: string | undefined;
  private expiresAt = 0;
  private inflight: Promise<string> | undefined;

  constructor(private readonly options: WeixinAccessTokenManagerOptions) {
    this.fetch = options.fetch ?? globalThis.fetch;
    this.now = options.now ?? Date.now;
  }

  async getAccessToken(): Promise<string> {
    if (this.token !== undefined && this.now() < this.expiresAt) return this.token;
    this.inflight ??= this.refresh().finally(() => {
      this.inflight = undefined;
    });
    return this.inflight;
  }

  async invalidateAccessToken(): Promise<void> {
    this.token = undefined;
    this.expiresAt = 0;
  }

  isTokenExpiredError(code: number): boolean {
    return TOKEN_EXPIRED_CODES.has(code);
  }

  private async refresh(): Promise<string> {
    const query = new URLSearchParams({
      grant_type: 'client_credential',
      appid: this.options.appId,
      secret: this.options.appSecret,
    });
    const response = await this.fetch(`${TOKEN_ENDPOINT}?${query.toString()}`, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`Token endpoint returned HTTP ${response.status} ${response.statusText}`);
    }
    const body = (await response.json()) as TokenResponse;
    if (typeof body.access_token !== 'string' || body.access_token.length === 0) {
      throw new Error(`Token error: ${String(body.errcode ?? 'unknown')} ${String(body.errmsg ?? '')}`.trim());
    }
    const expiresIn = typeof body.expires_in === 'number' && Number.isFinite(body.expires_in)
      ? body.expires_in
      : 7200;
    const ttlSeconds = Math.max(60, expiresIn - REFRESH_MARGIN_SECONDS);
    this.token = body.access_token;
    this.expiresAt = this.now() + ttlSeconds * 1000;
    return body.access_token;
  }
}
