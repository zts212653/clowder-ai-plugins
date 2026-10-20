/** Original activation-time sync and two-second polling. The package owns this
 * lifecycle, not a new Host scheduler or persisted execution protocol. */
export function startCollectiveBackgroundSync(sync: () => Promise<void>) {
  let stopped = false;
  let pending: Promise<void> | undefined;
  const run = () => {
    if (stopped || pending) return pending;
    pending = sync().catch(() => undefined).finally(() => {pending = undefined;});
    return pending;
  };
  const timer = setInterval(() => {void run();}, 2_000);
  timer.unref();
  void run();
  return async () => {stopped = true;clearInterval(timer);await pending;};
}
