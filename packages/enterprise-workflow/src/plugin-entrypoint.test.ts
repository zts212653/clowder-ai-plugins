import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import type { ModulePluginHostShape } from '@clowder-ai/plugin-sdk';
import { parse } from 'yaml';

import {
  createEnterpriseWorkflowPluginModule,
  EnterpriseToolError,
  type LarkActions,
  type WeComActions,
} from './plugin-entrypoint.js';
import { LarkApiError, LarkCliUnavailableError } from './LarkCliExecutor.js';

function host(values: Record<string, unknown> = {}): ModulePluginHostShape {
  return {
    config: { get: async (key) => values[key] },
    secrets: { get: async () => undefined },
    storage: {} as ModulePluginHostShape['storage'],
    tasks: {} as ModulePluginHostShape['tasks'],
    threads: {} as ModulePluginHostShape['threads'],
    messaging: {} as ModulePluginHostShape['messaging'],
    log: () => undefined,
  };
}

const manifestUrl = new URL('../plugin.yaml', import.meta.url);

test('module dispatches every declared branch through configured CLI-backed services', async () => {
  const manifest = parse(await readFile(manifestUrl, 'utf8'));
  const seen: Array<{ platform: string; method: string; input: unknown }> = [];
  const wecom = {
    createDoc: async (input) => (seen.push({ platform: 'wecom', method: 'createDoc', input }), { docId: 'D1', url: 'https://wecom.example/D1', docName: input.docName }),
    createSmartTable: async (input) => (seen.push({ platform: 'wecom', method: 'createSmartTable', input }), { docId: 'T1', url: 'https://wecom.example/T1', docName: input.tableName }),
    createTodo: async (input) => (seen.push({ platform: 'wecom', method: 'createTodo', input }), { todoId: 'todo-1', content: input.content }),
    createMeeting: async (input) => (seen.push({ platform: 'wecom', method: 'createMeeting', input }), { meetingId: 'M1', meetingCode: '123', meetingLink: 'https://meeting.example/M1', title: input.title }),
    goldenChain: async (input) => (seen.push({ platform: 'wecom', method: 'goldenChain', input }), { summary: 'wecom workflow' }),
  } satisfies WeComActions;
  const lark = {
    createDoc: async (input) => (seen.push({ platform: 'lark', method: 'createDoc', input }), { documentId: 'L1', url: 'https://lark.example/L1', title: input.title }),
    createBase: async (input) => (seen.push({ platform: 'lark', method: 'createBase', input }), { appToken: 'B1', url: 'https://lark.example/B1', name: input.name }),
    createTask: async (input) => (seen.push({ platform: 'lark', method: 'createTask', input }), { guid: 'task-1', summary: input.summary }),
    createCalendarEvent: async (input) => (seen.push({ platform: 'lark', method: 'createCalendarEvent', input }), { eventId: 'E1', calendarId: 'primary', summary: input.summary }),
    createSlides: async (input) => (seen.push({ platform: 'lark', method: 'createSlides', input }), { presentationId: 'S1', url: 'https://lark.example/S1', title: input.title }),
    goldenChain: async (input) => (seen.push({ platform: 'lark', method: 'goldenChain', input }), { summary: 'lark workflow' }),
  } satisfies LarkActions;
  const paths: string[] = [];
  const entrypoint = createEnterpriseWorkflowPluginModule({
    createWeComActions: (path) => (paths.push(path), wecom),
    createLarkActions: (path) => (paths.push(path), lark),
  });
  const active = await entrypoint.create(manifest).start(host({
    wecomCliPath: '/opt/bin/wecom-cli',
    larkCliPath: '/opt/bin/lark-cli',
  }));

  assert.deepEqual(paths, ['/opt/bin/wecom-cli', '/opt/bin/lark-cli']);
  assert.deepEqual(Object.keys(active.actions).sort(), ['lark.action', 'wecom.action']);
  assert.deepEqual(await active.actions['wecom.action']!({ action: 'create_doc', docName: 'PRD' }), {
    docId: 'D1', url: 'https://wecom.example/D1', docName: 'PRD',
  });
  await active.actions['wecom.action']!({ action: 'create_smart_table', tableName: 'Plan', fields: [], records: [] });
  await active.actions['wecom.action']!({ action: 'create_todo', content: 'Ship', followerUserIds: ['u1'] });
  await active.actions['wecom.action']!({ action: 'create_meeting', title: 'Review', startDatetime: '2026-09-23T04:00:00Z', durationSeconds: 300, inviteeUserIds: ['u1'] });
  await active.actions['wecom.action']!({ action: 'golden_chain', docName: 'PRD', docContent: '# PRD', tableName: 'Plan', tasks: [{ content: 'Ship', assigneeUserId: 'u1' }], meetingTitle: 'Review', meetingStart: '2026-09-23T04:00:00Z', meetingDurationSeconds: 300, meetingInviteeUserIds: ['u1'] });
  await active.actions['lark.action']!({ action: 'create_doc', title: 'PRD' });
  await active.actions['lark.action']!({ action: 'create_base', name: 'Plan' });
  assert.deepEqual(await active.actions['lark.action']!({ action: 'create_task', summary: 'Ship it' }), {
    guid: 'task-1', summary: 'Ship it',
  });
  await active.actions['lark.action']!({ action: 'create_calendar_event', summary: 'Review', start: '2026-09-23T04:00:00Z', end: '2026-09-23T05:00:00Z' });
  await active.actions['lark.action']!({ action: 'create_slides', title: 'Review' });
  await active.actions['lark.action']!({ action: 'golden_chain', docTitle: 'PRD', docMarkdown: '# PRD', baseName: 'Plan', tasks: [{ summary: 'Ship', assigneeOpenId: 'u1' }], calendarSummary: 'Review', calendarStart: '2026-09-23T04:00:00Z', calendarEnd: '2026-09-23T05:00:00Z', calendarAttendeeOpenIds: ['u1'] });
  assert.deepEqual(seen, [
    { platform: 'wecom', method: 'createDoc', input: { docName: 'PRD' } },
    { platform: 'wecom', method: 'createSmartTable', input: { tableName: 'Plan', fields: [], records: [] } },
    { platform: 'wecom', method: 'createTodo', input: { content: 'Ship', followerUserIds: ['u1'] } },
    { platform: 'wecom', method: 'createMeeting', input: { title: 'Review', startDatetime: '2026-09-23T04:00:00Z', durationSeconds: 300, inviteeUserIds: ['u1'] } },
    { platform: 'wecom', method: 'goldenChain', input: { docName: 'PRD', docContent: '# PRD', tableName: 'Plan', tasks: [{ content: 'Ship', assigneeUserId: 'u1' }], meetingTitle: 'Review', meetingStart: '2026-09-23T04:00:00Z', meetingDurationSeconds: 300, meetingInviteeUserIds: ['u1'] } },
    { platform: 'lark', method: 'createDoc', input: { title: 'PRD' } },
    { platform: 'lark', method: 'createBase', input: { name: 'Plan' } },
    { platform: 'lark', method: 'createTask', input: { summary: 'Ship it' } },
    { platform: 'lark', method: 'createCalendarEvent', input: { summary: 'Review', start: '2026-09-23T04:00:00Z', end: '2026-09-23T05:00:00Z' } },
    { platform: 'lark', method: 'createSlides', input: { title: 'Review' } },
    { platform: 'lark', method: 'goldenChain', input: { docTitle: 'PRD', docMarkdown: '# PRD', baseName: 'Plan', tasks: [{ summary: 'Ship', assigneeOpenId: 'u1' }], calendarSummary: 'Review', calendarStart: '2026-09-23T04:00:00Z', calendarEnd: '2026-09-23T05:00:00Z', calendarAttendeeOpenIds: ['u1'] } },
  ]);
});

