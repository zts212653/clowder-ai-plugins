import { SettingsController } from './settings-controller.mjs';

const skinLabels = {
  'xianxian-codex': '宪宪 v1',
  'yanyan-codex': '砚砚 v1',
  'ragdoll-v1': '布偶猫',
  'yarn-ball': '猫猫球',
};
const fieldLabels = {
  dutyCatProfileId: '陪伴者',
  skin: '外观',
  ballSize: '大小',
  behaviorEnabled: '自主活动',
  proactivePolicy: '主动提示',
  personaTone: '人设基调',
  householdReadsAllowed: '资料查询',
};

export class SettingsView {
  constructor({ document, client, close, callActive, onValues,
    expectHostStop = () => false, settleExpectedHostStop = async () => {}, layoutChanged = () => {} }) {
    this.document = document;
    this.$ = id => document.getElementById(id);
    this.close = close;
    this.callActive = callActive;
    this.onValues = onValues;
    this.expectHostStop = expectHostStop;
    this.settleExpectedHostStop = settleExpectedHostStop;
    this.layoutChanged = layoutChanged;
    this.controller = new SettingsController({ client, changed: state => this.render(state) });
    this.bind();
  }

  bind() {
    this.$('settings-back').onclick = () => {
      if (this.controller.state.page === 'main') this.close();
      else this.controller.navigate('main');
    };
    this.$('settings-partner-open').onclick = () => this.controller.navigate('partner');
    this.$('settings-look-open').onclick = () => this.controller.navigate('look');
    this.$('settings-behavior').onclick = () => void this.controller.requestUpdate(
      'behaviorEnabled', !this.controller.state.values?.behaviorEnabled,
    );
    this.$('settings-proactive').onclick = () => void this.controller.requestUpdate(
      'proactivePolicy', this.controller.state.values?.proactivePolicy === 'quiet-badge' ? 'ambient' : 'quiet-badge',
    );
    this.$('settings-documents').onclick = () => {
      const value = !this.controller.state.values?.householdReadsAllowed;
      void this.controller.requestUpdate('householdReadsAllowed', value, { confirm: this.callActive() });
    };
    this.$('settings-tone').onchange = event => {
      const value = event.target.value.replace(/[\r\n]+/gu, ' ').trim();
      event.target.value = value;
      if (!value) { event.target.value = this.controller.state.values?.personaTone ?? ''; return; }
      void this.controller.requestUpdate('personaTone', value);
    };
    this.$('settings-tone').oninput = event => {
      event.target.value = event.target.value.replace(/[\r\n]+/gu, ' ');
      this.$('settings-tone-count').textContent = `${Array.from(event.target.value).length} / 200`;
    };
    this.$('settings-tone').onkeydown = event => {
      if (event.key === 'Enter') event.preventDefault();
    };
    this.$('settings-size').onchange = event => void this.controller.requestUpdate('ballSize', Number(event.target.value));
    for (const id of Object.keys(skinLabels)) {
      this.$(`settings-skin-${id}`).onclick = () => void this.controller.requestUpdate('skin', id);
    }
    this.$('settings-reset').onclick = () => void this.controller.resetPosition();
    this.$('settings-disable-open').onclick = () => this.controller.requestDisable();
    this.$('settings-confirm-cancel').onclick = () => this.controller.navigate(
      this.controller.state.confirmation?.returnPage ?? 'main',
    );
    this.$('settings-confirm-apply').onclick = async () => {
      const expectsStop = this.callActive() && Boolean(this.controller.state.confirmation);
      if (expectsStop) this.expectHostStop();
      const settlement = await this.controller.confirm();
      if (expectsStop) await this.settleExpectedHostStop(settlement?.callStopped ?? null);
    };
    this.$('settings-retry').onclick = () => void this.controller.retry({ confirm: this.callActive() });
    this.$('settings-reread').onclick = () => void this.controller.load();
    this.$('settings-unavailable-retry').onclick = () => void this.controller.load();
  }

