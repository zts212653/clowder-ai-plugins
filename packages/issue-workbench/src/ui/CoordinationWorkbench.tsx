'use client';
import { ColumnSeparator } from '../layout/ColumnSeparator';
import { useWorkbenchColumns } from '../layout/useWorkbenchColumns';
import {
  type CoordinationHost,
  type CoordinationSnapshot,
  type IssueInvestigation,
  type IssueSourceFact,
  type IssueSourceProfile,
  issueCategory,
  issueCategoryCounts,
  issueClassificationFor,
  issueFeatureBindings,
  issueRef,
  issueRefKey,
  matchesIssueCategory,
  newInvestigation,
  safeIssueUrl,
  type Versioned,
} from '../model/issue-coordination.js';
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { issueContextFor } from '../classification/issue-context';
import type { IssueRef } from '../model/issue-coordination.js';
import { CoordinationEditor } from './CoordinationEditor';
import { CoordinationHistory } from './CoordinationHistory';
import { CoordinationLinks, type RelationCandidate } from './CoordinationLinks';
import { CoordinationReading } from './CoordinationReading';
import { CoordinationSourceStatus, CoordinationSources } from './CoordinationSources';
import styles from './coordination.module.css';
import { IssueClassificationResults } from './IssueClassifications';
import { IssueSourceState, IssueSourceStateFilter, matchesSourceState } from './IssueSourceState';

