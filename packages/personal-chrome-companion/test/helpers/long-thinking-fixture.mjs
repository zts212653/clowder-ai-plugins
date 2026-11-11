import { JSDOM } from 'jsdom';

export function fixture({ modern = false, stableId = true } = {}) {
  const dom = new JSDOM('<main></main><div id="prompt-textarea" contenteditable="true"></div><button data-testid="send-button">Send</button>', { url: 'https://chatgpt.com/c/conversation-7' });
  const document = dom.window.document;
  const composer = document.querySelector('#prompt-textarea');
  document.execCommand = (command, _ui, value) => {
    if (command !== 'insertText') return false;
    composer.textContent = value;
    return true;
  };
  let sends = 0;
  document.querySelector('button').addEventListener('click', () => {
    sends += 1;
    const turn = document.createElement('article');
    if (stableId) turn.dataset.testid = 'conversation-turn-user-1';
    const message = document.createElement('div');
    if (modern) message.dataset.userMessageBubble = 'true';
    else message.dataset.messageAuthorRole = 'user';
    message.textContent = composer.textContent;
    turn.append(message);
    document.querySelector('main').append(turn);
    composer.replaceChildren();
  });
  return { dom, document, get sends() { return sends; } };
}
