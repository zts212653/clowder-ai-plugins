import { ChatGptPageAdapterError } from './chatgpt-page-contract.mjs';

export const SEND_BUTTON_SELECTORS = [
  'button[data-testid="send-button"]',
  'button[aria-label="Send prompt"]',
  'button[aria-label="发送提示"]',
];
export const FORM_SEND_BUTTON_SELECTORS = ['button[type="submit"]', ...SEND_BUTTON_SELECTORS];

function uniqueSendButton(document, composer) {
  if (!composer.isConnected) {
    throw new ChatGptPageAdapterError('SEND_BUTTON_INVALID', 'ChatGPT composer is no longer connected');
  }
  const form = composer.closest('form');
  const scope = form ?? document;
  // Current forms expose a submit control without the older labels/test ID.
  // Only the explicit legacy identities are supported outside a form.
  const selectors = form ? FORM_SEND_BUTTON_SELECTORS : SEND_BUTTON_SELECTORS;
  const candidates = [...scope.querySelectorAll(selectors.join(','))].filter(
    (button) => !form || button.form === form,
  );
  if (candidates.length > 1) {
    throw new ChatGptPageAdapterError('SEND_BUTTON_INVALID', 'ChatGPT composer has ambiguous send controls');
  }
  return candidates[0] ?? null;
}

function sendButtonIsDisabled(button) {
  return button.disabled === true || button.getAttribute('aria-disabled') === 'true';
}

export function assertCurrentSendButton({ document, composer, sendButton }) {
  if (
    !sendButton.isConnected ||
    typeof sendButton.click !== 'function' ||
    uniqueSendButton(document, composer) !== sendButton
  ) {
    throw new ChatGptPageAdapterError('SEND_BUTTON_INVALID', 'ChatGPT send control changed before submission');
  }
  if (sendButtonIsDisabled(sendButton)) {
    throw new ChatGptPageAdapterError('SEND_BUTTON_DISABLED', 'ChatGPT send button changed before submission');
  }
}

export function waitForSendButton({ document, composer, MutationObserver, timeoutMs }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let sawDisabledButton = false;
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      observer.disconnect();
      callback();
    };
    const scan = () => {
      if (settled) return;
      try {
        const button = uniqueSendButton(document, composer);
        if (!button) return;
        if (typeof button.click !== 'function' || !button.isConnected) {
          throw new ChatGptPageAdapterError('SEND_BUTTON_INVALID', 'ChatGPT send button is not safely clickable');
        }
        if (sendButtonIsDisabled(button)) {
          sawDisabledButton = true;
          return;
        }
        finish(() => resolve(button));
      } catch (error) {
        finish(() => reject(error));
      }
    };
    const observer = new MutationObserver(scan);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['disabled', 'aria-disabled', 'type', 'aria-label', 'data-testid', 'form', 'id'],
    });
    const timer = setTimeout(() => {
      finish(() => reject(new ChatGptPageAdapterError(
        sawDisabledButton ? 'SEND_BUTTON_DISABLED' : 'SEND_BUTTON_NOT_FOUND',
        sawDisabledButton ? 'ChatGPT send button remained disabled' : 'ChatGPT send button was not found',
      )));
    }, timeoutMs);
    scan();
  });
}
