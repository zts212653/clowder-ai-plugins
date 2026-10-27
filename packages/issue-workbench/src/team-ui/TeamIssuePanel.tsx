import { useEffect, useRef, useState } from 'react';
import type { IssueSourceFact, IssueSourceProfile } from '../model/issue-coordination.js';
import type { TeamHost, TeamSummary } from '../ports/team.js';
import type { TeamRecordDetail } from '../team/records.js';
import { TeamRecordView } from './TeamRecordView';
import { TeamRecovery } from './TeamRecovery';
import { TeamAssignment } from './TeamAssignment';
import { TeamOrganization } from './TeamOrganization';
import styles from './team.module.css';

export function TeamIssuePanel({ host, profile, fact, category, workRevision = 0, dirty = false, onRead }: {
  host: TeamHost; profile: IssueSourceProfile; fact: IssueSourceFact; category: string; workRevision?: number; dirty?: boolean; onRead: (summary?: TeamSummary) => void;
}) {
  const [summary, setSummary] = useState<TeamSummary>();
  const [row, setRow] = useState<TeamRecordDetail>();
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [receipt, setReceipt] = useState('');
  const [reason, setReason] = useState(''), [catId, setCatId] = useState('');
  const [mode, setMode] = useState<'manual' | 'cat'>('manual');
  const initializedCat = useRef(false);
  const requestId = useRef<string>();
  const generation = useRef(0), flight = useRef(false);
  const supported = profile.provider === 'github' && !profile.synthetic && !fact.unavailable;
  async function load(preferredId?: string) {
    const current = ++generation.current;
    const next = await host.summary({ repo: profile.repository, number: fact.number });
    const candidate = preferredId ?? next.rows.find(item => item.kind !== 'inbox')?.id;
    const detail = candidate ? await host.get(candidate) : undefined;
    if (generation.current !== current) return;
    setSummary(next); setRow(detail); setError('');
    onRead(next);
    if (!initializedCat.current) {
      initializedCat.current = true;
      setCatId(next.settings.analysisCatId ?? '');
    }
  }
  function fail(error: unknown) {
    setError(error instanceof Error ? error.message : '团队操作失败');
    setRow(undefined); setSummary(undefined);
    onRead();
  }
  useEffect(() => {
    if (supported) { setBusy(true); void load().catch(fail).finally(() => setBusy(false)); }
    return () => { generation.current++; };
  }, [host, profile.repository, fact.number, category, workRevision, supported]);
  useEffect(() => {
    const pending = summary?.rows.find(item => item.kind === 'analysis' && item.status === 'delivered');
    if (!pending || busy) return;
    let reading = false;
    const timer = setInterval(() => {
      if (reading || flight.current || document.visibilityState !== 'visible') return;
      reading = true;
      void load().catch(fail).finally(() => { reading = false; });
    }, 2500);
    return () => clearInterval(timer);
  }, [summary, busy]);
  async function act(work: () => Promise<unknown>, message = '') {
    if (flight.current) return;
    flight.current = true; setBusy(true); setReceipt(''); setError('');
    try { await work(); setReceipt(message); }
    catch (error) { fail(error); }
    finally { flight.current = false; setBusy(false); }
  }
  const selectedCat = summary?.analysisCats?.find(cat => cat.catId === catId);
  const available = !!selectedCat && selectedCat.available !== false;
  const configured = !!summary?.settings.analysisThreadId && available && !summary?.configurationError;
  return <section className={styles.panel} aria-label="团队研判">
    <header><h3>分析与派工</h3><button type="button" disabled={busy || !supported} onClick={() => void act(() => load(row?.id))}>刷新团队结果</button></header>
    <div className={styles.modes} role="group" aria-label="研判方式">
      <button type="button" aria-pressed={mode === 'manual'} onClick={() => setMode('manual')}>人工研判</button>
      <button type="button" aria-pressed={mode === 'cat'} onClick={() => setMode('cat')}>猫猫研判</button>
    </div>
    {error && <p role="alert">{mode === 'manual' ? '团队联动暂不可用，人工研判仍可保存。' : ''}{error}</p>}
    {mode === 'manual' ? <p className={styles.muted}>已有分类可直接用于派工；需要时在上方调整或补充分析。无需逐项填表。</p> : <>
      {!supported ? <p>此来源暂不支持猫猫研判，可切回人工研判。</p> : <>
        <p className={styles.muted}>从本猫咖已配置的成员中选择分析猫猫，确认后发送研判任务。</p>
        {summary?.configurationError && <p>{summary.configurationError}</p>}
        {host.settingsUrl && <a href={host.settingsUrl}>插件设置</a>}
        <label>分析猫猫
          <select aria-label="分析猫猫" value={catId} disabled={busy || !summary?.analysisCats?.length}
            onChange={event => { setCatId(event.target.value); requestId.current = undefined; }}>
            <option value="">选择本猫咖成员</option>
            {catId && !selectedCat && <option value={catId} disabled>{catId} · {summary ? '已不在可用名单中' : '等待名单恢复'}</option>}
            {summary?.analysisCats?.map(cat => <option key={cat.catId} value={cat.catId} disabled={cat.available === false}>
              {cat.displayName || cat.catId}{cat.available === false ? ' · 暂不可用' : ''}
            </option>)}
          </select>
        </label>
        {summary?.analysisRouteError && <p className={styles.notice}>{summary.analysisRouteError}</p>}
        {summary && catId && !available && <p className={styles.notice}>所选猫猫当前不可用，请等待恢复或由你重新选择。</p>}
        <button type="button" className={styles.primary} disabled={busy || !configured} onClick={() => void act(async () => {
          requestId.current ??= crypto.randomUUID();
          const result = await host.analyze({ repo: profile.repository, number: fact.number, requestId: requestId.current, catId });
          requestId.current = undefined;
          await load(result.id);
        })}>{row?.kind === 'analysis' && row.analysis ? '重新研判' : '请猫分析'}</button>
        {configured && <p className={styles.muted}>{summary?.settings.automaticAssignment
          ? '发送任务：问题分类 + 按限制规则指派人员。研判后仅向关联组织成员自动派工，先匹配成员系统与职责，再考虑兼容的提交者与加权分工，并公开分数与理由。'
          : '发送任务：问题分类 + 按限制规则推荐人员。自动指派未开启，需由你确认派工。'}</p>}
      </>}
    </>}
    <p aria-live="polite">当前分类：{summary?.issueContext?.features.length
        ? `随 Feature 处理 · ${summary.issueContext.features.join('、')}`
          : category}</p>
    {summary?.issueContext?.analysis && summary.issueContext.analysis.category !== category && !summary.issueContext.features.length &&
      <p className={styles.muted}>已存猫研判类别：{summary.issueContext.analysis.category}。人工保存的类别优先；修改分类不会改写已有负责人。</p>}
    {summary?.issueContext?.effectiveCategory?.stale && <p role="alert">原文已变化，请重新核对并保存人工分类后再派工。</p>}
    {dirty && <p role="status">上方分析尚未保存；保存后刷新推荐并允许派工。</p>}
    {supported && <>
      {summary?.issueContext && <TeamAssignment
        key={`assign:${summary.issueContext.sourceVersion}:${row?.id ?? ''}:${row?.revision ?? 0}:${JSON.stringify(summary.issueContext.assignmentOptions)}`}
        host={host} context={summary.issueContext} row={row} busy={busy || dirty}
        act={work => act(async () => { const result = await work(); await load(result.id); })} />}
      {summary && <TeamOrganization group={summary.group} />}
      {busy && <p role="status">正在读取或处理…</p>}
      {row && <>
        <TeamRecordView row={row} />
        <TeamRecovery key={`${row.id}:${row.revision}`} host={host} row={row} busy={busy || dirty}
          act={work => act(async () => { await work(); await load(row.id); })} />
        {row.kind === 'analysis' && row.analysis && <details>
          <summary>人工反馈</summary>
          {row.feedback && <p>{({ accepted: '已采纳', corrected: '已修正', rejected: '已拒绝' })[row.feedback.verdict]} · {row.feedback.reason}</p>}
          <label>反馈理由<textarea aria-label="反馈理由" maxLength={1000} value={reason} onChange={event => setReason(event.target.value)} /></label>
          <div className={styles.actions}>{(['accepted', 'corrected', 'rejected'] as const).map(verdict =>
            <button key={verdict} type="button" disabled={busy || !reason.trim()} onClick={() => void act(async () => {
              await host.feedback({ id: row.id, expectedRevision: row.revision, verdict, reason: reason.trim() });
              await load(row.id); setReason('');
            }, '反馈已保存')}>{({ accepted: '采纳研判', corrected: '记录修正', rejected: '拒绝研判' })[verdict]}</button>)}</div>
        </details>}
      </>}
      {receipt && <p role="status">{receipt}</p>}
    </>}
  </section>;
}
