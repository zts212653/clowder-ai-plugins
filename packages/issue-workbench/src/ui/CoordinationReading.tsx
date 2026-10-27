import type { CoordinationDetail, CoordinationHost, IssueRef, IssueSourceFact } from '../model/issue-coordination.js';
import { useEffect, useRef, useState } from 'react';
import styles from './coordination.module.css';
import { IssueContent } from './IssueDiscussion';

/** Parent keys this view by full issue identity. Late pages cannot enter another reading. */
export function CoordinationReading({ host, issue, onDetail }: { host: CoordinationHost; issue: IssueRef;
  onDetail?: (ref: IssueRef, fact: IssueSourceFact | null) => void }) {
  const [detail, setDetail] = useState<CoordinationDetail | null>(null);
  const [busy, setBusy] = useState(false);
  const generation = useRef(0),
    flight = useRef(false);
  async function read(more = false) {
    if (flight.current) return;
    flight.current = true;
    setBusy(true);
    const id = ++generation.current;
    try {
      const next = await host.detail(
        issue,
        more ? (detail?.nextOffset ?? 0) : 0,
        more ? detail?.pageVersion ?? detail?.fact?.contentVersion : undefined,
      );
      if (generation.current !== id) return;
      if (!more) onDetail?.(issue, next.fact);
      if (more && (!next.fact || (next.pageVersion ?? next.fact.contentVersion) !== (detail?.pageVersion ?? detail?.fact?.contentVersion))) {
        setDetail((old) => (old ? { ...old, error: '讨论版本不一致，请重新读取正文。' } : old));
        return;
      }
      setDetail(
        more
          ? {
              ...next,
              fact: { ...next.fact!, comments: [...(detail?.fact?.comments ?? []), ...(next.fact?.comments ?? [])] },
            }
          : next,
      );
    } catch (error) {
      if (generation.current === id && [401, 403].includes((error as { status?: number }).status ?? 0)) onDetail?.(issue, null);
      if (generation.current === id)
        setDetail((old) =>
          [401, 403].includes((error as { status?: number }).status ?? 0)
            ? { fact: null, error: '来源未授权，正文已隐藏。' }
            : { ...(old ?? { fact: null }), error: '读取失败，已读取内容仍保留。' },
        );
    } finally {
      if (generation.current === id) {
        setBusy(false);
        flight.current = false;
      }
    }
  }
  useEffect(() => {
    void read();
    return () => {
      generation.current++;
      flight.current = false;
    };
  }, [host, issue.sourceId, issue.issueId]);
  return (
    <>
      <div className={styles.readingTools}>
        <h3>来源正文与讨论</h3>
        <button onClick={() => void read()} disabled={busy}>
          {busy ? '正在读取正文…' : '重新读取正文'}
        </button>
      </div>
      <section className={styles.discussion}>
        {!detail ? (
          <p>正在按需读取…</p>
        ) : (
          <>
            {detail.error && <p role="status">{detail.error}</p>}
            <IssueContent body={detail.fact?.body ?? '暂无正文'} url={detail.fact?.url ?? ''} />
            <details className={styles.comments}>
              <summary>讨论 · 已读取 {detail.fact?.comments?.length ?? 0} 条</summary>
              {detail.fact?.comments?.map((c) => (
                <article key={c.id}>
                  <p className={styles.muted}>
                    {c.author} · {c.createdAt}
                  </p>
                  <IssueContent body={c.body} url={detail.fact?.url ?? ''} />
                </article>
              ))}
              {detail.nextOffset != null && (
                <button disabled={busy} onClick={() => void read(true)}>
                  加载更多评论
                </button>
              )}
            </details>
          </>
        )}
      </section>
    </>
  );
}
