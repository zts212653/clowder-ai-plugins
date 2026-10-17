'use client';

import { useEffect, useMemo, useState } from 'react';
import { useConfirm, useSourceClient } from '../ports/context';
import { IssueDetail } from './IssueDetail';
import { IssueList } from './IssueList';
import { LabelBatchPreview } from './LabelBatchPreview';
import { useIssueDetail } from './useIssueDetail';
import { useIssueSource } from './useIssueSource';
import styles from './workbench.module.css';
import {
  batchIsStale,
  emptyWork,
  type LocalWork,
  makeBatch,
  readSaved,
  type Stage,
  sourceTime,
  stageNames,
  summarize,
} from './workbench-model';

export function IssueWorkbenchPreview({ onExit }: { onExit?: () => void }) {
  const confirm = useConfirm();
  const { repo, storage: localStorage, storageKey: STORAGE_KEY, openSettings } = useSourceClient();
  const [dirty, setDirty] = useState(false);
  const [ready, setReady] = useState(false);
  const [enabled, setEnabled] = useState(true);
  const [records, setRecords] = useState<Record<string, LocalWork>>({});
  const [selected, setSelected] = useState<number | null>(null);
  const [remoteState, setRemoteState] = useState('OPEN');
  const [mobileDetail, setMobileDetail] = useState(false);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const [error, setError] = useState('');
  const [storageBlocked, setStorageBlocked] = useState(false);
  const [batch, setBatch] = useState<ReturnType<typeof makeBatch> | null>(null);
  useEffect(() => {
    try {
      const saved = readSaved(localStorage.getItem(STORAGE_KEY));
      setRecords(saved.records);
      setEnabled(saved.enabled);
    } catch {
      setError('无法读取本地体验记录。原数据未覆盖，请检查浏览器存储后刷新。');
      setStorageBlocked(true);
    }
    setReady(true);
  }, []);
  const source = useIssueSource(ready && enabled && !storageBlocked, selected);
  const snapshot = source.snapshot;
  function persist(next: Record<string, LocalWork>, nextEnabled = enabled) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, enabled: nextEnabled, records: next }));
      setRecords(next);
      setEnabled(nextEnabled);
      setError('');
      return true;
    } catch {
      setError('保存失败：浏览器存储不可用。本次修改尚未保存，请保留页面中的内容。');
      return false;
    }
  }
  const scoped = snapshot.issues.filter((f) => remoteState === 'all' || f.state === remoteState);
  const totals = useMemo(() => summarize(scoped, records), [scoped, records]);
  const allTotals = summarize(snapshot.issues, records);
  const closed = snapshot.issues.filter((f) => f.state === 'CLOSED');
  const closedWithWork = closed.filter((f) => records[f.number]?.revision > 0).length;
  const visible = scoped.filter((fact) => {
    const local = records[fact.number] ?? emptyWork();
    const searchable = `#${fact.number} ${fact.title} ${local.tags.join(' ')}`.toLowerCase();
    return searchable.includes(query.toLowerCase()) && (filter === 'all' || local.stage === filter);
  });
  const indexFact = snapshot.issues.find((item) => item.number === selected) ?? snapshot.issues[0];
  const discussion = useIssueDetail(indexFact?.number, ready && enabled && !storageBlocked);
  const newest =
    discussion.detail && indexFact && discussion.detail.updatedAt >= indexFact.updatedAt
      ? discussion.detail
      : indexFact;
  const fact = indexFact
    ? {
        ...indexFact,
        ...(discussion.detail ?? {}),
        title: newest!.title,
        state: newest!.state,
        labels: newest!.labels,
        updatedAt: newest!.updatedAt,
        unavailable: indexFact.unavailable,
      }
    : undefined;
  async function refresh() {
    await source.refresh();
    await discussion.refresh();
  }
  useEffect(() => {
    if (selected === null && fact) setSelected(fact.number);
  }, [selected, fact]);
  async function canLeave() {
    return (
      !dirty ||
      (await confirm({
        title: '还有未保存的内容',
        message: '离开后，未保存的方案或任务要求将被放弃。',
        confirmLabel: '放弃修改',
        cancelLabel: '继续编辑',
      }))
    );
  }
  async function selectIssue(number: number) {
    if (number === selected || (await canLeave())) {
      setSelected(number);
      setMobileDetail(true);
      setDirty(false);
    }
  }
  async function togglePlugin() {
    if (await canLeave()) {
      if (persist(records, !enabled)) setDirty(false);
    }
  }
  function downloadBatch() {
    if (!batch) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(batch, null, 2)], { type: 'application/json' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `issue-label-preview-${batch.batchId}.json`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  if (!ready) return <p>正在读取本地工作记录…</p>;
  return (
    <section
      className={styles.workbench}
      data-testid="issue-workbench-preview"
      data-preview-revision="issue-workbench-v8"
      aria-label="问题工作台"
    >
      {onExit && (
        <nav aria-label="插件位置" className={styles.pluginBreadcrumb}>
          <button
            type="button"
            onClick={async () => {
              if (await canLeave()) onExit();
            }}
          >
            ← 返回全部插件
          </button>
          <span aria-hidden="true">/</span>
          <span>Issue 统计与处理</span>
        </nav>
      )}
      <div className={styles.header}>
        <div>
          <div className={styles.eyebrow}>COMMUNITY / ISSUES</div>
          <h1>问题工作台</h1>
          <p className={styles.muted}>把问题整理清楚，让每个方案有下文。</p>
        </div>
        <div className={styles.row}>
          <span className={styles.pill}>GitHub · READ</span>
          <button type="button" aria-pressed={enabled} onClick={togglePlugin} disabled={storageBlocked}>
            {enabled ? '停用体验插件' : '启用体验插件'}
          </button>
        </div>
      </div>
      <div className={styles.previewNote}>GitHub 内容可更新 · 标注仍保存在此浏览器；任务与标签变更仅生成草稿。</div>
      <div className={styles.source}>
        <span>{repo.replace('/', ' / ')}</span>
        <span className={styles.row}>
          <span>
            GitHub 内容 ·{' '}
            {snapshot.lastCompleteAt ? `列表检查于 ${sourceTime(snapshot.lastCompleteAt)}` : '列表尚未检查'}
            （北京时间）
          </span>
          <button
            type="button"
            onClick={() => void refresh()}
            disabled={source.busy || discussion.busy || source.cooling || !enabled}
          >
            {source.busy || discussion.busy ? '正在更新…' : source.error || snapshot.failures.length ? '重试' : '更新'}
          </button>
        </span>
      </div>
      <div role="status" aria-live="polite" className={styles.sourceStatus}>
        {source.error ||
          (snapshot.failures.length
            ? `仅部分读取${snapshot.failures.some((f) => f.issueNumber) ? ` · ${snapshot.failures.filter((f) => f.issueNumber).length} 个问题待重试` : ' · 仓库检查未完成'}`
            : source.receipt
              ? Object.values(snapshot.summary).some(Boolean)
                ? `新增 ${snapshot.summary.added} · 关闭 ${snapshot.summary.closed} · 重开 ${snapshot.summary.reopened} · 列表变化 ${snapshot.summary.changed}`
                : '列表已检查，无变化'
              : '')}
        {snapshot.retryAt && source.cooling && <span> · 可重试时间 {sourceTime(snapshot.retryAt)}</span>}
        {snapshot.failures.length > 0 && (
          <details>
            <summary>查看读取问题</summary>
            {snapshot.failures.map((f, i) => (
              <p key={`${f.issueNumber ?? 'repo'}-${i}`}>
                {f.issueNumber ? `#${f.issueNumber} · ` : ''}
                {f.message}
              </p>
            ))}
            {snapshot.failures.some((f) => f.kind === 'auth') && (
              <button type="button" disabled={!openSettings} onClick={openSettings}>GitHub 登录设置</button>
            )}
          </details>
        )}
      </div>
      {error && (
        <p role="alert" className={styles.callout}>
          {error}
        </p>
      )}
      {!source.loaded && <p role="status">正在读取问题列表…</p>}
      {source.loaded && (snapshot.issues.length > 0 || snapshot.lastCompleteAt) && (
        <>
          <div className={styles.metrics}>
            {Object.entries(stageNames).map(([key, name]) => (
              <button
                type="button"
                key={key}
                aria-pressed={filter === key}
                onClick={() => {
                  setFilter(filter === key ? 'all' : key);
                  setMobileDetail(false);
                }}
              >
                <strong data-testid={`count-${key}`}>{totals[key as Stage]}</strong>
                <span>{name}</span>
              </button>
            ))}
          </div>
          <div className={styles.summary}>
            <span>
              <label>
                统计与列表范围{' '}
                <select aria-label="线上状态筛选" value={remoteState} onChange={(e) => setRemoteState(e.target.value)}>
                  <option value="OPEN">开放（{snapshot.issues.length - closed.length}）</option>
                  <option value="CLOSED">已关闭（{closed.length}）</option>
                  <option value="all">全部（{snapshot.issues.length}）</option>
                </select>
              </label>{' '}
              · {scoped.length} 个 issue · PR 未纳入
              {remoteState === 'OPEN' && closedWithWork > 0 && (
                <button type="button" onClick={() => setRemoteState('CLOSED')}>
                  查看已关闭问题中的 {closedWithWork} 份本地工作
                </button>
              )}
            </span>
            <span>
              任务草稿 <b data-testid="count-drafts">{allTotals.drafts}</b> · 标签草稿{' '}
              <b data-testid="count-pending">{allTotals.pendingIssues}</b> 个问题 / {allTotals.operations} 个操作{' '}
              <button
                type="button"
                onClick={() => setBatch(makeBatch(snapshot.repo, snapshot.fetchedAt, snapshot.issues, records))}
                disabled={allTotals.pendingIssues === 0}
              >
                预览变更
              </button>
            </span>
          </div>
        </>
      )}
      {!enabled || storageBlocked ? (
        <div className={styles.empty}>
          <h2>{storageBlocked ? '记录暂不可编辑' : '体验插件已停用'}</h2>
          <p>
            {storageBlocked ? '读取恢复后即可继续。' : '已有工作标签、解决方案与任务草稿全部保留，重新启用后可继续。'}
          </p>
        </div>
      ) : (
        <div className={`${styles.workspace} ${mobileDetail ? styles.showDetail : ''}`}>
          <IssueList
            visible={visible}
            records={records}
            query={query}
            filter={filter}
            selected={fact?.number ?? 0}
            onSearch={setQuery}
            onFilter={setFilter}
            onSelect={selectIssue}
          />
          {fact && (
            <IssueDetail
              key={fact.number}
              onDirtyChange={setDirty}
              fact={fact}
              fetchedAt={discussion.detail?.fetchedAt}
              detailStatus={
                discussion.busy
                  ? '正在核对本条讨论…'
                  : !discussion.loaded
                    ? '正在读取本条讨论…'
                    : `${!discussion.detail ? '此问题内容尚未下载。' : ''}${discussion.error}`
              }
              loadVersion={discussion.loadVersion}
              work={records[fact.number] ?? emptyWork()}
              onSave={(work) => persist({ ...records, [fact.number]: work })}
              onBack={() => setMobileDetail(false)}
            />
          )}
        </div>
      )}
      {batch && (
        <LabelBatchPreview
          stale={batchIsStale(batch, snapshot.issues, records)}
          batch={batch}
          onClose={() => setBatch(null)}
          onDownload={downloadBatch}
        />
      )}
    </section>
  );
}
