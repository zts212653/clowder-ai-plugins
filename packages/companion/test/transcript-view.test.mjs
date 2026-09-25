import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TranscriptView } from '../src/transcript-view.mjs';

function fixture() {
  const document = { createElement: () => ({ dataset: {}, textContent: '', setAttribute() {}, remove() { container.children = container.children.filter(row => row !== this); } }) };
  const container = { ownerDocument: document, children: [], scrollTop: 0, scrollHeight: 100, clientHeight: 100,
    querySelector: () => null, append(...rows) { this.children.push(...rows); }, replaceChildren(...rows) { this.children = rows; } };
  return { container, view: new TranscriptView(container) };
}
const message = (id, text = id) => ({ id, role: 'user', name: '你', text });

test('history refresh preserves the unfinished voice caption and its following chunks', () => {
  const { view, container } = fixture();
  view.load([message('old')]);
  view.append('assistant', '正在', true);
  view.load([message('old'), message('new')]);
  view.append('assistant', '说话', true);
  assert.deepEqual(container.children.map(row => row.textContent), ['old', 'new', '正在说话']);
  assert.equal(container.children.at(-1).dataset.live, 'true');
});

test('committed history is authoritative; finishing a caption never invents a durable message', () => {
  const { view, container } = fixture();
  view.append('user', '你好', true);
  view.finish({ role: 'user', transcript: '你好', turnId: 't1' });
  view.load([message('m1', '你好'), message('m2', '你好')]);
  view.finish({ role: 'user', transcript: '你好', turnId: 't1' });
  assert.deepEqual(container.children.map(row => row.dataset.messageId), ['m1', 'm2']);
});

test('ending voice clears transient captions but retains history and reading position', () => {
  const { view, container } = fixture();
  view.load([message('m1')]); view.append('assistant', '半句话', true);
  container.scrollTop = 10; container.scrollHeight = 1000;
  view.reset();
  view.load([message('m1'), message('m2')]);
  assert.deepEqual(container.children.map(row => row.textContent), ['m1', 'm2']);
  assert.equal(container.scrollTop, 10);
});

test('refresh reuses unchanged history rows and preserves repeated text with distinct ids', () => {
  const { view, container } = fixture();
  view.load([message('m1', '好')]); const original = container.children[0];
  view.load([message('m1', '好'), message('m2', '好')]);
  assert.equal(container.children[0], original);
  assert.equal(container.children.length, 2);
});

test('history refresh restores an older reading position when DOM replacement resets scroll', () => {
  const { view, container } = fixture();
  const replaceChildren = container.replaceChildren.bind(container);
  container.replaceChildren = (...rows) => { replaceChildren(...rows); container.scrollTop = 0; };
  container.scrollHeight = 1000;
  container.clientHeight = 100;
  container.scrollTop = 240;
  view.load([message('old'), message('new')]);
  assert.equal(container.scrollTop, 240);
});

test('a full 32-message window keeps the same visible message when its oldest row rotates out', () => {
  const { view, container } = fixture();
  container.clientHeight = 100;
  container.getBoundingClientRect = () => ({ top: 0, bottom: 100 });
  container.ownerDocument.createElement = () => ({
    dataset: {}, textContent: '',
    getBoundingClientRect() {
      const top = container.children.indexOf(this) * 40 - container.scrollTop;
      return { top, bottom: top + 40 };
    },
  });
  container.replaceChildren = (...rows) => {
    container.children = rows;
    container.scrollHeight = rows.length * 40;
    container.scrollTop = 0;
  };
  const ids = Array.from({ length: 32 }, (_, index) => `m${index + 1}`);
  view.load(ids.map(id => message(id)));
  container.scrollTop = 200;
  const firstVisible = () => container.children.find(row => row.getBoundingClientRect().bottom > 0);
  assert.equal(firstVisible().dataset.messageId, 'm6');
  view.load([...ids.slice(1), 'm33'].map(id => message(id)));
  assert.equal(firstVisible().dataset.messageId, 'm6');
  assert.equal(firstVisible().getBoundingClientRect().top, 0);
});