const version = (f: IssueSourceFact) => f.reviewVersion ?? f.contentVersion ?? f.updatedAt;
export function CoordinationWorkbench({
  host,
  showClassifications = false,
  tools,
  issueTools,
  projectSnapshot,
}: {
  host: CoordinationHost;
  showClassifications?: boolean;
  tools?: ReactNode;
  projectSnapshot?: (snapshot: CoordinationSnapshot) => CoordinationSnapshot;
  issueTools?: (profile: IssueSourceProfile, fact: IssueSourceFact, category: string) => ReactNode;
}) {
  const columns = useWorkbenchColumns();
  const [sourceSnapshot, setSnapshot] = useState<CoordinationSnapshot>({ sources: [], relations: [] });
  const [reading, setReading] = useState<{ host: CoordinationHost; facts: Record<string, IssueSourceFact> }>();
  const onDetail = useCallback((ref: IssueRef, fact: IssueSourceFact | null) => setReading(old => {
    const facts = { ...(old?.host === host ? old.facts : {}) };
    if (fact) facts[issueRefKey(ref)] = fact;
    else delete facts[issueRefKey(ref)];
    return { host, facts };
  }), [host]);
  // Reuse the already authorized detail read; never put prose into the list transport or saved work.
  const readableSnapshot = reading?.host === host ? { ...sourceSnapshot, sources: sourceSnapshot.sources.map(source => ({
    ...source, issues: source.issues.map(fact => {
      const detail = reading.facts[issueRefKey(issueRef(source.profile.id, fact))];
      return !fact.unavailable && detail && fact.updatedAt === detail.updatedAt && fact.title === detail.title
        ? { ...fact, body: detail.body } : fact;
    }),
  })) } : sourceSnapshot;
  const snapshot = projectSnapshot ? projectSnapshot(readableSnapshot) : readableSnapshot;
  const [selected, setSelected] = useState(''),
    [filter, setFilter] = useState('all'),
    [query, setQuery] = useState('');
  const [view, setView] = useState<'queue' | 'reading' | 'notes'>('queue');
  const [category, setCategory] = useState('all');
  const [sourceState, setSourceState] = useState('all');
  const [localOnly, setLocalOnly] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [receipt, setReceipt] = useState(''),
    [saving, setSaving] = useState(false),
    [saveError, setSaveError] = useState('');
  const [drafts, setDrafts] = useState<Record<string, Versioned<IssueInvestigation> & { dirty: boolean }>>({});
  const loadId = useRef(0),
    flight = useRef(false);
  async function load(refresh = false) {
    const id = ++loadId.current;
    setBusy(true);
    setError('');
    try {
      const next = await host.load(refresh);
      if (id !== loadId.current) return;
      setSnapshot(next);
      setReceipt(refresh ? '已分别检查各来源；点击来源可查看检查时间。未保存的输入仍保留。' : '');
    } catch (e) {
      if (id === loadId.current) {
        setError((e as Error).message);
        if ([401, 403].includes((e as { status?: number }).status ?? 0)) setSnapshot({ sources: [], relations: [] });
      }
    } finally {
      if (id === loadId.current) setBusy(false);
    }
  }
  useEffect(() => {
    void load();
    return () => {
      loadId.current++;
    };
  }, [host]);
  useEffect(() => {
    const handler = (event: BeforeUnloadEvent) => {
      if (Object.values(drafts).some((d) => d.dirty)) {
        event.preventDefault();
        event.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [drafts]);
  const rows = snapshot.sources
    .flatMap((source) => {
      const facts = [...source.issues];
      for (const work of source.work)
        if (!facts.some((f) => f.id === work.value.ref.issueId))
          facts.push({
            id: work.value.ref.issueId,
            number: work.value.ref.number,
            title: work.value.title,
            state: 'UNKNOWN',
            updatedAt: '',
            labels: [],
            url: '',
            unavailable: true,
          });
      return facts.map((fact) => {
        const ref = issueRef(source.profile.id, fact),
          key = issueRefKey(ref);
        const saved = source.work.find((w) => issueRefKey(w.value.ref) === key);
        return { source, fact, ref, key, saved };
      });
    })
    .sort((a, b) => b.fact.updatedAt.localeCompare(a.fact.updatedAt) || a.key.localeCompare(b.key));
  const scoped = rows.filter(
    (r) =>
      (filter === 'all' || r.source.profile.id === filter) &&
      (!localOnly || r.saved || drafts[r.key]?.dirty) &&
      `${r.fact.title} #${r.fact.number} ${r.source.profile.name} ${issueCategory(r).label} ${r.saved?.value.module ?? ''} ${r.saved?.value.tags ?? ''}`
        .toLowerCase()
        .includes(query.toLowerCase()),
  );
  const categorized = scoped.filter((r) => matchesIssueCategory(r, category));
  const visible = categorized.filter((r) => matchesSourceState(r.fact, sourceState));
  const groups = issueCategoryCounts(scoped);
  const row = rows.find((r) => r.key === selected);
  const classification = row && issueClassificationFor(row.source, row.fact);
  const context = row && issueContextFor(row.fact, classification);
  useEffect(() => {
    if (!selected && rows[0]) setSelected(rows[0].key);
  }, [selected, rows[0]?.key]);
  const current = row
    ? (drafts[row.key] ?? {
        ...(row.saved ?? {
          revision: 0,
          value: newInvestigation(row.ref, row.fact.title, version(row.fact), row.source.preference.value),
        }),
        dirty: false,
      })
    : undefined;
  const candidates: RelationCandidate[] = rows.map((r) => ({
    ref: r.ref,
    title: r.fact.title,
    source: r.source.preference.value.name,
    version: version(r.fact),
    verification: issueCategory(r).label,
    state: r.fact.state === 'CLOSED' ? '来源已关闭' : r.fact.state === 'OPEN' ? '来源开放' : '来源暂不可用',
  }));
  async function save() {
    if (!row || !current || flight.current) return;
    flight.current = true;
    setSaving(true);
    setSaveError('');
    const key = row.key,
      value = current.value;
    try {
      const result = await host.saveWork(value, current.revision);
      setDrafts((old) => ({
        ...old,
        [key]:
          old[key]?.value === value
            ? { ...result, dirty: false }
            : { ...(old[key] ?? { value }), revision: result.revision, dirty: true },
      }));
      await load();
    } catch (e) {
      setSaveError((e as Error).message + '；输入已保留。');
      if ((e as { status?: number }).status === 409) await load();
    } finally {
      flight.current = false;
      setSaving(false);
    }
  }
  return (
    <main
      ref={columns.ref}
      style={columns.style}
      className={styles.shell}
      data-testid="issue-coordination"
      data-preview-revision="issue-coordination-v2"
      data-view={view}
    >
      <header className={styles.header}>
        <div className={styles.brand}>
          <h1>Issue 工作台</h1>
          <span className={styles.muted}>{rows.length} 个问题</span>
        </div>
        <div className={styles.actions}>
          {tools}
          <IssueClassificationResults
            sources={snapshot.sources}
            initialOpen={showClassifications}
            select={(key) => {
              setSelected(key);
              setView('notes');
              setSaveError('');
            }}
          />
          <button disabled={busy} onClick={() => void load(true)}>
            {busy ? '正在读取…' : '更新来源'}
          </button>
          <CoordinationSources sources={snapshot.sources} host={host} reload={() => load()} />
        </div>
      </header>
      <div className={styles.sources}>
        {snapshot.sources.map((source) => (
          <CoordinationSourceStatus key={source.profile.id} source={source} />
        ))}
        {snapshot.sources.some((s) => s.profile.synthetic) && (
          <span className={styles.muted}>内源为合成示例，尚未接入真实平台</span>
        )}
      </div>
      {receipt && (
        <p className={styles.receipt} role="status">
          {receipt}
        </p>
      )}
      {error && (
        <p className={styles.notice} role="alert">
          {error}
        </p>
      )}
      <nav className={styles.viewNav} aria-label="工作视图">
        <button className={styles.queueView} aria-pressed={view === 'queue'} onClick={() => setView('queue')}>
          队列
        </button>
        <button aria-pressed={view === 'reading'} onClick={() => setView('reading')}>
          正文
        </button>
        <button aria-pressed={view === 'notes'} onClick={() => setView('notes')}>
          研判{current?.dirty && <span aria-hidden="true"> ·</span>}
        </button>
      </nav>
      <div className={styles.layout}>
        <aside id={columns.queue.controls} className={styles.queue} aria-label="聚合问题队列">
          <div className={styles.filters}>
            <IssueSourceStateFilter
              facts={categorized.map((r) => r.fact)}
              value={sourceState}
              change={(value) => {
                setSourceState(value);
                const first = categorized.find((r) => matchesSourceState(r.fact, value));
                if (first) setSelected(first.key);
              }}
            />
            <label>
              来源
              <select aria-label="来源" value={filter} onChange={(e) => setFilter(e.target.value)}>
                <option value="all">全部来源 · {rows.length}</option>
                {snapshot.sources.map((s) => (
                  <option key={s.profile.id} value={s.profile.id}>
                    {s.preference.value.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              按类别查看
              <select
                aria-label="问题类别"
                value={category}
                onChange={(e) => {
                  setCategory(e.target.value);
                  const first = scoped.find(
                    (r) => matchesIssueCategory(r, e.target.value) && matchesSourceState(r.fact, sourceState),
                  );
                  if (first) setSelected(first.key);
                }}
              >
                <option value="all">全部类别 · {scoped.length}</option>
                {groups.map((g) => (
                  <option key={g.key} value={g.key}>
                    {g.label} · {g.count}
                  </option>
                ))}
              </select>
            </label>
            <label>
              搜索
              <input placeholder="标题、编号、类别或历史标记" value={query} onChange={(e) => setQuery(e.target.value)} />
            </label>
            <label className={styles.check}>
              <input type="checkbox" checked={localOnly} onChange={(e) => setLocalOnly(e.target.checked)} />{' '}
              有本地记录（含来源已关闭）
            </label>
          </div>
          <div className={styles.list}>
            {visible.map((r) => (
              <button
                key={r.key}
                aria-pressed={selected === r.key}
                onClick={() => {
                  setSelected(r.key);
                  setView('reading');
                  setSaveError('');
                }}
              >
                <span className={styles.muted}>
                  {r.source.preference.value.name} · #{r.fact.number}
                  {r.source.profile.synthetic ? ' · 合成' : ''}
                </span>
                <IssueSourceState fact={r.fact} />
                <span>{r.fact.title}</span>
                <span className={styles.categoryLabel}>
                  {issueCategory(r).label}
                  {issueCategory(r).key === 'feature' ? ` · ${issueFeatureBindings(r.fact).join('、')}` : ''}
                </span>
                <span className={styles.muted}>
                  {r.saved ? '有本地分析记录' : '分类分析与派工'}
                  {drafts[r.key]?.dirty ? ' · 未保存' : ''}
                </span>
              </button>
            ))}
            {!visible.length && <p>当前筛选没有可读取的问题。</p>}
          </div>
        </aside>
        <ColumnSeparator {...columns.queue} />
        <div className={styles.detail}>
          {row && current ? (
            <>
              <section className={styles.reading} aria-label="问题正文">
                <div className={styles.actions}>
                  <span className={styles.muted}>
                    {row.source.preference.value.name} · #{row.fact.number}
                  </span>
                  <IssueSourceState fact={row.fact} />
                  {safeIssueUrl(row.fact.url) && (
                    <a href={safeIssueUrl(row.fact.url)} target="_blank" rel="noreferrer">
                      打开原平台 ↗
                    </a>
                  )}
                </div>
                <h2>{row.fact.title}</h2>
                {row.fact.unavailable && (
                  <p className={styles.notice}>来源暂不可用；这不表示已删除。本地记录仍保留。</p>
                )}
                {current.value.sourceVersion !== version(row.fact) && (
                  <p className={styles.notice}>
                    来源发生变化，本仓依据可能需复核。
                    <button
                      onClick={() =>
                        setDrafts((d) => ({
                          ...d,
                          [row.key]: {
                            ...current,
                            value: { ...current.value, sourceVersion: version(row.fact) },
                            dirty: true,
                          },
                        }))
                      }
                    >
                      已核对当前来源
                    </button>
                  </p>
                )}
                <CoordinationReading key={`reading:${row.key}`} host={host} issue={row.ref} onDetail={onDetail} />
                <CoordinationLinks
                  key={`relations:${row.key}`}
                  current={candidates.find((c) => issueRefKey(c.ref) === row.key)!}
                  candidates={candidates}
                  relations={snapshot.relations}
                  host={host}
                  reload={() => load()}
                  select={(key) => {
                    setSelected(key);
                    setView('reading');
                  }}
                />
              </section>
              <ColumnSeparator {...columns.notes} />
              <section id={columns.notes.controls} className={styles.inspector} aria-label="本仓研判">
                {current.dirty && row.saved && row.saved.revision !== current.revision && (
                  <details className={styles.notice} open>
                    <summary>其他页面已保存新版本，请核对差异</summary>
                    <pre className={styles.prose}>{JSON.stringify(row.saved.value, null, 2)}</pre>
                    <button
                      onClick={() =>
                        setDrafts((d) => ({ ...d, [row.key]: { ...current, revision: row.saved!.revision } }))
                      }
                    >
                      已核对，保留我的输入并再次保存
                    </button>
                  </details>
                )}
                <CoordinationEditor
                  subject={`${row.source.preference.value.name} #${row.fact.number} · ${row.fact.title}`}
                  classification={classification}
                  context={context}
                  featureBindings={issueFeatureBindings(row.fact)}
                  sourceUpdatedAt={row.fact.updatedAt}
                  value={current.value}
                  change={(value) => setDrafts((d) => ({ ...d, [row.key]: { ...current, value, dirty: true } }))}
                  save={save}
                  busy={saving}
                  dirty={current.dirty}
                  error={saveError}
                />
                <CoordinationHistory key={`history:${row.key}:${current.revision}`} host={host} issue={current.value.ref} />
                {issueTools?.(row.source.profile, row.fact, issueCategory(row).label)}
              </section>
            </>
          ) : (
            <p>请选择一个可读取的问题。</p>
          )}
        </div>
      </div>
    </main>
  );
}
