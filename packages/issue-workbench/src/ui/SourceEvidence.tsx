'use client';
import { useState } from 'react';
import { IssueDiscussion } from './IssueDiscussion';
import { loadDiscussionPages } from './source-client';
import styles from './workbench.module.css';
import type { IssueFact } from './workbench-model';
/** Archived input remains readable after GitHub edits, disappearance or an offline refresh. */
export function SourceEvidence({
  version,
  loadVersion,
}: {
  version?: string;
  loadVersion?: (version: string, offset?: number) => Promise<IssueFact>;
}) {
  const [fact, setFact] = useState<IssueFact | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  if (!version || !loadVersion) return null;
  return (
    <details
      className={styles.hint}
      onToggle={async (event) => {
        if (!event.currentTarget.open || fact?.detailVersion === version || busy) return;
        setBusy(true);
        setError('');
        try {
          setFact(await loadVersion(version));
        } catch {
          setError('原文依据暂不可读取，请稍后重试。');
        } finally {
          setBusy(false);
        }
      }}
    >
      <summary>查看保存时的原文依据</summary>
      {busy && <p>正在读取来源档案…</p>}
      {error && <p role="status">{error}</p>}
      {fact && fact.detailVersion === version && (
        <IssueDiscussion
          fact={fact}
          fetchedAt={fact.fetchedAt}
          loadMore={(all) => loadDiscussionPages(fact, loadVersion, setFact, all)}
        />
      )}
    </details>
  );
}
