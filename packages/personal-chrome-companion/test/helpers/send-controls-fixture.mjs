import { JSDOM } from 'jsdom';
import { createChatGptPageAdapter } from '../../extension/chatgpt-page-adapter.mjs';

export function sendControlsFixture({ form = true, outsideLegacy = false, render, afterSelection } = {}) {
  const container = form ? 'form' : 'div';
  const dom = new JSDOM(`<!doctype html><main id="messages"></main><${container} id="controls"><div id="prompt-textarea" class="ProseMirror" contenteditable="true"><p></p></div></${container}>`, {
    url: 'https://chatgpt.com/c/send-controls-fixture',
    pretendToBeVisual: true,
  });
  const { document } = dom.window;
  const composer = document.querySelector('#prompt-textarea');
  const controls = document.querySelector('#controls');
  const clicks = [];
  function button(attributes = { type: 'submit', 'aria-label': '发送' }, parent = controls) {
    const element = document.createElement('button');
    for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value);
    element.addEventListener('click', (event) => {
      event.preventDefault();
      clicks.push(element);
      const message = document.createElement('article');
      message.dataset.messageAuthorRole = 'user';
      message.dataset.messageId = 'fixture-host-message';
      message.textContent = composer.textContent;
      document.querySelector('#messages').append(message);
      composer.replaceChildren();
    });
    parent.append(element);
    return element;
  }
  const foreign = outsideLegacy ? button({ 'data-testid': 'send-button', type: 'button' }, document.body) : null;
  const initial = button({ type: 'button', 'aria-label': '开始语音' });
  composer.addEventListener('input', (event) => {
    if (event.inputType !== 'insertText') return;
    if (render) render({ document, composer, controls, button, initial });
    else { initial.remove(); button(); }
  });
  document.execCommand = (command, _showUi, value) => {
    if (command === 'insertText') {
      const paragraph = document.createElement('p');
      paragraph.textContent = value;
      composer.replaceChildren(paragraph);
      composer.dispatchEvent(new dom.window.InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: value }));
      return true;
    }
    if (command === 'delete') { composer.replaceChildren(); return true; }
    return false;
  };
  if (afterSelection) {
    const query = controls.querySelectorAll.bind(controls);
    let queued = false;
    controls.querySelectorAll = (selector) => {
      const result = query(selector);
      if (!queued && [...result].some((candidate) => candidate.type === 'submit')) {
        queued = true;
        queueMicrotask(() => afterSelection({ document, controls, button }));
      }
      return result;
    };
  }
  const adapter = createChatGptPageAdapter({ document, location: dom.window.location, MutationObserver: dom.window.MutationObserver, sendButtonTimeoutMs: 100, observationTimeoutMs: 100 });
  return { dom, document, composer, controls, clicks, foreign, adapter };
}

export const appendRequest = {
  requestId: 'send-control-request', conversationId: 'send-controls-fixture',
  text: 'offline send-control fixture', idempotencyKey: 'send-control-source',
};