  open() {
    this.controller.navigate('main');
    return this.controller.load({ preserveSettlement: true });
  }

  setToggle(id, checked) {
    const node = this.$(id);
    node.setAttribute('aria-checked', String(checked));
    node.dataset.checked = String(checked);
  }

  renderRoster(state) {
    const list = this.$('settings-roster');
    list.replaceChildren();
    for (const companion of state.companions ?? []) {
      const row = this.document.createElement('button');
      row.type = 'button';
      row.className = 'settings-choice';
      row.disabled = !companion.available || state.saving;
      row.dataset.settingControl = 'true';
      row.dataset.selected = String(companion.catProfileId === state.values.dutyCatProfileId);
      const name = this.document.createElement('strong');
      const meta = this.document.createElement('span');
      name.textContent = companion.displayName;
      meta.textContent = companion.available ? '' : '暂不可用';
      row.append(name, meta);
      row.onclick = () => void this.controller.requestUpdate('dutyCatProfileId', companion.catProfileId,
        { confirm: this.callActive() });
      list.append(row);
    }
  }

  renderValues(state) {
    const values = state.values;
    if (!values) return;
    const selected = state.companions?.find(item => item.catProfileId === values.dutyCatProfileId);
    this.$('settings-partner-value').textContent = selected
      ? `${selected.displayName}${selected.available ? '' : ' · 暂不可用'}`
      : '已保存的陪伴者 · 暂不可用 · 请重新选择';
    this.$('settings-look-value').textContent = skinLabels[values.skin] ?? values.skin;
    this.setToggle('settings-behavior', values.behaviorEnabled);
    this.setToggle('settings-proactive', values.proactivePolicy === 'quiet-badge');
    this.setToggle('settings-documents', values.householdReadsAllowed);
    this.$('settings-size').value = String(values.ballSize);
    this.$('settings-tone').value = values.personaTone;
    this.$('settings-tone-count').textContent = `${Array.from(values.personaTone).length} / 200`;
    for (const id of Object.keys(skinLabels)) {
      this.$(`settings-skin-${id}`).dataset.selected = String(values.skin === id);
    }
    this.renderRoster(state);
    this.onValues(values, state);
  }

  savedValue(field, state) {
    const value = state.values?.[field];
    if (field === 'skin') return skinLabels[value] ?? value;
    if (field === 'dutyCatProfileId')
      return state.companions?.find(item => item.catProfileId === value)?.displayName ?? '已保存的陪伴者';
    if (field === 'behaviorEnabled' || field === 'householdReadsAllowed') return value ? '开启' : '关闭';
    if (field === 'proactivePolicy') return value === 'quiet-badge' ? '开启' : '关闭';
    if (field === 'ballSize') return `${value}`;
    return value;
  }

  noticeText(notice, state) {
    if (!notice) return '';
    if (notice.kind === 'position_reset') return '已回到默认位置';
    if (notice.kind === 'position_reset_failed') return '还没能回到默认位置 · 请重试';
    if (notice.kind === 'disable_failed') return '桌面猫猫球还没有停用 · 请重试';
    const label = fieldLabels[notice.field] ?? '设置';
    const stopped = notice.callStopped ? '通话已结束，' : '';
    if (notice.kind === 'saved') return notice.applies === 'next_call'
      ? `${stopped}${label}已保存 · 下次语音通话生效`
      : `${stopped}${label}已保存`;
    if (notice.kind === 'rejected') {
      if (notice.reason === 'selection_unavailable') return `${stopped}${label}暂不可用 · 请重新选择`;
      if (notice.callStopped) return `通话已结束，${label}未更改`;
      const current = this.savedValue(notice.field, state);
      return current === undefined ? `${label}未保存` : `${label}未保存，仍为“${current}”`;
    }
    if (notice.kind === 'reconciled_saved') return `${stopped}重新读取后确认${label}已保存`;
    if (notice.kind === 'reconciled_not_saved') return notice.callStopped
      ? `通话已结束，${label}未更改` : `重新读取后确认${label}未更改`;
    return `${stopped}${label}的保存结果未确认`;
  }

