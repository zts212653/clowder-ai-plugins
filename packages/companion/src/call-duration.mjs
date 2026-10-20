function formatDuration(elapsedMs) {
  const seconds = Math.max(0, Math.floor(elapsedMs / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  const clock = `${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`;
  return hours ? `${hours}:${clock}` : clock;
}

/** Presentation clock anchored only after the current media connection is confirmed. */
export class CallDuration {
  constructor(node, {
    now = Date.now,
    schedule = callback => {
      const handle = setInterval(callback, 1000);
      handle.unref?.();
      return handle;
    },
    cancel = handle => clearInterval(handle),
  } = {}) {
    Object.assign(this, { node, now, schedule, cancel });
    this.startedAt = null;
    this.timer = undefined;
  }

  set(startedAt) {
    startedAt = Number.isFinite(startedAt) ? startedAt : null;
    if (startedAt === this.startedAt) {
      if (startedAt !== null) this.render();
      return;
    }
    this.clear();
    this.startedAt = startedAt;
    this.node.hidden = startedAt === null;
    if (startedAt === null) {
      this.node.textContent = '';
      return;
    }
    this.render();
    this.timer = this.schedule(() => this.render());
  }

  render() {
    if (this.startedAt === null) return;
    this.node.textContent = formatDuration(this.now() - this.startedAt);
  }

  clear() {
    if (this.timer === undefined) return;
    this.cancel(this.timer);
    this.timer = undefined;
  }

  close() {
    this.clear();
  }
}

export { formatDuration };
