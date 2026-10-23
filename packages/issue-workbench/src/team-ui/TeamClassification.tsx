import { useEffect, useId, useRef, useState } from 'react';
import type { TeamHost, TeamSummary } from '../ports/team.js';
import type { ClassificationQueueView } from '../team/classification-queue.js';
import styles from './team.module.css';

/** Browser refreshes observe progress; only the declared Host schedule runs work. */
export function TeamClassification({ host }: { host: TeamHost }) {
  const fieldId = useId();
  const [summary, setSummary] = useState<TeamSummary>();
  const [repository, setRepository] = useState(''), [catId, setCatId] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const generation = useRef(0), working = useRef(false);
  const request = useRef<{ target: string; id: string }>();
  useEffect(() => {
    const current = ++generation.current;
    async function refresh() {
      if (working.current) return;
      working.current = true; setBusy(true);
      try {
        const value = await host.summary({ kind: 'analysis' });
        if (generation.current === current) { setSummary(value); setError(''); }
      } catch (error) {
        if (generation.current === current) { setSummary(undefined); setError((error as Error).message); }
      } finally { working.current = false; if (generation.current === current) setBusy(false); }
    }
    void refresh();
    const timer = setInterval(() => void refresh(), 3000);
    return () => { generation.current++; clearInterval(timer); };
  }, [host]);
  const repositories = [...new Set(summary?.settings.repositories?.split(/[\s,]+/).filter(Boolean) ?? [])];
  const repo = repository || (repositories.length === 1 ? repositories[0] : '');
  const cats = summary?.analysisCats ?? [];
  const queues = summary?.classificationQueues ?? [];
  const active = queues.some(queue => queue.repo === repo && ['paused', 'running'].includes(queue.status));
  const selected = cats.find(cat => cat.catId === catId);
  async function act(work: () => Promise<unknown>) {
    if (working.current) return;
    working.current = true; setBusy(true); setError('');
    const current = generation.current;
    try {
      await work();
      const value = await host.summary({ kind: 'analysis' });
      if (generation.current === current) setSummary(value);
    } catch (error) {
      if (generation.current === current) { setError((error as Error).message); setSummary(undefined); }
    } finally { working.current = false; if (generation.current === current) setBusy(false); }
  }
  function plan() {
    const target = JSON.stringify([repo, catId]);
    if (request.current?.target !== target) request.current = { target, id: crypto.randomUUID() };
    return host.planClassification({ repo, catId, requestId: request.current.id }).then(value => {
      request.current = undefined; return value;
    });
  }
  function control(queue: ClassificationQueueView, status: 'running' | 'paused' | 'stopped') {
    return act(() => host.controlClassification({ id: queue.id, expectedRevision: queue.revision, status }));
  }
  return <section aria-label="自动研判队列">
    <h3>分类分析</h3>
    <p className={styles.notice}>{summary?.settings.initialClassification
      ? '接入后首次自动分类已开启，包含 Open 与 Closed 历史；进度保留在下方。'
      : '接入后首次自动分类未开启。可在插件设置中启用，也可手动创建一次分析批次。'}</p>
    {host.settingsUrl && <a href={host.settingsUrl}>配置首轮分类与分析猫</a>}
    <h4>手动发起一轮 Open 问题分析</h4>
    <p>先读取本次问题清单，再启动。每个队列一次请一只猫分析一个问题，收到结果后继续下一条。</p>
    <p className={styles.muted}>本次队列不包含之后新开的 Issue。暂停会保留已发出的请求和结果；停止后可重新读取清单。</p>
    <p className={styles.muted}>关闭面板不会停止队列；需要停止新分析和自动派工时，请使用下方按钮。</p>
    {error && <p role="alert">{error}</p>}
    {summary?.configurationError && <p role="alert">{summary.configurationError}</p>}
    {summary?.analysisRouteError && <p role="alert">{summary.analysisRouteError}</p>}
    <label htmlFor={`${fieldId}-repository`}>批量研判仓库</label>
    <select id={`${fieldId}-repository`} value={repo} onChange={event => setRepository(event.target.value)} disabled={busy}>
      <option value="">选择仓库</option>
      {repository && !repositories.includes(repository) && <option value={repository} disabled>{repository} · 已取消授权</option>}
      {repositories.map(value => <option key={value} value={value}>{value}</option>)}
    </select>
    <label htmlFor={`${fieldId}-cat`}>批量分析猫猫</label>
    <select id={`${fieldId}-cat`} value={catId} onChange={event => setCatId(event.target.value)} disabled={busy}>
      <option value="">选择本猫咖成员</option>
      {catId && !selected && <option value={catId} disabled>{catId} · 已不在可用名单中</option>}
      {cats.map(cat => <option key={cat.catId} value={cat.catId} disabled={cat.available === false}>
        {cat.displayName}{cat.available === false ? ' · 当前不可用' : ''}
      </option>)}
    </select>
    {summary && <p className={styles.notice}>{summary.settings.automaticAssignment
      ? '自动派工已开启：分类后仅按当前组织成员、提交者优先及已保存规则派工；已有其他负责人时交由人工处理。'
      : '自动派工未开启：保存分类和建议后，由你在问题详情中确认指派。'}</p>}
    <button type="button" disabled={busy || active || !repo || !repositories.includes(repo) || !selected || selected.available === false}
      onClick={() => void act(plan)}>读取待研判问题</button>
    {active && <p className={styles.muted}>此仓库已有队列，请继续或停止下方队列。</p>}
    {queues.map(queue => {
      const analyzed = queue.items.filter(item => item.status === 'analyzed').length;
      const skipped = queue.items.filter(item => item.status === 'skipped').length;
      const waiting = queue.items.find(item => item.status === 'waiting');
      return <article key={queue.id} className={styles.report} aria-label={`${queue.repo} 研判队列`}>
        <h4>{queue.repo} · {cats.find(cat => cat.catId === queue.catId)?.displayName ?? queue.catId}</h4>
        <p>{queue.origin === 'integration' ? '接入后的首次自动分类 · 包含已关闭历史' : '人工发起的分类批次'}</p>
        <p>{queue.status === 'running' && (queue.error || queue.origin === 'integration' && !summary?.settings.initialClassification)
          ? '等待恢复' : ({ paused: '已暂停', running: '运行中', completed: '本批研判完成', stopped: '已停止' })[queue.status]}</p>
        <p>已研判 {analyzed} / {queue.items.length} · 已跳过 {skipped}</p>
        <progress aria-label={`${queue.repo} 研判进度`} max={queue.items.length || 1} value={analyzed + skipped} />
        {waiting && <p>当前问题 #{waiting.number}{waiting.reason ? `：${waiting.reason}` : '：等待猫猫研判结果'}</p>}
        {queue.error && <p role="alert">{queue.error}</p>}
        {queue.status === 'completed' && <p className={styles.muted}>分类完成不代表已派工或修复；请在研判记录中查看派工结果。</p>}
        <div className={styles.actions}>
          {queue.status === 'paused' && <button type="button" disabled={busy} onClick={() => void control(queue, 'running')}>启动队列</button>}
          {queue.status === 'running' && <button type="button" disabled={busy} onClick={() => void control(queue, 'paused')}>暂停队列</button>}
          {['paused', 'running'].includes(queue.status) && <button type="button" disabled={busy} onClick={() => void control(queue, 'stopped')}>停止队列</button>}
          {queue.status === 'completed' && <button type="button" disabled={busy} onClick={() => void control(queue, 'stopped')}>停止后续派工</button>}
        </div>
      </article>;
    })}
    <button type="button" disabled={busy} onClick={() => void act(async () => {})}>刷新队列</button>
  </section>;
}
