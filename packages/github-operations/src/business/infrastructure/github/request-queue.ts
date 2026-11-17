/** How long a finished native request keeps the lane for the same native action's next dependent
 * request. A registration reads ~11 requests one after another and only parses in between (a few ms
 * locally, plus a Worker round trip in the Host); without this, a queued collector took every gap. */
export const NATIVE_CHAIN_GRACE_MS = 250;

/** Identity of one native action (one `withInteractiveGitHubRequests` scope). */
export type NativeChain = object;

interface QueuedRequest {
  readonly run: () => void;
  readonly chain?: NativeChain;
}

/** One owned request at a time. Native calls may pass queued collectors, but
 * at most four interactive requests pass a waiting background request. Only the
 * same native action's next request counts as a continuation of its burst step;
 * independent calls count individually however closely they arrive. */
export class GitHubRequestQueue {
  private running = false;
  private interactiveBurst = 0;
  /** Chain of the request that ran last, while that request was a chained native request. */
  private lastChain: NativeChain | undefined;
  private hold: ReturnType<typeof setTimeout> | undefined;
  private readonly interactive: QueuedRequest[] = [];
  private readonly background: QueuedRequest[] = [];

  constructor(private readonly idle: () => void) {}

  enqueue<T>(operation: () => Promise<T>, interactive: boolean, chain?: NativeChain): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const run = () => {
        void Promise.resolve().then(operation).then(
          value => { resolve(value); this.advance(); },
          error => { reject(error); this.advance(); },
        );
      };
      (interactive ? this.interactive : this.background).push({ run, ...(interactive && chain ? { chain } : {}) });
      // A collector arriving during a hold waits for that hold's original deadline.
      if (!this.running && (interactive || this.hold === undefined)) this.advance();
    });
  }

  private advance(allowHold = true): void {
    if (this.hold) { clearTimeout(this.hold); this.hold = undefined; }
    const preferInteractive = this.interactive.length > 0 &&
      (this.background.length === 0 || this.interactiveBurst < 4);
    if (allowHold && !preferInteractive && this.lastChain && this.interactiveBurst < 4 &&
      this.interactive.length === 0 && this.background.length > 0) {
      this.running = false;
      this.hold = setTimeout(() => { this.hold = undefined; if (!this.running) this.advance(false); }, NATIVE_CHAIN_GRACE_MS);
      return;
    }
    const next = (preferInteractive ? this.interactive : this.background).shift();
    if (!next) {
      this.running = false; this.interactiveBurst = 0; this.lastChain = undefined; this.idle();
      return;
    }
    this.running = true;
    const continuation = preferInteractive && next.chain !== undefined && next.chain === this.lastChain;
    this.interactiveBurst = !preferInteractive ? 0 : continuation ? this.interactiveBurst : this.interactiveBurst + 1;
    this.lastChain = preferInteractive ? next.chain : undefined;
    next.run();
  }
}
