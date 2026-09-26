import { z } from 'zod';

import { execute, scrubCredentials } from './protocol-engine/engine.js';
import type {
  AuthType,
  ExecutionParams,
  ProtocolTemplate,
  ProviderInstance,
} from './protocol-engine/types.js';
import { requireHttpsVideoUrl } from './protocol.js';
import type { ToolResult } from './tool-result.js';
import { errorResult, successResult } from './tool-result.js';

export interface ProtocolToolConfig {
  readonly prefix: string;
  readonly provider: ProviderInstance;
  readonly template: ProtocolTemplate;
  readonly credentials: Record<string, string>;
}

export interface ToolExtra {
  readonly signal?: AbortSignal;
}

export interface ProtocolToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  readonly handler: (args: never, extra?: ToolExtra) => Promise<ToolResult>;
}

function buildParams(
  config: ProtocolToolConfig,
  capability: string,
  vars: Record<string, string>,
): ExecutionParams {
  return {
    provider: config.provider,
    capability,
    credentials: config.credentials,
    vars,
  };
}

function createExecuteTool(
  config: ProtocolToolConfig,
  capabilities: string[],
): ProtocolToolDefinition {
  return {
    name: `${config.prefix}_execute`,
    description:
      `Execute a sync ${config.template.name} request. `
      + `Capabilities: ${capabilities.join(', ')}. `
      + 'Returns result directly.',
    inputSchema: {
      capability: z.enum(capabilities as [string, ...string[]]).describe('Capability to invoke'),
      vars: z.record(z.string()).describe('Template variables (videoUrl, prompt, etc.)'),
    },
    handler: (async (
      input: { capability: string; vars: Record<string, string> },
      extra?: ToolExtra,
    ) => {
      try {
        requireHttpsVideoUrl(input.vars.videoUrl ?? '');
        const result = await execute(
          config.template,
          buildParams(config, input.capability, input.vars),
          extra?.signal,
        );
        return successResult(result.result);
      } catch (error) {
        const raw = error instanceof Error ? error.message : String(error);
        return errorResult(`Execute failed: ${scrubCredentials(raw, config.credentials)}`);
      }
    }) as (args: never, extra?: ToolExtra) => Promise<ToolResult>,
  };
}

export function createProtocolTools(config: ProtocolToolConfig): ProtocolToolDefinition[] {
  const capabilities = Object.keys(config.template.capabilities);
  if (capabilities.length === 0) return [];
  if (config.template.mode !== 'sync') {
    throw new TypeError(`video-analysis requires a sync protocol template, got ${config.template.mode}`);
  }
  return [createExecuteTool(config, capabilities)];
}

export function buildProvider(
  providerName: string,
  template: ProtocolTemplate,
  options: { readonly baseUrl?: string; readonly model?: string },
): ProviderInstance {
  const authType = (template.auth?.method ?? 'apikey') as AuthType;
  return {
    id: providerName,
    name: providerName,
    protocol: providerName,
    baseUrl: options.baseUrl ?? template.baseUrl ?? '',
    authType,
    ...(options.model === undefined ? {} : { model: options.model }),
  };
}
