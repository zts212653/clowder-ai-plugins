import { createRequire } from 'node:module';

import type { ValidateFunction } from 'ajv';
import {
  definePlugin,
  definePluginModule,
  type FeatureContext,
  type PluginModuleEntrypoint,
} from '@clowder-ai/plugin-sdk';

import {
  LarkActionService,
  type CreateBaseOpts as LarkCreateBaseOpts,
  type CreateCalendarEventOpts as LarkCreateCalendarEventOpts,
  type CreateDocOpts as LarkCreateDocOpts,
  type CreateSlidesOpts as LarkCreateSlidesOpts,
  type CreateTaskOpts as LarkCreateTaskOpts,
  type GoldenChainOpts as LarkGoldenChainOpts,
} from './LarkActionService.js';
import {
  LarkApiError,
  LarkCliExecutor,
  LarkCliProtocolError,
  LarkCliUnavailableError,
} from './LarkCliExecutor.js';
import {
  WeComActionService,
  type CreateDocOpts as WeComCreateDocOpts,
  type CreateMeetingOpts,
  type CreateSmartTableOpts,
  type CreateTodoOpts,
  type GoldenChainOpts as WeComGoldenChainOpts,
} from './WeComActionService.js';
import {
  WeComApiError,
  WeComCliExecutor,
  WeComCliUnavailableError,
} from './WeComCliExecutor.js';
import type {
  LarkBaseHandle,
  LarkCalendarEventHandle,
  LarkDocHandle,
  LarkGoldenChainResult,
  LarkSlideHandle,
  LarkTaskHandle,
} from './lark-types.js';
import { featureLogger } from './logger.js';
import type { DocHandle, GoldenChainResult, MeetingHandle, TodoHandle } from './wecom-types.js';

const require = createRequire(import.meta.url);
const Ajv: new (options: {
  readonly allErrors: boolean;
  readonly strict: boolean;
}) => { compile(schema: Readonly<Record<string, unknown>>): ValidateFunction } = require('ajv');

export type EnterpriseToolErrorCode =
  | 'INVALID_INPUT'
  | 'VENDOR_API_ERROR'
  | 'CLI_UNAVAILABLE'
  | 'CLI_PROTOCOL_ERROR';

/** Stable package-side error classification consumed as one failed plugin_call. */
export class EnterpriseToolError extends Error {
  constructor(
    readonly code: EnterpriseToolErrorCode,
    message: string,
    readonly status: 400 | 500 | 502 | 503,
    readonly details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = 'EnterpriseToolError';
  }
}

export interface WeComActions {
  createDoc(input: WeComCreateDocOpts): Promise<DocHandle>;
  createSmartTable(input: CreateSmartTableOpts): Promise<DocHandle>;
  createTodo(input: CreateTodoOpts): Promise<TodoHandle>;
  createMeeting(input: CreateMeetingOpts): Promise<MeetingHandle>;
  goldenChain(input: WeComGoldenChainOpts): Promise<GoldenChainResult>;
}

export interface LarkActions {
  createDoc(input: LarkCreateDocOpts): Promise<LarkDocHandle>;
  createBase(input: LarkCreateBaseOpts): Promise<LarkBaseHandle>;
  createTask(input: LarkCreateTaskOpts): Promise<LarkTaskHandle>;
  createCalendarEvent(input: LarkCreateCalendarEventOpts): Promise<LarkCalendarEventHandle>;
  createSlides(input: LarkCreateSlidesOpts): Promise<LarkSlideHandle>;
  goldenChain(input: LarkGoldenChainOpts): Promise<LarkGoldenChainResult & { slides?: LarkSlideHandle }>;
}

export interface EnterpriseWorkflowPluginModuleOptions {
  readonly createWeComActions?: (executable: string, context: FeatureContext) => WeComActions;
  readonly createLarkActions?: (executable: string, context: FeatureContext) => LarkActions;
}

type WeComInput =
  | ({ action: 'create_doc' } & WeComCreateDocOpts)
  | ({ action: 'create_smart_table' } & CreateSmartTableOpts)
  | ({ action: 'create_todo' } & CreateTodoOpts)
  | ({ action: 'create_meeting' } & CreateMeetingOpts)
  | ({ action: 'golden_chain' } & WeComGoldenChainOpts);

type LarkInput =
  | ({ action: 'create_doc' } & LarkCreateDocOpts)
  | ({ action: 'create_base' } & LarkCreateBaseOpts)
  | ({ action: 'create_task' } & LarkCreateTaskOpts)
  | ({ action: 'create_calendar_event' } & LarkCreateCalendarEventOpts)
  | ({ action: 'create_slides' } & LarkCreateSlidesOpts)
  | ({ action: 'golden_chain' } & LarkGoldenChainOpts);

