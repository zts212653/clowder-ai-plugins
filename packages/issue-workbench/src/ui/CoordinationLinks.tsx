import { useState } from 'react';
import {
  issueRefKey,
  relationKey,
  type CoordinationHost,
  type IssueRef,
  type IssueRelation,
  type Versioned,
} from '../model/issue-coordination.js';
import styles from './coordination.module.css';
import { IssueRelationPicker } from './IssueRelationPicker';

export interface RelationCandidate {
  ref: IssueRef;
  title: string;
  source: string;
  version: string;
  verification: string;
  state: string;
}
export function CoordinationLinks({
  current,
  candidates,
  relations,
  host,
  reload,
  select,
}: {
  current: RelationCandidate;
  candidates: RelationCandidate[];
  relations: Versioned<IssueRelation>[];
  host: CoordinationHost;
  reload: () => Promise<void>;
  select: (key: string) => void;
}) {
  const [target, setTarget] = useState(''),
    [reason, setReason] = useState(''),
    [conclusion, setConclusion] = useState('');
  const [kind, setKind] = useState<IssueRelation['kind']>('possible'),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const related = relations.filter(
    (r) => r.value.active && r.value.refs.some((ref) => issueRefKey(ref) === issueRefKey(current.ref)),
  );
  const available = candidates.filter((candidate) => issueRefKey(candidate.ref) !== issueRefKey(current.ref));
  const targetCandidate = available.find((candidate) => issueRefKey(candidate.ref) === target);
  async function persist(value: IssueRelation, revision: number) {
    setBusy(true);
    setError('');
    try {
      await host.saveRelation(value, revision);
      await reload();
      setReason('');
      setConclusion('');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className={styles.links}>
      <h3>关联研判</h3>
      <p className={styles.muted}>关联用于共同分类和派工；来源状态保持独立，共享结论需两边均获授权。</p>
      {related.map((r) => {
        const other = r.value.refs.find((ref) => issueRefKey(ref) !== issueRefKey(current.ref))!;
        const row = candidates.find((c) => issueRefKey(c.ref) === issueRefKey(other));
        const stale = r.value.refs.some(
          (ref, n) =>
            candidates.find((c) => issueRefKey(c.ref) === issueRefKey(ref))?.version !== r.value.sourceVersions[n],
        );
        return (
          <article className={styles.related} key={relationKey(r.value.refs)}>
            <div className={styles.actions}>
              <button onClick={() => select(issueRefKey(other))} disabled={!row}>
                {row ? `${row.source} #${other.number} · ${row.title}` : '关联来源暂不可见'}
              </button>
              <span>
                {row?.state} · {row?.verification}
              </span>
            </div>
            <p>
              {{ possible: '可能相关', 'same-cause': '同一根因', port: '历史移植关联' }[r.value.kind]} · {r.value.reason}
            </p>
            {r.value.conclusion && <p className={styles.prose}>{r.value.conclusion}</p>}
            {stale && <p>来源已有变化，关联依据需复核。</p>}
            <button disabled={busy} onClick={() => void persist({ ...r.value, active: false }, r.revision)}>
              解除关联（保留两边记录）
            </button>
          </article>
        );
      })}
      <details className={styles.fieldGroup}>
        <summary>关联其他问题（可选）</summary>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const other = targetCandidate;
            if (!other) return;
            const refs: IssueRelation['refs'] = [current.ref, other.ref];
            const old = relations.find((r) => relationKey(r.value.refs) === relationKey(refs));
            void persist(
              {
                refs,
                kind,
                reason,
                conclusion,
                sourceVersions: [current.version, other.version],
                createdBy: '',
                active: true,
              },
              old?.revision ?? 0,
            );
          }}
        >
          <div className={styles.fields}>
            <IssueRelationPicker candidates={available} value={target} change={setTarget} />
            <label>
              关系
              <select aria-label="关系" value={kind} onChange={(e) => setKind(e.target.value as IssueRelation['kind'])}>
                <option value="possible">可能相关</option>
                <option value="same-cause">同一根因</option>
              </select>
            </label>
          </div>
          <label>
            关联依据
            <input required value={reason} onChange={(e) => setReason(e.target.value)} />
          </label>
          <label>
            共享研判结论（仅本地，不自动公开）
            <textarea value={conclusion} onChange={(e) => setConclusion(e.target.value)} rows={3} />
          </label>
          <button type="submit" disabled={busy || !targetCandidate}>
            {busy ? '保存中…' : '保存关联'}
          </button>
        </form>
      </details>
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
