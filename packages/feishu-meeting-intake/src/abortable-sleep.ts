export function abortableSleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<void>((resolve, reject) => {
    const onElapsed = (): void => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    };
    const timer = setTimeout(onElapsed, milliseconds);
    const onAbort = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      reject(signal.reason);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    void Promise.resolve().then(() => {
      if (signal.aborted) onAbort();
    });
  });
}
