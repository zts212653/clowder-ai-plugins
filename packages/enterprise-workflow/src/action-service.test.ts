import assert from 'node:assert/strict';
import test from 'node:test';

import { LarkActionService } from './LarkActionService.js';
import type { LarkCliExecutor } from './LarkCliExecutor.js';
import { WeComActionService } from './WeComActionService.js';
import type { WeComCliExecutor } from './WeComCliExecutor.js';
import type { EnterpriseLogger } from './logger.js';

const noop = () => undefined;
const logger: EnterpriseLogger = { debug: noop, info: noop, warn: noop, error: noop };

test('WeCom golden chain preserves the migrated CLI command sequence and resource handles', async () => {
  const calls: Array<{ category: string; method: string; params: Record<string, unknown> }> = [];
  const executor = {
    isAvailable: async () => true,
    exec: async (category: string, method: string, params: Record<string, unknown>) => {
      calls.push({ category, method, params });
      if (method === 'create_doc' && params.doc_type === 3) return { errcode: 0, errmsg: 'ok', docid: 'D1', url: 'https://wecom/D1' };
      if (method === 'create_doc' && params.doc_type === 10) return { errcode: 0, errmsg: 'ok', docid: 'S1', url: 'https://wecom/S1' };
      if (method === 'smartsheet_get_sheet') return { errcode: 0, errmsg: 'ok', sheet_list: [{ sheet_id: 'sheet-1', title: 'Sheet' }] };
      if (method === 'smartsheet_get_fields') return { errcode: 0, errmsg: 'ok', fields: [{ field_id: 'field-1', field_title: '文本', field_type: 'FIELD_TYPE_TEXT' }] };
      if (method === 'create_todo') return { errcode: 0, errmsg: 'ok', todo_id: `T${calls.length}` };
      if (method === 'create_meeting') return { errcode: 0, errmsg: 'ok', meetingid: 'M1', meeting_code: '123', meeting_link: 'https://meeting/M1' };
      return { errcode: 0, errmsg: 'ok' };
    },
  } as unknown as WeComCliExecutor;
  const service = new WeComActionService(executor, logger);
  const result = await service.goldenChain({
    docName: 'PRD',
    docContent: '# PRD',
    tableName: 'Tasks',
    tasks: [{ content: 'Ship', assigneeUserId: 'alice', remindTime: '2026-09-24 09:00:00' }],
    meetingTitle: 'Review',
    meetingStart: '2026-09-24 14:00',
    meetingDurationSeconds: 3600,
    meetingInviteeUserIds: ['alice'],
  });

  assert.equal(result.doc.docId, 'D1');
  assert.equal(result.smartTable.docId, 'S1');
  assert.equal(result.todos.length, 1);
  assert.equal(result.meeting.meetingId, 'M1');
  assert.match(result.summary, /1 条已分发/u);
  assert.deepEqual(calls.map(({ method }) => method), [
    'create_doc',
    'edit_doc_content',
    'create_doc',
    'smartsheet_get_sheet',
    'smartsheet_get_fields',
    'smartsheet_update_fields',
    'smartsheet_add_fields',
    'smartsheet_add_records',
    'create_todo',
    'create_meeting',
  ]);
  const records = calls.find(({ method }) => method === 'smartsheet_add_records')?.params.records as Array<{
    values: Record<string, unknown>;
  }>;
  assert.deepEqual(records[0]?.values.任务, [{ text: 'Ship', type: 'text' }]);
  assert.deepEqual(records[0]?.values.状态, [{ text: '待处理' }]);
});

test('Lark golden chain preserves exact flags and treats Slides as best-effort', async () => {
  const calls: Array<{ domain: string; command: string; flags: Record<string, unknown> }> = [];
  const executor = {
    isAvailable: async () => true,
    exec: async (domain: string, command: string, flags: Record<string, unknown>) => {
      calls.push({ domain, command, flags });
      if (domain === 'docs') return { ok: true, data: { doc_id: 'D1', doc_url: 'https://lark/D1' } };
      if (domain === 'base') return { ok: true, data: { base: { base_token: 'B1', name: String(flags.name), url: 'https://lark/B1' } } };
      if (domain === 'task') return { ok: true, data: { guid: `T${calls.length}`, url: 'https://lark/task' } };
      if (domain === 'calendar') return { ok: true, data: { event_id: 'E1', summary: String(flags.summary) } };
      if (domain === 'slides') throw new Error('slides unavailable');
      throw new Error(`unexpected ${domain} ${command}`);
    },
  } as unknown as LarkCliExecutor;
  const service = new LarkActionService(executor, logger);
  const result = await service.goldenChain({
    docTitle: 'PRD',
    docMarkdown: '# PRD',
    baseName: 'Tasks',
    tasks: [{ summary: 'Ship', assigneeOpenId: 'ou_alice', due: '+2d', description: 'Finish' }],
    calendarSummary: 'Review',
    calendarStart: '2026-09-24T14:00:00+08:00',
    calendarEnd: '2026-09-24T15:00:00+08:00',
    calendarAttendeeOpenIds: ['ou_alice'],
    includeSlides: true,
  });

  assert.equal(result.doc.documentId, 'D1');
  assert.equal(result.base.appToken, 'B1');
  assert.equal(result.tasks.length, 1);
  assert.equal(result.calendarEvent.eventId, 'E1');
  assert.equal(result.slides, undefined);
  assert.deepEqual(calls.map(({ domain, command }) => `${domain} ${command}`), [
    'docs +create',
    'base +base-create',
    'task +create',
    'calendar +create',
    'slides +create',
  ]);
  assert.deepEqual(calls[2]?.flags, {
    summary: 'Ship',
    description: 'Finish',
    assignee: 'ou_alice',
    due: '+2d',
  });
  assert.equal(calls[3]?.flags['attendee-ids'], 'ou_alice');
});
