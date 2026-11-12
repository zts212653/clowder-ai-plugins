import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createContext, runInContext } from 'node:vm';
import { fixture } from './service-fixture.js';

async function panel(stage: 'review' | 'handoff' = 'review') {
  const service = fixture();
  const initial = await service.call({ op: 'save', targetId: 'clowder', report: { kind: 'bug', title: 'bug: initial', body: 'initial', attachments: [] } });
  const saved = stage === 'handoff' ? await service.call({ op: 'manual', digest: initial.journal.digest }) : initial;
  const elements = new Map<string, Record<string, unknown>>();
  const buttons = new Map<string, () => unknown>();
  const copied: unknown[] = [];
  const timers: Array<() => void> = [];
  function node(tag = 'div', props: Record<string, unknown> = {}, children: unknown[] = []) {
    const value = {
      ...props, children, dataset: {}, scrollTop: 0,
      append() {}, replaceChildren() {}, addEventListener() {}, querySelector() {},
      replaceWith(replacement: Record<string, unknown>) { elements.set('preview', replacement); },
    };
    if (typeof props.id === 'string') elements.set(props.id, value);
    if (props['aria-label'] === '报告正文预览') elements.set('preview', value);
    const action = props.onClick;
    if (typeof action === 'function') buttons.set(String(props.text), () => action());
    return value;
  }
  const app = node();
  let pause: (() => Promise<void>) | undefined;
  const context = createContext({ Blob, atob, console,
    document: { getElementById: (id: string) => id === 'app' ? app : elements.get(id), querySelector: (selector: string) => selector === '[aria-label="报告正文预览"]' ? elements.get('preview') : null, querySelectorAll: () => [] },
    el: node, reportPreview: (body: string) => node('article', { 'aria-label': '报告正文预览', text: body }), feedbackForm: () => [], feedbackHistory: node,
    crypto: { randomUUID: () => saved.journal.id }, copyImage: async () => {}, normalizePicture: async () => {}, beforeClose: async () => {},
    setTimeout: (action: () => void, delay: number) => { if (delay === 500) timers.push(action); return 0; }, clearTimeout() {},
    bridge: async (type: string, value: unknown) => { if (type === 'clipboard.text') copied.push(value); },
    call: async (input: { op: string; feedbackId?: string }) => {
      if (input.op === 'bootstrap' && !input.feedbackId) return new Promise(() => {});
      const request = structuredClone(input);
      if (input.op === 'save') await pause?.();
      return service.call(request);
    },
  });
  const source = await readFile(new URL('../ui/main.js', import.meta.url), 'utf8');
  runInContext(source.replace(/^import[^\n]+\n/gm, ''), context);
  const actions = runInContext('({state,saveDraft,flushDraft,input,render,invalidate,openRecord})', context);
  Object.assign(actions.state, saved, { busy: false, stage, preview: false, targetId: 'clowder', feedbackId: saved.journal.id, report: structuredClone(saved.journal.report) });
  actions.render();
  const edit = (title: string, body: string) => {
    actions.input('报告标题', 'title', false, true).children[1].onInput({ target: { value: title } });
    actions.input('报告正文', 'body', true, true).children[1].onInput({ target: { value: body } });
  };
  return { actions, service, elements, buttons, copied, edit, timers, pause: (value: () => Promise<void>) => { pause = value; } };
}

(['review', 'handoff'] as const).forEach(stage => test(`automatic ${stage} saving adopts the sanitized title and body before preview, copy and reopen`, async () => {
  const p = await panel(stage);
  p.edit('bug: api_key=synthetic-title-secret', 'api_key=synthetic-body-secret');
  p.actions.state.preview = true;
  p.actions.render();
  p.timers.at(-1)!();
  await p.actions.flushDraft();
  const report = p.actions.state.journal.report;
  assert.ok(!report.title.includes('synthetic-title-secret'));
  assert.ok(!report.body.includes('synthetic-body-secret'));
  assert.equal(p.actions.state.dirty, false);
  assert.equal(p.actions.state.report.title, report.title);
  assert.equal(p.actions.state.report.body, report.body);
  assert.equal(p.elements.get('feedback-title')?.value, report.title);
  assert.equal(p.elements.get('preview')?.text, report.body);
  await p.buttons.get('复制标题')!();
  await p.buttons.get('复制报告正文')!();
  assert.deepEqual(p.copied, [report.title, report.body]);
  await p.actions.openRecord(p.actions.state.feedbackId);
  assert.equal(p.actions.state.report.title, report.title);
  assert.equal(p.actions.state.report.body, report.body);
  assert.equal(p.service.creates(), 0);
}));

test('a sanitized save acknowledgement cannot overwrite newer review input', async () => {
  const p = await panel();
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const waiting = new Promise<void>(resolve => { release = resolve; });
  p.pause(async () => { entered(); await waiting; });
  p.edit('bug: api_key=old-title-secret', 'api_key=old-body-secret');
  const saving = p.actions.saveDraft();
  await started;
  p.edit('bug: api_key=new-title-secret', 'api_key=new-body-secret');
  release();
  await saving;
  assert.equal(p.actions.state.report.title, 'bug: api_key=new-title-secret');
  assert.equal(p.actions.state.report.body, 'api_key=new-body-secret');
  assert.equal(p.actions.state.dirty, true);
  await p.actions.flushDraft();
  const report = p.actions.state.journal.report;
  assert.equal(p.actions.state.report.title, report.title);
  assert.equal(p.actions.state.report.body, report.body);
  assert.ok(!report.title.includes('new-title-secret'));
  assert.ok(!report.body.includes('new-body-secret'));
  await p.buttons.get('复制报告正文')!();
  assert.deepEqual(p.copied, [report.body]);
  assert.equal(p.service.creates(), 0);
});
