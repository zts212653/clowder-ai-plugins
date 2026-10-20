/** Last observed socket reachability; timestamps are epoch milliseconds. */
export type HelperConnectionStatus =
  | { readonly state: 'unknown' }
  | { readonly state: 'connected'; readonly lastContactAt: number }
  | { readonly state: 'invalid_installation'; readonly since: number; readonly guidance: string }
  | {
      readonly state: 'unreachable' | 'not_installed';
      readonly since: number;
      readonly consecutiveFailures: number;
      readonly nextListAttemptAt: number;
      readonly guidance: string;
    };

export type HelperConnectionLog = (level: 'warn' | 'info', message: string) => void;

/** The Host's generic status renderer displays label, not arbitrary data fields. */
export function describeHelperConnection(status: HelperConnectionStatus): string {
  switch (status.state) {
    case 'unknown':
      return 'Helper: unknown (not checked since start). Run Test for a live check.';
    case 'connected':
      return `Helper: connected (last contact ${new Date(status.lastContactAt).toISOString()}). Run Test for a live check.`;
    case 'invalid_installation':
      return `Helper: invalid_installation since ${new Date(status.since).toISOString()}. ${status.guidance}`;
    case 'not_installed':
    case 'unreachable':
      return `Helper: ${status.state} since ${new Date(status.since).toISOString()}; ` +
        `${status.consecutiveFailures} consecutive failure(s); ` +
        `next list attempt no earlier than ${new Date(status.nextListAttemptAt).toISOString()}. ${status.guidance}`;
  }
}

/** No timers or I/O: Host polls supply the occasions to retry. */
export class HelperReachability {
  private current: HelperConnectionStatus = { state: 'unknown' };

  constructor(
    private readonly now: () => number,
    private readonly log?: HelperConnectionLog,
  ) {}

  snapshot(): HelperConnectionStatus {
    return { ...this.current };
  }

  canList(): boolean {
    return !('nextListAttemptAt' in this.current) || this.now() >= this.current.nextListAttemptAt;
  }

  connected(): void {
    this.transition({ state: 'connected', lastContactAt: this.now() });
  }

  invalidInstallation(): void {
    this.transition({
      state: 'invalid_installation',
      since: this.current.state === 'invalid_installation' ? this.current.since : this.now(),
      guidance: 'The helper installation is broken: pairing record validation failed. ' +
        'Open Settings > Personal Chrome > Chrome connection to repair the installation, then run Test.',
    });
  }

  unavailable(state: 'unreachable' | 'not_installed'): void {
    const now = this.now();
    const previous = this.current;
    const failures = 'consecutiveFailures' in previous ? previous.consecutiveFailures + 1 : 1;
    // Cap the exponent as well as the interval, even after a long outage.
    const delay = Math.min(60_000, 2_000 * 2 ** Math.min(failures - 1, 5));
    this.transition({
      state,
      since: 'since' in previous && previous.state === state ? previous.since : now,
      consecutiveFailures: failures,
      nextListAttemptAt: now + delay,
      guidance: state === 'not_installed'
        ? 'Open Settings > Personal Chrome > Chrome connection to install the helper and load the extension, then run Test.'
        : 'Check that Chrome and the personal Chrome extension are running, then run Test to retry now.',
    });
  }

  reset(): void {
    this.current = { state: 'unknown' };
  }

  private transition(next: Exclude<HelperConnectionStatus, { state: 'unknown' }>): void {
    const changed = this.current.state !== next.state;
    this.current = next;
    if (!changed) return;
    // Fixed messages only: never include pairing contents, paths, or raw errors.
    try {
      this.log?.(
        next.state === 'connected' ? 'info' : 'warn',
        `Personal Chrome helper connection: ${next.state}`,
      );
    } catch {
      // Diagnostics must not throw from a socket event or change a wire result.
    }
  }
}
