'use client';
import {
  type CoordinationHost,
  type CoordinationSnapshot,
  type IssueInvestigation,
  type IssueSourceFact,
  issueRef,
  issueRefKey,
  newInvestigation,
  safeIssueUrl,
  type Versioned,
} from '../model/issue-coordination.js';
import { useEffect, useRef, useState } from 'react';
import { CoordinationEditor } from './CoordinationEditor';
import { CoordinationLinks, type RelationCandidate } from './CoordinationLinks';
import { CoordinationReading } from './CoordinationReading';
import { CoordinationSourceStatus, CoordinationSources } from './CoordinationSources';
import styles from './coordination.module.css';
import { IssueClassificationResults } from './IssueClassifications';

const verified = { pending: '待验证', failed: '仍可复现', passed: '已记录验证通过' };
const version = (f: IssueSourceFact) => f.reviewVersion ?? f.contentVersion ?? f.updatedAt;
export function CoordinationWorkbench({
  host,
  showClassifications = false,
}: {
  host: CoordinationHost;
  showClassifications?: boolean;
}) {
  const [snapshot, setSnapshot] = useState<CoordinationSnapshot>({ sources: [], relations: [] });
  const [selected, setSelected] = useState(''),
    [filter, setFilter] = useState('all'),
    [query, setQuery] = useState('');
  const [view, setView] = useState<'queue' | 'reading' | 'notes'>('queue');
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
  const visible = rows.filter(
    (r) =>
      (filter === 'all' || r.source.profile.id === filter) &&
      (!localOnly || r.saved || drafts[r.key]?.dirty) &&
      `${r.fact.title} #${r.fact.number} ${r.source.profile.name} ${r.saved?.value.module ?? ''} ${r.saved?.value.tags ?? ''}`
        .toLowerCase()
        .includes(query.toLowerCase()),
  );
  const row = rows.find((r) => r.key === selected);
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
    verification: verified[r.saved?.value.verification ?? 'pending'],
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
        <aside className={styles.queue} aria-label="聚合问题队列">
          <div className={styles.filters}>
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
              搜索
              <input placeholder="标题、编号、模块或标记" value={query} onChange={(e) => setQuery(e.target.value)} />
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
                <span>{r.fact.title}</span>
                <span className={styles.muted}>
                  {r.fact.unavailable ? '来源暂不可用' : r.fact.state === 'CLOSED' ? '来源已关闭' : '来源开放'} ·{' '}
                  {verified[r.saved?.value.verification ?? 'pending']}
                  {drafts[r.key]?.dirty ? ' · 未保存' : ''}
                </span>
              </button>
            ))}
            {!visible.length && <p>当前筛选没有可读取的问题。</p>}
          </div>
        </aside>
        <div className={styles.detail}>
          {row && current ? (
            <>
              <section className={styles.reading} aria-label="问题正文">
                <div className={styles.actions}>
                  <span className={styles.muted}>
                    {row.source.preference.value.name} · #{row.fact.number}
                  </span>
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
                <CoordinationReading key={`reading:${row.key}`} host={host} issue={row.ref} />
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
              <section className={styles.inspector} aria-label="本仓研判">
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
                  classification={row.source.classifications?.find(
                    (result) => result.source.issueId === row.fact.id && result.source.number === row.fact.number,
                  )}
                  sourceUpdatedAt={row.fact.updatedAt}
                  value={current.value}
                  change={(value) => setDrafts((d) => ({ ...d, [row.key]: { ...current, value, dirty: true } }))}
                  save={save}
                  busy={saving}
                  dirty={current.dirty}
                  error={saveError}
                />
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
