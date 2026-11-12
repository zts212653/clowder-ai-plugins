import assert from 'node:assert/strict';
import test from 'node:test';
import { publish } from '../src/work.js';
import { fixture } from './fixture.js';

test('a long result remains complete at its source while the assistant receives a labelled excerpt and a working source link', async () => {
  const f = fixture();
  const content = '导出修复已完成验证，等待你验收。\n\n' + '详细调查、日志与验证坐标。'.repeat(180);
  await publish(f.host, 'assistant-main', { sourceThreadId: 'source-a' }, 'long-result', content);
  const original = f.sent.get('source-a:long-result:source')!;
  const main = f.sent.get('assistant-main:long-result:main')!;
  assert.ok(JSON.stringify(original.payload).includes(content.replace(/\n/g, '\\n')), 'source keeps the full real result');
  const text = JSON.stringify(main.payload);
  assert.ok(text.length < 600, 'the main inbox must not copy the entire technical report');
  assert.match(text, /原文节选/);
  assert.match(text, /导出修复已完成验证/);
  assert.match(text, /http:\/\/localhost\/\?threadId=source-a/);
  assert.equal(main.wake, undefined);
});

test('work requested in the main conversation also keeps its full result in the work thread', async () => {
  const f = fixture();
  const content = '修复通过，等待验收。\n\n' + '完整验证材料。'.repeat(180);
  await publish(f.host, 'source-a', { sourceThreadId: 'source-a', threadId: 'source-b' }, 'main-request', content);
  assert.ok(JSON.stringify(f.sent.get('source-b:main-request:details')!.payload).includes(content.replace(/\n/g, '\\n')));
  const main = f.sent.get('source-a:main-request:source')!;
  assert.ok(JSON.stringify(main.payload).length < 600);
  assert.match(JSON.stringify(main.payload), /http:\/\/localhost\/\?threadId=source-b/);
  assert.equal(f.sent.size, 2);
});
