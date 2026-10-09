const activityLabel = activity => activity === 'waiting' ? '等待中' : '正在工作';

function deliveryMeta(artifact) {
  if (!artifact) return '已交付';
  const version = artifact.version ? `作品 ${artifact.version}` : '作品 · 版本未确认';
  if (artifact.versionState === 'current') return `${version} · 当前版本`;
  if (artifact.versionState === 'superseded') return `${version} · 已有更新版本`;
  return `${version} · 版本关系未确认`;
}

export function workOverviewPresentation(reply) {
  const availableRows = reply?.status !== 'unavailable';
  const active = availableRows ? (reply.active ?? []).map(entry => ({
    entryRef: entry.entryRef,
    title: entry.title,
    meta: entry.actor ? `${entry.actor.displayName} · ${activityLabel(entry.activity)}` : activityLabel(entry.activity),
  })) : [];
  const deliveries = availableRows ? (reply.recentDeliveries ?? []).map(entry => ({
    entryRef: entry.entryRef,
    title: entry.title,
    meta: deliveryMeta(entry.artifact),
  })) : [];
  return {
    visible: active.length > 0 || deliveries.length > 0 || ['partial', 'unavailable'].includes(reply?.status),
    scopeLabel: availableRows && reply?.scope?.label ? `仅当前项目 · ${reply.scope.label}` : '',
    notice: reply?.status === 'partial' ? '仅部分读取' : reply?.status === 'unavailable' ? '暂不可用' : '',
    active,
    deliveries,
  };
}

const navigationText = delivery => delivery === 'applied' ? '已打开原处'
  : delivery === 'queued' || delivery === 'requested' ? '已请求打开原处'
    : delivery === 'blocked' ? '原处暂时无法打开' : '打开原处的结果未确认';

/** Renders only bounded Host-issued rows; every navigation target remains opaque. */
export class WorkOverviewView {
  constructor({ document, client, changed = () => {} }) {
    this.document = document;
    this.client = client;
    this.changed = changed;
    this.$ = id => document.getElementById(id);
    this.loading = false;
  }

  renderRows(listId, rows) {
    const list = this.$(listId);
    list.replaceChildren();
    for (const row of rows) {
      const button = this.document.createElement('button');
      button.type = 'button';
      button.className = 'work-overview-row';
      const title = this.document.createElement('strong');
      const meta = this.document.createElement('span');
      title.textContent = row.title;
      meta.textContent = row.meta;
      button.append(title, meta);
      button.onclick = () => void this.open(row.entryRef);
      list.append(button);
    }
  }

  render(reply) {
    const view = workOverviewPresentation(reply);
    this.$('work-overview').hidden = !view.visible;
    this.$('work-scope').textContent = view.scopeLabel;
    this.$('work-notice').textContent = view.notice;
    this.$('work-active-section').hidden = view.active.length === 0;
    this.$('work-delivery-section').hidden = view.deliveries.length === 0;
    this.renderRows('work-active-list', view.active);
    this.renderRows('work-delivery-list', view.deliveries);
    this.changed();
  }

  async open(entryRef) {
    try {
      const reply = await this.client.openWork(entryRef);
      this.$('work-notice').textContent = navigationText(reply.delivery);
    } catch {
      this.$('work-notice').textContent = '原处暂时无法打开';
    }
  }

  async load() {
    if (this.loading) return;
    this.loading = true;
    try {
      this.render(await this.client.readWork());
    } catch {
      this.render({ status: 'unavailable', active: [], recentDeliveries: [] });
    } finally {
      this.loading = false;
    }
  }
}
