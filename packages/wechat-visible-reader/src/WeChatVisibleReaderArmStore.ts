import type { FeatureContext } from '@clowder-ai/plugin-sdk';

type PluginStorageHost = FeatureContext['storage'];

const ARM_KEY = 'visible-conversation-arm';
const ARM_SCOPE = 'visible-conversation';
const MAX_ARM_MS = 30 * 60_000;

export interface WeChatVisibleReaderArmStatus {
  readonly armed: boolean;
  readonly remainingMs: number;
  readonly expiresAt?: string;
}

interface ArmState {
  readonly scope: typeof ARM_SCOPE;
  readonly expiresAt: number;
}

export interface WeChatVisibleReaderArmStoreOptions {
  readonly storage: PluginStorageHost;
  readonly now?: () => number;
}

function isArmState(value: unknown, now: number): value is ArmState {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const state = value as Record<string, unknown>;
  return Object.keys(state).length === 2
    && state.scope === ARM_SCOPE
    && typeof state.expiresAt === 'number'
    && Number.isSafeInteger(state.expiresAt)
    && state.expiresAt > now
    && state.expiresAt - now <= MAX_ARM_MS;
}

export class WeChatVisibleReaderArmStore {
  private readonly storage: PluginStorageHost;
  private readonly now: () => number;

  constructor(options: WeChatVisibleReaderArmStoreOptions) {
    this.storage = options.storage;
    this.now = options.now ?? Date.now;
  }

  async arm(input: { readonly minutes: number }): Promise<WeChatVisibleReaderArmStatus> {
    if (!Number.isInteger(input.minutes) || input.minutes < 1 || input.minutes > 30) {
      throw new RangeError('Arm TTL must be a whole number between 1 and 30 minutes');
    }
    const now = this.now();
    const expiresAt = now + input.minutes * 60_000;
    await this.storage.set(ARM_KEY, { scope: ARM_SCOPE, expiresAt } satisfies ArmState);
    return { armed: true, remainingMs: expiresAt - now, expiresAt: new Date(expiresAt).toISOString() };
  }

  async status(): Promise<WeChatVisibleReaderArmStatus> {
    const entry = await this.storage.get(ARM_KEY);
    const now = this.now();
    if (!isArmState(entry?.value, now)) {
      if (entry !== undefined) await this.storage.delete(ARM_KEY, entry.revision);
      return { armed: false, remainingMs: 0 };
    }
    return {
      armed: true,
      remainingMs: entry.value.expiresAt - now,
      expiresAt: new Date(entry.value.expiresAt).toISOString(),
    };
  }

  async isArmed(): Promise<boolean> {
    try {
      return (await this.status()).armed;
    } catch {
      // Storage failures cannot authorize a screenshot.
      return false;
    }
  }

  async disarm(): Promise<WeChatVisibleReaderArmStatus> {
    await this.storage.delete(ARM_KEY);
    return { armed: false, remainingMs: 0 };
  }
}
