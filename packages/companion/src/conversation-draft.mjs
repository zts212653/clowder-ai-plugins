const receiptFingerprint = receipt => [
  receipt.delivery,
  receipt.messageId ?? '',
  receipt.reason ?? '',
  receipt.draftRevision ?? '',
].join('\u0000');

const copySubmission = submission => ({
  clientMessageId: submission.clientMessageId,
  text: submission.text,
  submissionRevision: submission.submissionRevision,
  receipt: { ...submission.receipt },
});

/**
 * Renderer coordinator for the Host-owned composer draft.
 *
 * It keeps the current local edit separate from the last canonical Host text.
 * Reads may reconcile receipts, but only submit() and retry() can send text.
 */
export class HostConversationDraft {
  constructor({ client, changed = () => {}, delivery = () => {}, invalidated = () => {},
    uuid = () => crypto.randomUUID(), schedule = setTimeout, cancel = clearTimeout,
    debounceMs = 180 }) {
    Object.assign(this, { client, changed, delivery, invalidated, uuid, debounceMs });
    this.schedule = (...args) => Reflect.apply(schedule, globalThis, args);
    this.cancel = (...args) => Reflect.apply(cancel, globalThis, args);
    this.scopeRef = null;
    this.revision = null;
    this.canonicalText = '';
    this.localText = '';
    this.localVersion = 0;
    this.localEdited = false;
    this.writable = false;
    this.status = 'loading';
    this.submissions = new Map();
    this.reportedReceipts = new Map();
  }

  snapshot() {
    return {
      scopeRef: this.scopeRef,
      revision: this.revision,
      canonicalText: this.canonicalText,
      localText: this.localText,
      writable: this.writable,
      status: this.status,
      submissions: [...this.submissions.values()].map(copySubmission),
    };
  }

  canonicalReply() {
    if (this.scopeRef === null || this.revision === null) return null;
    return {
      kind: 'conversation-draft', v: 1, status: 'available', scopeRef: this.scopeRef,
      revision: this.revision, text: this.canonicalText, writable: this.writable,
      submissions: [...this.submissions.values()].map(copySubmission),
    };
  }

  emit() { this.changed(this.snapshot()); }

  update(text) {
    this.localText = text;
    this.localEdited = true;
    ++this.localVersion;
    if (!['scope_changed', 'readonly'].includes(this.status)) this.status = 'editing';
    this.emit();
    if (this.saveTimer !== undefined) this.cancel(this.saveTimer);
    this.saveTimer = this.schedule(() => {
      this.saveTimer = undefined;
      void this.save();
    }, this.debounceMs);
    this.saveTimer?.unref?.();
  }

  async load(options = {}) {
    if (this.loading) return this.loading;
    const operation = this.loadOnce(options);
    this.loading = operation;
    try { return await operation; }
    finally { if (this.loading === operation) this.loading = undefined; }
  }

  async loadOnce({ preserveStatus = null } = {}) {
    try {
      const response = await this.client.readConversationDraft();
      if (response.status !== 'available') {
        this.revision = response.revision;
        this.writable = false;
        this.status = response.status;
        this.emit();
        return response;
      }
      if (response.scopeRef === this.scopeRef && this.revision !== null
        && response.revision < this.revision) return response;
      const scopeChanged = this.scopeRef !== null && this.scopeRef !== response.scopeRef;
      const previousCanonical = this.canonicalText;
      const previousSubmissions = [...this.submissions.values()];
      if (scopeChanged) {
        const unconfirmed = previousSubmissions.filter(value => value.receipt.delivery === 'unconfirmed');
        const latest = unconfirmed.at(-1);
        if (latest && (!this.localEdited || this.localText === previousCanonical)) {
          this.localText = latest.text;
          this.localEdited = true;
          ++this.localVersion;
        }
        for (const submission of unconfirmed) this.invalidated({
          ...copySubmission(submission), scopeRef: this.scopeRef, reason: 'scope_changed',
        });
        this.reportedReceipts.clear();
      } else if (!this.localEdited || this.localText === previousCanonical) {
        this.localText = response.text;
        this.localEdited = false;
      }
      this.scopeRef = response.scopeRef;
      this.revision = response.revision;
      this.canonicalText = response.text;
      this.writable = response.writable;
      this.submissions = new Map(response.submissions.map(value => [value.clientMessageId, copySubmission(value)]));
      this.status = scopeChanged ? 'scope_changed'
        : preserveStatus ?? (response.writable ? 'ready' : 'readonly');
      for (const submission of this.submissions.values()) this.report(submission);
      this.emit();
      if (!scopeChanged) await this.reconcileUnconfirmed();
      return response;
    } catch (error) {
      this.status = error?.code ?? 'unavailable';
      this.emit();
      return null;
    }
  }

  report(submission, restored = true) {
    const key = `${this.scopeRef}\u0000${submission.clientMessageId}`;
    const fingerprint = receiptFingerprint(submission.receipt);
    if (this.reportedReceipts.get(key) === fingerprint) return;
    this.reportedReceipts.set(key, fingerprint);
    this.delivery({ ...copySubmission(submission), scopeRef: this.scopeRef, restored });
  }

