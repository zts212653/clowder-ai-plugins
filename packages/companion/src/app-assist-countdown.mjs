import { APP_ASSIST_TIMEOUT_MS } from './app-assist-controller.mjs';

/** Projects the existing renderer deadline without owning or extending it. */
export function bindAppAssistCountdown(element, durationMs = APP_ASSIST_TIMEOUT_MS) {
  let offerRef = null;
  element.style.setProperty('--app-assist-duration', `${durationMs}ms`);
  return offer => {
    const nextRef = offer?.offerRef ?? null;
    if (nextRef === offerRef) return;
    offerRef = nextRef;
    element.removeAttribute('data-active');
    if (!nextRef) return;
    void element.getBoundingClientRect?.();
    element.setAttribute('data-active', 'true');
  };
}
