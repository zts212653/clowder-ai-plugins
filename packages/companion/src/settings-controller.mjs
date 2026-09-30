const sameValue = (left, right) => Object.is(left, right);

/**
 * Renderer-side settings state only. The Host remains the single source of
 * persisted values, roster truth, media stopping and plugin lifecycle.
 */
export class SettingsController {
  constructor({ client, changed = () => {} }) {
    this.client = client;
    this.changed = changed;
    this.operation = 0;
    this.state = { phase: 'idle', page: 'main', saving: false, notice: null, confirmation: null, retry: null };
  }

  publish(patch = {}) {
    this.state = { ...this.state, ...patch };
    this.changed(this.state);
  }

  applySettings(reply, patch = {}) {
    if (reply?.kind !== 'settings' || reply.status !== 'available') return false;
    this.publish({
      phase: 'ready',
      values: reply.values,
      companions: reply.companions,
      selectedCompanionStatus: reply.selectedCompanionStatus,
      ...patch,
    });
    return true;
  }

  async load() {
    const operation = ++this.operation;
    this.publish({ phase: 'loading', notice: null, retry: null });
    try {
      const reply = await this.client.readSettings();
      if (operation !== this.operation) return;
      if (this.applySettings(reply)) return;
      this.publish({ phase: 'unavailable', reason: reply.reason, saving: false });
    } catch (error) {
      if (operation !== this.operation) return;
      this.publish({ phase: 'unavailable', saving: false,
        reason: error?.code === 'invalid_request' ? 'host_upgrade_required' : 'temporarily_unavailable' });
    }
  }

  navigate(page) {
    this.publish({ page, confirmation: null, notice: null });
  }

  async requestUpdate(field, value, { confirm = false } = {}) {
    if (this.state.saving || sameValue(this.state.values?.[field], value)) return false;
    if (confirm) {
      this.publish({ page: 'confirm', confirmation: { kind: 'setting', field, value }, notice: null });
      return true;
    }
    await this.commitUpdate(field, value);
    return true;
  }

  async readCanonical(operation) {
    try {
      const reply = await this.client.readSettings();
      if (operation !== this.operation || reply?.kind !== 'settings' || reply.status !== 'available') return null;
      return reply;
    } catch { return null; }
  }

  async commitUpdate(field, value) {
    if (this.state.saving) return;
    const operation = ++this.operation;
    this.publish({ phase: 'saving', saving: true, notice: null, retry: null });
    let receipt;
    try {
      receipt = await this.client.updateSetting(field, value);
    } catch {
      if (operation !== this.operation) return;
      const canonical = await this.readCanonical(operation);
      if (operation !== this.operation) return;
      if (canonical) this.applySettings(canonical);
      const saved = canonical && sameValue(canonical.values[field], value);
      this.publish({ phase: canonical ? 'ready' : this.state.values ? 'ready' : 'unavailable', saving: false,
        page: 'main', confirmation: null,
        retry: canonical && !saved ? { field, value } : null,
        notice: canonical
          ? { kind: saved ? 'reconciled_saved' : 'reconciled_not_saved', field, callStopped: false }
          : { kind: 'unconfirmed', field, callStopped: false } });
      return;
    }
    if (operation !== this.operation) return;
    const canonical = await this.readCanonical(operation);
    if (operation !== this.operation) return;
    if (canonical) this.applySettings(canonical);
    const callStopped = receipt.callStatus === 'stopped';
    let notice;
    if (receipt.outcome === 'saved') {
      notice = { kind: 'saved', field, callStopped, applies: receipt.applies };
    } else if (receipt.outcome === 'rejected') {
      notice = { kind: 'rejected', field, callStopped, reason: receipt.reason };
    } else if (!canonical) {
      notice = { kind: 'unconfirmed', field, callStopped };
    } else {
      notice = {
        kind: sameValue(canonical.values[field], value) ? 'reconciled_saved' : 'reconciled_not_saved',
        field,
        callStopped,
      };
    }
    const retry = (receipt.outcome === 'rejected' && ['save_failed', 'call_stop_failed'].includes(receipt.reason))
      || (receipt.outcome === 'unconfirmed' && canonical && !sameValue(canonical.values[field], value))
      ? { field, value } : null;
    this.publish({ phase: canonical ? 'ready' : this.state.values ? 'ready' : 'unavailable', saving: false,
      page: 'main', confirmation: null, notice, retry });
  }

  async confirm() {
    const confirmation = this.state.confirmation;
    if (!confirmation || this.state.saving) return;
    if (confirmation.kind === 'setting') {
      await this.commitUpdate(confirmation.field, confirmation.value);
      return;
    }
    const operation = ++this.operation;
    this.publish({ phase: 'saving', saving: true, notice: null });
    try {
      await this.client.disableCompanion();
      if (operation === this.operation) this.publish({ phase: 'disabled', saving: false, confirmation: null });
    } catch {
      if (operation === this.operation) this.publish({ phase: this.state.values ? 'ready' : 'unavailable', saving: false,
        confirmation: null, notice: { kind: 'disable_failed' } });
    }
  }

  requestDisable() {
    if (this.state.saving) return;
    this.publish({ page: 'disable', confirmation: { kind: 'disable' }, notice: null });
  }

  async retry() {
    const retry = this.state.retry;
    if (!retry || this.state.saving) return;
    await this.commitUpdate(retry.field, retry.value);
  }

  async resetPosition() {
    if (this.state.saving) return;
    try {
      await this.client.resetPosition();
      this.publish({ notice: { kind: 'position_reset' } });
    } catch { this.publish({ notice: { kind: 'position_reset_failed' } }); }
  }
}