  async reconcileUnconfirmed() {
    const scopeRef = this.scopeRef;
    for (const submission of [...this.submissions.values()]) {
      if (submission.receipt.delivery !== 'unconfirmed' || scopeRef !== this.scopeRef) continue;
      try {
        const receipt = await this.client.readConversationDelivery(submission.clientMessageId, scopeRef);
        if (scopeRef !== this.scopeRef) return;
        const updated = { ...submission, receipt };
        if (receipt.delivery !== 'rejected') this.submissions.set(submission.clientMessageId, updated);
        this.report(updated);
      } catch (error) {
        if (error?.code === 'invalid_request' && scopeRef !== this.scopeRef) return;
        this.status = error?.code ?? 'unavailable';
      }
    }
    this.emit();
  }

  async save() {
    if (this.saving) {
      this.saveAgain = true;
      return this.saving;
    }
    const operation = (async () => {
      let result;
      do {
        this.saveAgain = false;
        result = await this.saveOnce();
      } while (this.saveAgain);
      return result;
    })();
    this.saving = operation;
    try { return await operation; }
    finally { if (this.saving === operation) this.saving = undefined; }
  }

  async saveOnce() {
    if (this.scopeRef === null) await this.load();
    const text = this.localText;
    const version = this.localVersion;
    if (this.scopeRef === null || this.revision === null) return null;
    if (!this.writable || text.length > 8000) {
      this.status = 'readonly';
      this.emit();
      return null;
    }
    if (text === this.canonicalText) return this.canonicalReply();
    const expectedRevision = this.revision;
    const scopeRef = this.scopeRef;
    this.status = 'saving';
    this.emit();
    try {
      const response = await this.client.saveConversationDraft(expectedRevision, text, scopeRef);
      if (response.status !== 'available') {
        this.revision = response.revision;
        this.status = response.status;
        this.emit();
        await this.load({ preserveStatus: response.status });
        return response;
      }
      if (response.scopeRef !== scopeRef) {
        await this.load({ preserveStatus: 'scope_changed' });
        return null;
      }
      if (this.revision !== null && response.revision < this.revision) return this.canonicalReply();
      const preserveStatus = version === this.localVersion ? 'ready' : 'editing';
      this.applySaved(response, preserveStatus);
      return response;
    } catch (error) {
      this.status = error?.code ?? 'unavailable';
      this.emit();
      return null;
    }
  }

  applySaved(response, status) {
    this.scopeRef = response.scopeRef;
    this.revision = response.revision;
    this.canonicalText = response.text;
    this.writable = response.writable;
    this.submissions = new Map(response.submissions.map(value => [value.clientMessageId, copySubmission(value)]));
    this.status = response.writable ? status : 'readonly';
    for (const submission of this.submissions.values()) this.report(submission);
    this.emit();
  }

  async flush() {
    if (this.saveTimer !== undefined) {
      this.cancel(this.saveTimer);
      this.saveTimer = undefined;
    }
    return this.save();
  }

  async submit() {
    const text = this.localText.trim();
    if (!text) return null;
    if (text !== this.localText) {
      this.localText = text;
      this.localEdited = true;
      ++this.localVersion;
      this.emit();
    }
    const submittedVersion = this.localVersion;
    const saved = await this.flush();
    if (!saved || saved.status !== 'available' || saved.text !== text || !saved.writable) return null;
    const submission = {
      clientMessageId: this.uuid(), text, submissionRevision: saved.revision,
      receipt: null,
    };
    return this.send(submission, submittedVersion);
  }

  async retry(submission) {
    const current = this.submissions.get(submission.clientMessageId);
    if (!current || current.receipt.delivery !== 'unconfirmed'
      || current.text !== submission.text
      || current.submissionRevision !== submission.submissionRevision) return null;
    return this.send(current, null);
  }

  async send(submission, submittedVersion) {
    const scopeRef = this.scopeRef;
    if (scopeRef === null) return null;
    try {
      const receipt = await this.client.submitConversationText(
        submission.text, submission.clientMessageId, submission.submissionRevision, scopeRef,
      );
      if (scopeRef !== this.scopeRef) return null;
      const updated = { ...submission, receipt };
      if (receipt.delivery !== 'rejected') this.submissions.set(submission.clientMessageId, updated);
      this.reportedReceipts.delete(`${scopeRef}\u0000${submission.clientMessageId}`);
      this.report(updated, false);
      if (receipt.delivery === 'accepted') {
        if (submittedVersion !== null && submittedVersion === this.localVersion
          && this.localText === submission.text) {
          this.localText = '';
          this.localEdited = false;
          ++this.localVersion;
        }
        this.status = 'accepted';
        this.emit();
        await this.load();
      } else if (receipt.delivery === 'unconfirmed') {
        this.status = 'unconfirmed';
        this.emit();
      } else {
        this.status = receipt.reason;
        this.emit();
      }
      return receipt;
    } catch (error) {
      this.status = error?.code ?? 'unavailable';
      this.emit();
      return null;
    }
  }

  close() {
    if (this.saveTimer !== undefined) this.cancel(this.saveTimer);
    this.saveTimer = undefined;
  }
}
