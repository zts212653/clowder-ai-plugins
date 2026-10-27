import { useEffect, useRef, useState } from 'react';
import type { TeamHost, TeamSummary } from '../ports/team.js';
import type { AssignmentBatchItem, AssignmentBatchView } from '../team/assignment-batch.js';
import { memberDescription } from '../classification/member-profile.js';
import { systemLabels } from '../classification/issue-context.js';
import styles from './team.module.css';

const labels = { ready: '可派工', 'needs-analysis': '待分析', blocked: '待处理', retained: '已有负责人 / 保留', assigned: '已派工', invited: '已邀请 / 待接手', failed: '未完成' };
type PendingEdit = { item: AssignmentBatchItem; login: string; included: boolean };
function revealFeedback(element: HTMLElement | null) {
  element?.focus({ preventScroll: true });
  element?.scrollIntoView({ block: 'nearest' });
}
export function AssignmentBatchBoard({ host }: { host: TeamHost }) {
  const [batch, setBatch] = useState<AssignmentBatchView | null>();
  const [summary, setSummary] = useState<TeamSummary>();
  const [catId, setCatId] = useState(''), [filter, setFilter] = useState('all');
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [pendingEdit, setPendingEdit] = useState<PendingEdit>();
  const [confirmation, setConfirmation] = useState<number>();
  const confirmationPanel = useRef<HTMLElement>(null), errorPanel = useRef<HTMLDivElement>(null), reviewButton = useRef<HTMLButtonElement>(null);
  const working = useRef(false), generation = useRef(0), requestId = useRef<string>();
  const latest = useRef(batch); latest.current = batch;
  useEffect(() => { if (confirmation !== undefined) revealFeedback(confirmationPanel.current); }, [confirmation]);
  useEffect(() => { if (error || batch?.error) revealFeedback(errorPanel.current); }, [error, batch?.error]);
  async function action(work: () => Promise<AssignmentBatchView | null>, edit?: PendingEdit) {
    if (working.current) return;
    const current = generation.current; working.current = true; setBusy(true); setError(''); setConfirmation(undefined);
    setPendingEdit(edit);
    try { const value = await work(); if (generation.current === current) setBatch(value); }
    catch (e) { if (generation.current === current) setError((e as Error).message); }
    finally { working.current = false; if (generation.current === current) { setBusy(false); setPendingEdit(undefined); } }
  }
  useEffect(() => {
    const current = ++generation.current;
    void action(() => host.getAssignmentBatch());
    void host.summary().then(value => { if (generation.current === current) { setSummary(value); setCatId(value.settings.analysisCatId ?? ''); } })
      .catch(e => { if (generation.current === current) setError(e.message); });
    const timer = setInterval(() => {
      if (latest.current && ['running', 'analyzing'].includes(latest.current.status)) void action(() => host.getAssignmentBatch({ id: latest.current!.id }));
    }, 3000);
    return () => { generation.current++; clearInterval(timer); };
  }, [host]);
  const items = (batch?.items ?? []).map(item => pendingEdit && item.issue.repo === pendingEdit.item.issue.repo && item.issue.id === pendingEdit.item.issue.id
    ? { ...item, login: pendingEdit.login, included: pendingEdit.included } : item);
  const selected = items.filter(i => i.included), remaining = selected.filter(i => !['assigned', 'invited'].includes(i.status));
  const blocked = remaining.some(i => !i.login || !['ready', 'failed'].includes(i.status));
  const draft = batch?.status === 'draft', stopped = batch?.status === 'cancelled' || batch?.status === 'completed';
  const revision = () => ({ id: batch!.id, expectedRevision: batch!.revision });
  const cats = summary?.analysisCats ?? [];
  function edit(item: AssignmentBatchItem, login: string, included: boolean) {
    return action(() => host.editAssignmentBatch({ ...revision(), repo: item.issue.repo, issueId: item.issue.id, login, included }), { item, login, included });
  }
  async function prepare() {
    requestId.current ??= crypto.randomUUID();
    const result = await host.planAssignments({ requestId: requestId.current }); requestId.current = undefined; return result;
  }
  const distribution = Object.entries(selected.reduce<Record<string, number>>((counts, item) => {
    if (item.login && ['ready', 'assigned', 'invited', 'failed'].includes(item.status)) counts[item.login] = (counts[item.login] ?? 0) + 1;
    return counts;
  }, {}));
  return <section aria-label="批量派工看板" className={styles.batch}>
    <p>读取所有已启用仓库的 Open 问题，按分类和成员分工准备本次计划。确认前可逐条改人或跳过。</p>
    <p className={styles.notice}>批量派工提交人：<strong>system</strong>。GitHub 原 Issue 作者及实际发评论账号保留真实身份；本批不附带邀请提交者验收的建议。</p>
    {(error || batch?.error) && <div ref={errorPanel} role="alert" tabIndex={-1}>
      {error && <p>{error}</p>}{batch?.error && <p>{batch.error}</p>}
    </div>}
    {pendingEdit && <p role="status">正在保存 #{pendingEdit.item.issue.number} 的调整…</p>}
    <div className={styles.actions}>
      {(!batch || stopped) && <button disabled={busy || batch === undefined} onClick={() => void action(prepare)}>读取当前 Open 问题看板</button>}
      <button disabled={busy} onClick={() => void action(() => host.getAssignmentBatch(batch ? { id: batch.id } : {}))}>刷新进度</button>
      {draft && <button disabled={busy} onClick={() => void action(() => host.refreshAssignmentBatch(revision()))}>重新核对计划</button>}
    </div>
    {!batch && <p>{busy ? '正在读取…' : '尚无批次。准备看板只读取 GitHub，不会发出指派。'}</p>}
    {batch && <>
      <p>本批方式：{batch.delivery === 'invitation' ? '通知成员接手（不设置 GitHub 负责人）' : '设置 GitHub 负责人'}。</p>
      <p><strong>{({ draft: '待确认', analyzing: '分类分析中', running: '执行中', partial: '部分完成，等待处理', completed: '本批派工完成', cancelled: '本批已停止' })[batch.status]}</strong>
        {' · '}{new Date(batch.createdAt).toLocaleString()} 的 Open 快照 · 共 {items.length} 条</p>
      <p className={styles.muted}>之后新增的问题不进入本批。已有负责人保持原状。修改分类或系统时，请先回到问题详情保存，再点击“重新核对计划”。</p>
      <div className={styles.actions} aria-label="按派工状态筛选">
        <button aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>全部 {items.length}</button>
        {Object.entries(labels).map(([key, label]) => <button key={key} aria-pressed={filter === key} onClick={() => setFilter(key)}>{label} {items.filter(i => i.status === key).length}</button>)}
      </div>
      <p>本次参与 {selected.length} · 跳过 {items.filter(i => !i.included && i.status !== 'retained').length} · 已派工 {selected.filter(i => i.status === 'assigned').length} · 已邀请 {selected.filter(i => i.status === 'invited').length}</p>
      <p>成员分布：{distribution.map(([login, count]) => `@${login} ${count} 条`).join(' · ') || '暂无可派工人选'}</p>
      {['running', 'partial', 'completed'].includes(batch.status) && <progress aria-label="批量派工进度" max={selected.length || 1} value={selected.length - remaining.length} />}
      <div className={styles.batchRows}>
        {items.filter(i => filter === 'all' || i.status === filter).map(item => {
          const ref = `${item.issue.repo}#${item.issue.number}`, options = item.options;
          return <article key={item.issue.repo + ':' + item.issue.id} className={styles.batchRow} aria-label={ref}>
            <div><a href={item.issue.url} target="_blank" rel="noreferrer">{ref}</a><strong>{item.issue.title}</strong>
              <span>{labels[item.status]}{item.issue.assignees.length ? ` · ${item.issue.assignees.map(x => '@' + x).join('、')}` : ''}</span></div>
            <div><strong>{item.category} · {item.score === null ? '优先级待判断' : `${item.score}/10`}</strong>
              <span>{options.affectedSystems?.map(s => systemLabels[s]).join(' / ') || '系统待判断'} · {({ general: '普通问题', framework: '框架与架构', 'core-plan': '核心功能方案' })[options.routingFocus ?? 'general']}</span>
              <span>{item.reason ?? options.recommendationReason}</span>
              {item.manual && <span>人工调整 · 原推荐 @{options.preferredLogin ?? '无'}</span>}</div>
            <div>{item.status !== 'retained' && <>
              <label><input type="checkbox" aria-label={`本次参与 ${ref}`} checked={item.included} disabled={busy || !draft}
                onChange={e => void edit(item, item.login, e.target.checked)} />本次参与</label>
              <select aria-label={`调整 ${ref} 指派成员`} value={item.login} disabled={busy || !draft || !!item.lockedReason || !!options.blockedReason || item.status === 'needs-analysis'}
                onChange={e => void edit(item, e.target.value, item.included)}>
                <option value="">选择成员</option>
                {options.members.map(login => <option key={login} value={login} disabled={!options.eligibleMembers?.includes(login)}>
                  @{login} · {options.excluded?.find(e => e.login === login)?.reason ?? memberDescription(options.profiles?.find(p => p.login === login))}
                </option>)}
              </select>
              {draft && item.manual && options.preferredLogin && <button disabled={busy} onClick={() => void edit(item, options.preferredLogin!, item.included)}>恢复推荐</button>}
            </>}</div>
          </article>;
        })}
      </div>
      {draft && items.some(i => i.included && i.status === 'needs-analysis') && <div className={styles.report}>
        <label>补分类的猫猫<select aria-label="批量分析猫猫" value={catId} disabled={busy} onChange={e => setCatId(e.target.value)}>
          <option value="">选择猫猫</option>{cats.map(cat => <option key={cat.catId} value={cat.catId} disabled={cat.available === false}>{cat.displayName}</option>)}
        </select></label>
        <button disabled={busy || !cats.some(c => c.catId === catId && c.available !== false)} onClick={() => void action(() => host.analyzeAssignmentBatch({ ...revision(), catId }))}>补齐分类分析</button>
        <p className={styles.muted}>按次序分析缺少分类的问题，结果返回此看板，仍须你确认才会派工。</p>
        {summary?.analysisRouteError && <p role="alert">{summary.analysisRouteError}</p>}
        {host.settingsUrl && <a href={host.settingsUrl}>配置分析对话与猫猫</a>}
      </div>}
      {(draft || batch.status === 'partial') && <div className={styles.report}>
        {blocked && <p>本次参与的条目中还有待分析或待处理问题；请解决或取消勾选后再派工。</p>}
        <button ref={reviewButton} className={styles.primary} disabled={busy || blocked || !remaining.length} onClick={() => setConfirmation(batch.revision)}>{draft ? '核对并派工' : '核对并重试未完成项'}</button>
        {batch.status === 'partial' && <p>已完成项不会重复派工。来源或分工变化时，可停止本批后重新准备；评论结果待核对时，到“团队记录 → 派工记录”处理。</p>}
      </div>}
      {confirmation === batch.revision && <section ref={confirmationPanel} role="alertdialog" aria-label="确认批量派工" tabIndex={-1} className={styles.notice}>
        <p>{batch.delivery === 'invitation' ? `即将发送 ${remaining.length} 条任务邀请，不设置 GitHub 负责人，并以 system 为提交人标识发布说明。`
          : `即将设置 ${remaining.length} 个 Issue 的 GitHub 负责人，并以 system 为提交人标识发布说明。`}</p>
        <p>{distribution.map(([login, count]) => `@${login}：${count} 条`).join('；')}。不会自动修代码或合入。</p>
        <button disabled={busy} onClick={() => void action(() => (draft ? host.confirmAssignmentBatch : host.retryAssignmentBatch)(revision()))}>确认批量派工</button>
        <button disabled={busy} onClick={() => { setConfirmation(undefined); reviewButton.current?.focus(); }}>返回调整</button>
      </section>}
      {!stopped && <button disabled={busy} onClick={() => void action(() => host.cancelAssignmentBatch(revision()))}>停止本批</button>}
      <p className={styles.muted}>关闭看板不会停止已确认批次；停止本批保留历史，已写入 GitHub 的负责人和说明不会撤销。本批问题不会转交后台自动派工；后续可重新准备批次。</p>
    </>}
  </section>;
}
export function AssignmentBatchEntry({ host }: { host: TeamHost }) {
  const [open, setOpen] = useState(false); const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { if (open) dialog.current?.showModal(); else dialog.current?.close(); }, [open]);
  return <><button type="button" onClick={() => setOpen(true)}>批量派工</button>
    <dialog ref={dialog} className={`${styles.dialog} ${styles.batchDialog}`} aria-label="批量派工" onClose={() => setOpen(false)} onCancel={() => setOpen(false)}>
      <header><h2>批量派工</h2><button onClick={() => setOpen(false)}>关闭</button></header>
      {open && <AssignmentBatchBoard host={host} />}
    </dialog></>;
}