function requiredString(value: unknown, key: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${key} must be a configured non-empty string`);
  }
  return value;
}

function toolSchema(
  manifest: ReturnType<typeof definePlugin>['manifest'],
  id: string,
): Readonly<Record<string, unknown>> {
  const contribution = manifest.contributions?.find((item) => item.type === 'tool' && item.id === id);
  if (contribution?.type !== 'tool') throw new TypeError(`tool contribution ${id} is missing`);
  return contribution.inputSchema;
}

function assertInput<T>(validate: ValidateFunction, value: unknown, platform: string): T {
  if (validate(value)) return value as T;
  throw new EnterpriseToolError('INVALID_INPUT', `${platform} action input is invalid`, 400, {
    issues: (validate.errors ?? []).map(({ instancePath, keyword, message }) => ({ instancePath, keyword, message })),
  });
}

function mapToolError(error: unknown): never {
  if (error instanceof EnterpriseToolError) throw error;
  if (error instanceof WeComApiError) {
    throw new EnterpriseToolError('VENDOR_API_ERROR', error.message, 502, {
      platform: 'wecom', errcode: error.errcode, errmsg: error.errmsg,
    });
  }
  if (error instanceof LarkApiError) {
    throw new EnterpriseToolError('VENDOR_API_ERROR', error.message, 502, {
      platform: 'lark', code: error.code, type: error.type, ...(error.hint ? { hint: error.hint } : {}),
    });
  }
  if (error instanceof WeComCliUnavailableError || error instanceof LarkCliUnavailableError) {
    throw new EnterpriseToolError('CLI_UNAVAILABLE', error.message, 503);
  }
  if (error instanceof LarkCliProtocolError) {
    throw new EnterpriseToolError('CLI_PROTOCOL_ERROR', error.message, 500);
  }
  throw error;
}

async function invokeWeCom(service: WeComActions, input: WeComInput): Promise<unknown> {
  try {
    switch (input.action) {
      case 'create_doc': {
        const { docName, content } = input;
        return await service.createDoc({ docName, ...(content === undefined ? {} : { content }) });
      }
      case 'create_smart_table': {
        const { tableName, fields, records } = input;
        return await service.createSmartTable({ tableName, fields, records });
      }
      case 'create_todo': {
        const { content, followerUserIds, remindTime } = input;
        return await service.createTodo({ content, followerUserIds, ...(remindTime === undefined ? {} : { remindTime }) });
      }
      case 'create_meeting': {
        const { title, startDatetime, durationSeconds, inviteeUserIds } = input;
        return await service.createMeeting({ title, startDatetime, durationSeconds, inviteeUserIds });
      }
      case 'golden_chain': {
        const { action: _, ...options } = input;
        return await service.goldenChain(options);
      }
    }
  } catch (error) {
    return mapToolError(error);
  }
}

async function invokeLark(service: LarkActions, input: LarkInput): Promise<unknown> {
  try {
    switch (input.action) {
      case 'create_doc': {
        const { title, markdown, folderToken } = input;
        return await service.createDoc({
          title,
          ...(markdown === undefined ? {} : { markdown }),
          ...(folderToken === undefined ? {} : { folderToken }),
        });
      }
      case 'create_base': {
        const { name, folderToken, timeZone } = input;
        return await service.createBase({
          name,
          ...(folderToken === undefined ? {} : { folderToken }),
          ...(timeZone === undefined ? {} : { timeZone }),
        });
      }
      case 'create_task': {
        const { summary, description, assigneeOpenId, due, idempotencyKey } = input;
        return await service.createTask({
          summary,
          ...(description === undefined ? {} : { description }),
          ...(assigneeOpenId === undefined ? {} : { assigneeOpenId }),
          ...(due === undefined ? {} : { due }),
          ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
        });
      }
      case 'create_calendar_event': {
        const { summary, description, start, end, attendeeOpenIds, calendarId, rrule } = input;
        return await service.createCalendarEvent({
          summary,
          start,
          end,
          ...(description === undefined ? {} : { description }),
          ...(attendeeOpenIds === undefined ? {} : { attendeeOpenIds }),
          ...(calendarId === undefined ? {} : { calendarId }),
          ...(rrule === undefined ? {} : { rrule }),
        });
      }
      case 'create_slides': {
        const { title, folderToken } = input;
        return await service.createSlides({ title, ...(folderToken === undefined ? {} : { folderToken }) });
      }
      case 'golden_chain': {
        const { action: _, ...options } = input;
        return await service.goldenChain(options);
      }
    }
  } catch (error) {
    return mapToolError(error);
  }
}

export function createEnterpriseWorkflowPluginModule(
  options: EnterpriseWorkflowPluginModuleOptions = {},
): PluginModuleEntrypoint {
  return definePluginModule((candidate) => {
    const validated = definePlugin({ manifest: candidate });
    const ajv = new Ajv({ allErrors: true, strict: true });
    const validateWeCom = ajv.compile(toolSchema(validated.manifest, 'wecom-actions'));
    const validateLark = ajv.compile(toolSchema(validated.manifest, 'lark-actions'));

    return definePlugin({
      manifest: validated.manifest,
      activate: {
        'enterprise-actions': async (context) => {
          const [wecomPath, larkPath] = await Promise.all([
            context.config.get('wecomCliPath'),
            context.config.get('larkCliPath'),
          ]);
          const wecomExecutable = requiredString(wecomPath, 'wecomCliPath');
          const larkExecutable = requiredString(larkPath, 'larkCliPath');
          const logger = featureLogger(context);
          const wecom = options.createWeComActions?.(wecomExecutable, context)
            ?? new WeComActionService(new WeComCliExecutor(logger, wecomExecutable), logger);
          const lark = options.createLarkActions?.(larkExecutable, context)
            ?? new LarkActionService(new LarkCliExecutor(logger, larkExecutable), logger);
          return {
            actions: {
              'wecom.action': (input) => invokeWeCom(wecom, assertInput<WeComInput>(validateWeCom, input, 'WeCom')),
              'lark.action': (input) => invokeLark(lark, assertInput<LarkInput>(validateLark, input, 'Lark')),
            },
          };
        },
      },
    });
  });
}

export default createEnterpriseWorkflowPluginModule();
