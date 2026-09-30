const sameValue = (left, right) => Object.is(left, right);
const canStopCall = field => ['dutyCatProfileId', 'householdReadsAllowed'].includes(field);

/**
 * Renderer-side settings state only. The Host remains the single source of
 * persisted values, roster truth, media stopping and plugin lifecycle.
 */
export class SettingsController {
  constructor({ client, changed = () => {} }) {
    this.client = client;
    this.changed = changed;
    this.readOperation = 0;
    this.writeOperation = 0;
    this.state = { phase: 'idle', page: 'main', saving: false, notice: null, confirmation: null, retry: null };
  }

  publish(patch = {}) {
    this.state = { ...this.state, ...patch };
    this.changed(this.state);
  }

  applySettings(reply, patch = {}) {
    if (reply?.kind !== 'settings' || reply.status !== 'available') return false;
    this.publish({
      phase: this.state.saving ? 'saving' : 'ready',
      values: reply.values,
      companions: reply.companions,
      selectedCompanionStatus: reply.selectedCompanionStatus,
      ...patch,
    });
    return true;
  }

  async load({ preserveSettlement = false } = {}) {
    // A panel reopen is presentation work, not authority to cancel an in-flight
    // write. The write performs its own canonical readback before settlement.
    if (this.state.saving) return false;
    const operation = ++this.readOperation;
    this.publish({ phase: 'loading', ...(preserveSettlement ? {} : { notice: null, retry: null }) });
    try {
      const reply = await this.client.readSettings();
      if (operation !== this.readOperation) return false;
      const clearsUnknown = preserveSettlement && this.state.notice?.kind === 'unconfirmed';
      if (this.applySettings(reply, clearsUnknown ? { notice: null, retry: null } : {})) return true;
      this.publish({ phase: 'unavailable', reason: reply.reason, saving: false });
    } catch (error) {
      if (operation !== this.readOperation) return false;
      this.publish({ phase: 'unavailable', saving: false,
        reason: error?.code === 'invalid_request' ? 'host_upgrade_required' : 'temporarily_unavailable' });
    }
    return false;
  }

  navigate(page) {
    this.publish({ page, confirmation: null });
  }

  async requestUpdate(field, value, { confirm = false } = {}) {
    if (this.state.saving || sameValue(this.state.values?.[field], value)) return false;
    if (confirm) {
      this.publish({ page: 'confirm',
        confirmation: { kind: 'setting', field, value, returnPage: this.state.page },
        notice: null, retry: null });
      return true;
    }
    await this.commitUpdate(field, value, this.state.page);
    return true;
  }

  async readCanonical(operation) {
    try {
      const reply = await this.client.readSettings();
      if (operation !== this.writeOperation || reply?.kind !== 'settings' || reply.status !== 'available') return null;
      return reply;
    } catch { return null; }
  }

  async commitUpdate(field, value, returnPage = this.state.page) {
    if (this.state.saving) return { callStopped: null };
    const operation = ++this.writeOperation;
    this.publish({ phase: 'saving', saving: true, notice: null, retry: null });
    let receipt;
    try {
      receipt = await this.client.updateSetting(field, value);
    } catch {
      if (operation !== this.writeOperation) return { callStopped: null };
      const canonical = await this.readCanonical(operation);
      if (operation !== this.writeOperation) return { callStopped: null };
      if (canonical) this.applySettings(canonical);
      const saved = canonical && sameValue(canonical.values[field], value);
      const callStopped = canStopCall(field) ? null : false;
      this.publish({ phase: canonical ? 'ready' : this.state.values ? 'ready' : 'unavailable', saving: false,
        page: returnPage, confirmation: null,
        retry: canonical && !saved ? { field, value } : null,
        notice: canonical
          ? { kind: saved ? 'reconciled_saved' : 'reconciled_not_saved', field, callStopped }
          : { kind: 'unconfirmed', field, callStopped } });
      return { callStopped };
    }
    if (operation !== this.writeOperation) return { callStopped: null };
    const canonical = await this.readCanonical(operation);
    if (operation !== this.writeOperation) return { callStopped: null };
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
      page: returnPage, confirmation: null, notice, retry });
    return { callStopped };
  }

  async confirm() {
    const confirmation = this.state.confirmation;
    if (!confirmation || this.state.saving) return { callStopped: null };
    if (confirmation.kind === 'setting') {
      return this.commitUpdate(confirmation.field, confirmation.value, confirmation.returnPage);
    }
    const operation = ++this.writeOperation;
    this.publish({ phase: 'saving', saving: true, notice: null });
    try {
      await this.client.disableCompanion();
      if (operation !== this.writeOperation) return { callStopped: null };
      this.publish({ phase: 'disabled', saving: false, confirmation: null });
      return { callStopped: true };
    } catch {
      if (operation !== this.writeOperation) return { callStopped: null };
      this.publish({ phase: this.state.values ? 'ready' : 'unavailable', saving: false,
        page: confirmation.returnPage, confirmation: null, notice: { kind: 'disable_failed' } });
      return { callStopped: null };
    }
  }

  requestDisable() {
    if (this.state.saving) return;
    this.publish({ page: 'disable', confirmation: { kind: 'disable', returnPage: this.state.page }, notice: null });
  }

  async retry({ confirm = false } = {}) {
    const retry = this.state.retry;
    if (!retry || this.state.saving) return;
    if (confirm && canStopCall(retry.field)) {
      this.publish({ page: 'confirm',
        confirmation: { kind: 'setting', field: retry.field, value: retry.value, returnPage: this.state.page } });
      return;
    }
    await this.commitUpdate(retry.field, retry.value, this.state.page);
  }

  async resetPosition() {
    if (this.state.saving) return;
    try {
      await this.client.resetPosition();
      this.publish({ notice: { kind: 'position_reset' } });
    } catch { this.publish({ notice: { kind: 'position_reset_failed' } }); }
  }
}
