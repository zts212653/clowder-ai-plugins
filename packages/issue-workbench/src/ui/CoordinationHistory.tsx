import { useState } from 'react';
import type { CoordinationHost, IssueInvestigation, IssueRef, Versioned } from '../model/issue-coordination.js';
import styles from './coordination.module.css';

export function CoordinationHistory({ host, issue }: { host: CoordinationHost; issue: IssueRef }) {
  const [entries, setEntries] = useState<Versioned<IssueInvestigation>[]>();
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  if (!host.workHistory) return null;
  return <details className={styles.fieldGroup}>
    <summary>人工修改历史</summary>
    <button type="button" disabled={busy} onClick={async () => {
      setBusy(true); setError('');
      try { setEntries(await host.workHistory!(issue)); }
      catch (error) { setEntries(undefined); setError(error instanceof Error ? error.message : '读取历史失败'); }
      finally { setBusy(false); }
    }}>{busy ? '读取中…' : '读取修改历史'}</button>
    {error && <p role="alert">{error}</p>}
    {entries?.length === 0 && <p>暂无人工保存的版本</p>}
    {entries?.slice().reverse().map(entry => <article key={entry.revision}>
      <h4>版本 {entry.revision} · {entry.value.module || '未指定类别'}</h4>
      <p className={styles.prose}>{entry.value.notes || '未填写分析备注'}</p>
      <details><summary>完整保存内容</summary><pre className={styles.prose}>{JSON.stringify(entry.value, null, 2)}</pre></details>
    </article>)}
  </details>;
}
