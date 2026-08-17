import {
  FeishuGatewayError,
  type FeishuArtifactLocator,
  type FeishuGeneratedArtifact,
} from './gateway.js';
import {
  createDefaultLarkCliReadCommand,
  type LarkCliReadCommand,
} from './lark-cli-read-command.js';
import { minuteArtifacts } from './lark-cli-polling-normalizer.js';

const MAX_REFERENCE_LENGTH = 2_048;
const MINUTE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

export interface LarkCliFeishuArtifactInspectorOptions {
  readonly homeDirectory: string;
  readonly runCommand?: LarkCliReadCommand;
}

function requireMinuteToken(value: string): string {
  if (!MINUTE_TOKEN.test(value)) {
    throw new TypeError('Feishu Minutes reference contains an invalid token');
  }
  return value;
}

function allowedMinutesHost(hostname: string): boolean {
  return hostname === 'feishu.cn' ||
    hostname.endsWith('.feishu.cn') ||
    hostname === 'larksuite.com' ||
    hostname.endsWith('.larksuite.com');
}

/** Parse owner-pasted Minutes references without accepting filesystem or arbitrary network paths. */
export function parseFeishuMinutesReference(value: string): FeishuArtifactLocator {
  if (typeof value !== 'string') throw new TypeError('Feishu Minutes reference must be text');
  const reference = value.trim();
  if (reference.length < 1 || reference.length > MAX_REFERENCE_LENGTH) {
    throw new TypeError('Feishu Minutes reference must be bounded');
  }
  if (MINUTE_TOKEN.test(reference)) {
    return { artifactId: reference, kind: 'minute' };
  }

  let url: URL;
  try {
    url = new URL(reference);
  } catch {
    throw new TypeError('Feishu Minutes reference must be a token or HTTPS Minutes URL');
  }
  if (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    url.port !== '' ||
    url.hash !== '' ||
    !allowedMinutesHost(url.hostname.toLowerCase())
  ) {
    throw new TypeError('Feishu Minutes URL has invalid authority');
  }
  const path = url.pathname.split('/').filter(Boolean);
  if (path.length !== 2 || path[0] !== 'minutes') {
    throw new TypeError('Feishu Minutes URL has invalid path');
  }
  return { artifactId: requireMinuteToken(path[1]), kind: 'minute' };
}

export function createLarkCliFeishuArtifactInspector(
  options: LarkCliFeishuArtifactInspectorOptions,
): (locator: FeishuArtifactLocator, signal: AbortSignal) => Promise<FeishuGeneratedArtifact> {
  const runCommand = options.runCommand ?? createDefaultLarkCliReadCommand(options.homeDirectory);
  return async (locator, signal): Promise<FeishuGeneratedArtifact> => {
    if (locator.kind !== 'minute') {
      throw new FeishuGatewayError('NOT_FOUND', 'lark-cli historical inspection supports Minute tokens');
    }
    const token = requireMinuteToken(locator.artifactId);
    const artifacts = minuteArtifacts(await runCommand([
      'minutes', 'minutes', 'get', '--minute-token', token,
      '--as', 'user', '--format', 'json',
    ], signal), undefined);
    const minute = artifacts.find(candidate => candidate.kind === 'minute' && candidate.artifactId === token);
    if (minute === undefined || (locator.revision !== undefined && locator.revision !== minute.revision)) {
      throw new FeishuGatewayError('NOT_FOUND', 'Feishu Minute revision is not available');
    }
    return minute;
  };
}
