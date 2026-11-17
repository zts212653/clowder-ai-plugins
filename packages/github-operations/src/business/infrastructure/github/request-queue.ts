/** How long a finished native request keeps the lane for its caller's next dependent request. A
 * registration reads ~11 requests one after another and only parses in between (a few ms locally,
 * plus a Worker round trip in the Host); without this, a queued collector took every gap. */
export const NATIVE_CHAIN_GRACE_MS = 250;

/** One owned request at a time. Native calls may pass queued collectors, but
 * at most four interactive requests pass a waiting background request. A native
 * call's dependent follow-up within the grace counts as the same burst step. */
export class GitHubRequestQueue {
  private running = false;
  private interactiveBurst = 0;
  private lastWasInteractive = false;
  private hold: ReturnType<typeof setTimeout> | undefined;
  private readonly interactive: (() => void)[] = [];
  private readonly background: (() => void)[] = [];

  constructor(private readonly idle: () => void) {}

  enqueue<T>(operation: () => Promise<T>, interactive: boolean): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      (interactive ? this.interactive : this.background).push(() => {
        void Promise.resolve().then(operation).then(
          value => { resolve(value); this.advance(); },
          error => { reject(error); this.advance(); },
        );
      });
      // A collector arriving during a hold waits for that hold's original deadline.
      if (!this.running && (interactive || this.hold === undefined)) this.advance();
    });
  }

  private advance(allowHold = true): void {
    const continuation = this.hold !== undefined;
    if (this.hold) { clearTimeout(this.hold); this.hold = undefined; }
    const preferInteractive = this.interactive.length > 0 &&
      (this.background.length === 0 || this.interactiveBurst < 4);
    if (allowHold && !preferInteractive && this.lastWasInteractive && this.interactiveBurst < 4 &&
      this.interactive.length === 0 && this.background.length > 0) {
      this.running = false;
      this.hold = setTimeout(() => { this.hold = undefined; if (!this.running) this.advance(false); }, NATIVE_CHAIN_GRACE_MS);
      return;
    }
    const next = (preferInteractive ? this.interactive : this.background).shift();
    if (!next) {
      this.running = false; this.interactiveBurst = 0; this.lastWasInteractive = false; this.idle();
      return;
    }
    this.running = true;
    this.interactiveBurst = !preferInteractive ? 0 : continuation ? this.interactiveBurst : this.interactiveBurst + 1;
    this.lastWasInteractive = preferInteractive;
    next();
  }
}