  renderSettlement(state) {
    for (const id of ['settings-partner-open', 'settings-look-open', 'settings-behavior',
      'settings-proactive', 'settings-documents', 'settings-tone-field', 'settings-size-field'])
      delete this.$(id).dataset.settlement;
    if (state.notice?.kind !== 'unconfirmed') return;
    const ids = {
      dutyCatProfileId: 'settings-partner-open', skin: 'settings-look-open',
      behaviorEnabled: 'settings-behavior', proactivePolicy: 'settings-proactive',
      householdReadsAllowed: 'settings-documents', personaTone: 'settings-tone-field',
      ballSize: 'settings-size-field',
    };
    const id = ids[state.notice.field];
    if (id) this.$(id).dataset.settlement = 'unconfirmed';
    if (state.notice.field === 'dutyCatProfileId') this.$('settings-partner-value').textContent = '未确认';
    if (state.notice.field === 'skin') this.$('settings-look-value').textContent = '未确认';
  }

  renderConfirmation(state) {
    const confirmation = state.confirmation;
    if (!confirmation) return;
    if (confirmation.kind === 'disable') {
      this.$('settings-confirm-title').textContent = '停用桌面猫猫球';
      this.$('settings-confirm-copy').textContent = '停用后，桌面上不再显示猫猫球，当前语音通话将结束。设置和聊天记录会保留，可在 Cat Café 的“设置 › 插件”中重新启用。';
      this.$('settings-confirm-apply').textContent = '结束语音并停用';
      return;
    }
    const disablingReads = confirmation.field === 'householdReadsAllowed' && confirmation.value === false;
    this.$('settings-confirm-title').textContent = fieldLabels[confirmation.field];
    this.$('settings-confirm-copy').textContent = confirmation.field === 'dutyCatProfileId'
      ? '更换陪伴者将结束当前语音通话。设置保存后，需要由你重新开始通话。'
      : disablingReads
        ? '关闭后，陪伴者在语音通话中无法查询家里的资料。更改这项需要先结束当前通话，之后可重新开始。'
        : '更改资料查询权限需要先结束当前语音通话，之后可由你重新开始。';
    this.$('settings-confirm-apply').textContent = confirmation.field === 'dutyCatProfileId'
      ? '结束语音并更换' : '结束语音并更改';
  }

  render(state) {
    const unavailable = state.phase === 'unavailable';
    const disabled = state.phase === 'disabled';
    const requestedPage = disabled ? 'disabled' : unavailable ? 'unavailable' : state.page;
    const page = requestedPage === 'disable' ? 'confirm' : requestedPage;
    for (const name of ['main', 'partner', 'look', 'confirm', 'unavailable', 'disabled']) {
      this.$(`settings-page-${name}`).hidden = name !== page;
    }
    this.$('settings-loading').hidden = state.phase !== 'loading';
    this.$('settings-title').textContent = page === 'partner' ? '陪伴者'
      : page === 'look' ? '外观'
        : ['confirm', 'disable'].includes(page) ? '' : '设置';
    this.$('settings-unavailable-copy').textContent = state.reason === 'host_upgrade_required'
      ? '这个 Host 版本还不支持猫旁设置。原来的设置入口会继续保留。'
      : '设置暂时读不到，请稍后重试。';
    for (const control of this.$('settings').querySelectorAll('[data-setting-control]')) control.disabled = state.saving;
    if (state.values) this.renderValues(state);
    this.renderSettlement(state);
    this.renderConfirmation(state);
    const text = this.noticeText(state.notice, state);
    this.$('settings-notice').hidden = !text;
    this.$('settings-notice').textContent = text;
    this.$('settings-notice').dataset.kind = state.notice?.kind ?? '';
    this.$('settings-retry').hidden = !state.retry || page === 'confirm';
    this.$('settings-reread').hidden = state.notice?.kind !== 'unconfirmed';
    this.layoutChanged();
  }
}
