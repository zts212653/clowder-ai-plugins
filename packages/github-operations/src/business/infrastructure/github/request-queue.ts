/** One owned request at a time. Native calls may pass queued collectors, but
 * at most four interactive requests pass a waiting background request. */
export class GitHubRequestQueue {
  private running = false;
  private interactiveBurst = 0;
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
      if (!this.running) this.advance();
    });
  }

  private advance(): void {
    const preferInteractive = this.interactive.length > 0 &&
      (this.background.length === 0 || this.interactiveBurst < 4);
    const next = (preferInteractive ? this.interactive : this.background).shift();
    if (!next) {
      this.running = false; this.interactiveBurst = 0; this.idle();
      return;
    }
    this.running = true;
    this.interactiveBurst = preferInteractive ? this.interactiveBurst + 1 : 0;
    next();
  }
}
