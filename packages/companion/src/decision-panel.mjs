import { decisionBadge, decisionPresentation, decisionRows } from './decision-view.mjs';

const readBasis = page => page?.version === 1
  ? [page.status, page.totalCount ?? 'unknown', ...['approvals', 'needsMe']
    .flatMap(key => [page.sources?.[key]?.status, page.sources?.[key]?.coverage])].join('|')
  : page ? 'legacy' : null;

export const decisionNavigationText = delivery => delivery === 'applied' ? '已打开对应事项'
  : delivery === 'queued' || delivery === 'requested' ? '已请求打开对应事项'
    : delivery === 'blocked' ? '暂时无法打开对应事项 · 请稍后重试'
      : '打开对应事项尚未确认 · 请从 Cat Café 查看';

export class DecisionPanel {
  constructor({ document, client, controls, motion, proactivePolicy = () => undefined }) {
    this.document = document;
    this.client = client;
    this.controls = controls;
    this.motion = motion;
    this.proactivePolicy = proactivePolicy;
    this.$ = id => document.getElementById(id);
    this.loading = false;
    this.offset = 0;
    this.latestPage = undefined;
    this.$('pending-badge').onclick = () => void controls.show('decisions');
    this.$('decision-reload').onclick = () => void this.read();
    this.$('decision-more').onclick = () => void this.read(true);
  }

  showBadge(page) {
    this.latestPage = page;
    const badge = decisionBadge(page);
    this.$('pending-badge').hidden = !badge.visible || this.proactivePolicy() !== 'quiet-badge';
    this.$('pending-count').textContent = badge.label;
    this.$('pending-badge').title = badge.title;
    this.$('pending-badge').setAttribute('aria-label', badge.title);
    this.$('menu-pending').textContent = badge.label;
    this.$('menu-pending').dataset.state = badge.state;
  }

  refreshBadge() {
    if (this.latestPage) this.showBadge(this.latestPage);
  }

  appendRow(list, row, knownVariantRefs) {
    if (row.variantRef && knownVariantRefs.has(row.variantRef)) return;
    const item = this.document.createElement('li');
    if (row.variantRef) { item.dataset.variantRef = row.variantRef; knownVariantRefs.add(row.variantRef); }
    const title = this.document.createElement('strong');
    const meta = this.document.createElement('span');
    title.textContent = row.title; meta.textContent = row.meta;
    item.append(title, meta); list.append(item);
    if (row.navigation) this.appendNavigation(item, row.navigation);
    else if (row.previewable) this.appendTrial(item, row.proposalId);
  }

  appendNavigation(item, navigation) {
    const button = this.document.createElement('button');
    button.type = 'button'; button.textContent = navigation.label;
    button.onclick = async () => {
      try {
        const result = await this.client.openDecision(navigation.variantRef, navigation.target);
        this.$('decision-status').textContent = decisionNavigationText(result.delivery);
      } catch { this.$('decision-status').textContent = '暂时无法打开对应事项 · 请稍后重试'; }
    };
    item.append(button);
  }

  appendTrial(item, proposalId) {
    const button = this.document.createElement('button');
    button.type = 'button'; button.textContent = '查看确认演练';
    button.onclick = async () => {
      try {
        const result = await this.client.inspectF221(proposalId);
        this.$('decision-status').textContent = result.status === 'trial_confirmed'
          ? '确认演练已完成；没有写回提案'
          : result.status === 'stale' ? '提案已变化，请重新查看原处卡片'
            : result.status === 'dismissed' ? '已取消演练；提案没有变化' : '确认演练暂不可用；请在原处处理';
      } catch { this.$('decision-status').textContent = '确认演练暂不可用；请在原处处理'; }
    };
    item.append(button);
  }

  async read(more = false) {
    if (this.loading) return;
    this.loading = true;
    if (!more && this.controls.panel === 'decisions') this.$('decision-status').textContent = '正在读取待办…';
    try {
      const previous = readBasis(this.latestPage);
      const page = await this.client.readDecisions(more ? this.offset : 0, 10);
      const presentation = decisionPresentation(page);
      const changedRead = more && presentation.renderRows && previous !== null && readBasis(page) !== previous;
      this.showBadge(page);
      this.motion.setPendingDecision(presentation.pending);
      if (this.controls.panel !== 'decisions') return;
      const list = this.$('decision-list');
      if (!more || changedRead) { list.replaceChildren(); list.scrollTop = 0; }
      const retainedRows = more && !presentation.renderRows && list.children.length > 0;
      const knownVariantRefs = new Set(Array.from(list.children).map(item => item.dataset.variantRef).filter(Boolean));
      for (const row of presentation.renderRows && !changedRead ? decisionRows(page) : []) {
        this.appendRow(list, row, knownVariantRefs);
      }
      this.offset = changedRead ? 0 : page.page.offset + page.page.limit;
      this.$('decision-reload').textContent = changedRead ? '刷新' : presentation.reloadLabel;
      this.$('decision-status').textContent = changedRead && page.totalCount !== 0
        ? '待办已变化 · 请刷新查看最新列表'
        : retainedRows
          ? `${presentation.badge.state === 'authentication' ? '待办需要登录' : '待办暂不可读'} · 以下为上次读到的内容`
          : presentation.message;
      this.$('decision-more').hidden = changedRead || !presentation.hasMore;
    } catch {
      this.showBadge(undefined);
      this.motion.setPendingDecision(null);
      if (this.controls.panel === 'decisions') {
        const retained = this.$('decision-list').children.length > 0;
        this.$('decision-status').textContent = retained
          ? '待办暂不可读 · 以下为上次读到的内容' : '待办暂不可读 · 请稍后刷新';
        this.$('decision-reload').textContent = '重试';
        this.$('decision-more').hidden = true;
      }
    } finally { this.loading = false; }
  }
}