test('module validates the declared action schema again at the package boundary', async () => {
  const manifest = parse(await readFile(manifestUrl, 'utf8'));
  const entrypoint = createEnterpriseWorkflowPluginModule({
    createWeComActions: () => ({}) as WeComActions,
    createLarkActions: () => ({}) as LarkActions,
  });
  const active = await entrypoint.create(manifest).start(host({ wecomCliPath: 'wecom-cli', larkCliPath: 'lark-cli' }));
  await assert.rejects(
    async () => active.actions['wecom.action']!({ action: 'create_doc', docName: '', callbackToken: 'must-not-pass' }),
    (error) => error instanceof EnterpriseToolError && error.code === 'INVALID_INPUT',
  );
});

test('known CLI failures keep API-vs-unavailable semantics as tool errors', async () => {
  const manifest = parse(await readFile(manifestUrl, 'utf8'));
  const entrypoint = createEnterpriseWorkflowPluginModule({
    createWeComActions: () => ({
      createDoc: async () => { throw new LarkCliUnavailableError('binary missing'); },
    }) as unknown as WeComActions,
    createLarkActions: () => ({
      createDoc: async () => { throw new LarkApiError({ type: 'permission', code: 99991668, message: 'denied' }, 'docs', '+create'); },
    }) as unknown as LarkActions,
  });
  const active = await entrypoint.create(manifest).start(host({ wecomCliPath: 'wecom-cli', larkCliPath: 'lark-cli' }));
  await assert.rejects(
    active.actions['wecom.action']!({ action: 'create_doc', docName: 'x' }),
    (error) => error instanceof EnterpriseToolError && error.code === 'CLI_UNAVAILABLE',
  );
  await assert.rejects(
    active.actions['lark.action']!({ action: 'create_doc', title: 'x' }),
    (error) => error instanceof EnterpriseToolError && error.code === 'VENDOR_API_ERROR',
  );
});
