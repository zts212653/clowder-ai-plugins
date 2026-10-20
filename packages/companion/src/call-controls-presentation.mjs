/** Presentation-only state for the active call surface. Media remains owned by explicit actions. */
export class CallControlsPresentation {
  constructor({
    document,
    root,
    pet,
    input,
    composers = [],
    send = async () => false,
    accepted = () => {},
    changed = () => {},
    collapseDelay = 1800,
    schedule = (callback, delay) => setTimeout(callback, delay),
    cancel = handle => clearTimeout(handle),
  }) {
    this.document = document;
    this.root = root;
    this.pet = pet;
    this.input = input;
    this.composers = composers;
    this.send = send;
    this.accepted = accepted;
    this.changed = changed;
    this.collapseDelay = collapseDelay;
    this.schedule = schedule;
    this.cancel = cancel;
    this.presentation = 'lite';
    this.panel = 'none';
    this.active = false;
    this.mediaLocked = false;
    this.petHovered = false;
    this.controlsHovered = false;
    this.timer = undefined;

    this.onPetEnter = () => {
      this.petHovered = true;
      if (this.active) this.reveal();
    };
    this.onPetLeave = () => {
      this.petHovered = false;
      this.armCollapse();
    };
    this.onControlsEnter = () => {
      this.controlsHovered = true;
      this.clearTimer();
    };
    this.onControlsLeave = () => {
      this.controlsHovered = false;
      this.armCollapse();
    };
    this.onFocusIn = () => this.clearTimer();
    this.onFocusOut = () => queueMicrotask(() => this.armCollapse());
    this.onInput = () => this.reevaluate();

    root.dataset.presentation = this.presentation;
    pet.addEventListener('pointerenter', this.onPetEnter);
    pet.addEventListener('pointerleave', this.onPetLeave);
    root.addEventListener('pointerenter', this.onControlsEnter);
    root.addEventListener('pointerleave', this.onControlsLeave);
    root.addEventListener('focusin', this.onFocusIn);
    root.addEventListener('focusout', this.onFocusOut);
    input.addEventListener('input', this.onInput);
    for (const composer of composers) {
      composer.submit = event => this.submit(event, composer.input);
      composer.form.onsubmit = composer.submit;
    }
  }

  setComposerState(identity, connecting) {
    for (const { form, input } of this.composers) {
      input.placeholder = identity ? `发消息给${identity.displayName}…` : '发消息给猫猫…';
      form.querySelector('button').disabled = !identity || connecting;
    }
  }

  async submit(event, input) {
    event.preventDefault();
    const text = input.value;
    if (!await this.send(text)) return;
    if (input.value === text) input.value = '';
    this.reevaluate();
    this.accepted();
  }

  setActive(active) {
    if (this.active === active) return;
    this.active = active;
    this.clearTimer();
    if (!active) {
      this.mediaLocked = false;
      this.setPresentation('lite');
      return;
    }
    this.setPresentation(this.mediaLocked ? 'controls' : 'lite');
  }

  setPanel(panel) {
    this.panel = panel;
    if (panel === 'actions') this.armCollapse();
    else this.clearTimer();
  }

  setMediaLocked(locked) {
    this.mediaLocked = locked;
    if (!this.active) return;
    if (locked) this.reveal();
    else this.armCollapse();
  }

  activate() {
    if (!this.active) return false;
    this.reveal();
    return true;
  }

  escape(panel) {
    if (!this.active || panel !== 'actions') return false;
    this.clearTimer();
    if (!this.mediaLocked) this.setPresentation('lite');
    return true;
  }

  reveal() {
    if (!this.active) return;
    this.clearTimer();
    this.setPresentation('controls');
  }

  reevaluate() {
    if (this.canAutoCollapse()) this.armCollapse();
    else this.clearTimer();
  }

  armCollapse() {
    this.clearTimer();
    if (!this.canAutoCollapse()) return;
    this.timer = this.schedule(() => {
      this.timer = undefined;
      if (this.canAutoCollapse()) this.setPresentation('lite');
    }, this.collapseDelay);
  }

  canAutoCollapse() {
    return this.active
      && this.presentation === 'controls'
      && !this.mediaLocked
      && !this.petHovered
      && !this.controlsHovered
      && !this.root.contains(this.document.activeElement)
      && this.input.value.trim() === '';
  }

  setPresentation(next) {
    if (this.presentation === next) return;
    this.presentation = next;
    this.root.dataset.presentation = next;
    this.changed(next);
  }

  clearTimer() {
    if (this.timer === undefined) return;
    this.cancel(this.timer);
    this.timer = undefined;
  }

  close() {
    this.clearTimer();
    this.pet.removeEventListener('pointerenter', this.onPetEnter);
    this.pet.removeEventListener('pointerleave', this.onPetLeave);
    this.root.removeEventListener('pointerenter', this.onControlsEnter);
    this.root.removeEventListener('pointerleave', this.onControlsLeave);
    this.root.removeEventListener('focusin', this.onFocusIn);
    this.root.removeEventListener('focusout', this.onFocusOut);
    this.input.removeEventListener('input', this.onInput);
    for (const composer of this.composers) {
      if (composer.form.onsubmit === composer.submit) composer.form.onsubmit = null;
    }
  }
}
