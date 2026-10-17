import { type CoordinationSource, type IssueClassification, issueRef, issueRefKey } from '../model/issue-coordination.js';
import { useEffect, useId, useRef } from 'react';
import styles from './classifications.module.css';

const facets = { area: '模块', kind: '类型', symptom: '表现', environment: '环境' } as const;
const facetKeys = Object.keys(facets) as (keyof typeof facets)[];
const tagsFor = (result: IssueClassification) =>
  facetKeys.flatMap((facet) => result.labels[facet].map((label) => `${facets[facet]}：${label}`));

function ClassificationFacets({ result }: { result: IssueClassification }) {
  return (
    <dl className={styles.facets}>
      {facetKeys.map((facet) => (
        <div key={facet}>
          <dt>{facets[facet]}</dt>
          <dd>{result.labels[facet].join('、') || '未提取'}</dd>
        </div>
      ))}
    </dl>
  );
}

export function IssueClassificationCandidate({
  result,
  sourceUpdatedAt,
  tags,
  changeTags,
}: {
  result?: IssueClassification;
  sourceUpdatedAt: string;
  tags: string;
  changeTags: (value: string) => void;
}) {
  if (!result) return <p className={styles.meta}>这条问题尚无本批分类结果。</p>;
  const existing = new Set(tags.split(/[,，;；\n]/).map((tag) => tag.trim()));
  const missing = tagsFor(result).filter((tag) => !existing.has(tag));
  return (
    <section className={styles.candidate} aria-label="模型候选分类">
      <h4>模型候选分类</h4>
      <p className={styles.meta}>
        初始候选 · {result.model} · {result.generatedAt.slice(0, 10)}
      </p>
      {sourceUpdatedAt !== result.source.updatedAt && <p className={styles.stale}>来源已更新，候选需要重新核对。</p>}
      <ClassificationFacets result={result} />
      <p className={styles.evidence}>依据：{result.evidence}</p>
      <button
        type="button"
        disabled={!missing.length}
        onClick={() => changeTags([tags.trim(), ...missing].filter(Boolean).join('；'))}
      >
        {missing.length ? '加入本地标记草稿' : '已在本地标记中'}
      </button>
      <p className={styles.meta}>可修改后保存本仓记录；来源标签保持独立。</p>
    </section>
  );
}

export function IssueClassificationResults({
  sources,
  select,
  initialOpen = false,
}: {
  sources: CoordinationSource[];
  select: (key: string) => void;
  initialOpen?: boolean;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useId();
  const results = sources.flatMap((source) =>
    (source.classifications ?? []).flatMap((result) => {
      const fact = source.issues.find(
        (item) => item.id === result.source.issueId && item.number === result.source.number,
      );
      return fact ? [{ source, fact, result }] : [];
    }),
  );
  const count = sources.reduce((total, source) => total + source.issues.length, 0);
  useEffect(() => {
    if (initialOpen) dialog.current?.showModal();
    return () => dialog.current?.close();
  }, [initialOpen]);
  return (
    <>
      <button type="button" onClick={() => dialog.current?.showModal()}>
        分类结果 · {results.length}
      </button>
      <dialog ref={dialog} className={styles.overview} aria-labelledby={heading} data-testid="classification-results">
        <header className={styles.heading}>
          <div>
            <h2 id={heading}>初始分类结果</h2>
            <p className={styles.meta}>
              {results.length} 条候选 / 当前可读 {count} 个问题
            </p>
          </div>
          <button type="button" onClick={() => dialog.current?.close()} aria-label="关闭分类结果">
            关闭
          </button>
        </header>
        <div className={styles.resultsBody}>
          <p className={styles.explanation}>
            从选定问题的标题与正文提炼模块、类型、表现和环境。当前是初始样本，尚未全量自动分类或验证准确率；候选需要人工核对。
          </p>
          {!results.length && <p>当前可读取的来源还没有分类结果。</p>}
          <div className={styles.results}>
            {results.map(({ source, fact, result }) => (
              <article key={`${source.profile.id}:${result.id}`} className={styles.result}>
                <p className={styles.meta}>
                  {source.preference.value.name}
                  {source.profile.synthetic ? ' · 合成测试' : ''}
                </p>
                <h3>
                  <button
                    type="button"
                    onClick={() => {
                      select(issueRefKey(issueRef(source.profile.id, fact)));
                      dialog.current?.close();
                    }}
                  >
                    #{fact.number} · {fact.title}
                  </button>
                </h3>
                <ClassificationFacets result={result} />
                <p className={styles.evidence}>
                  依据：<span>{result.evidence}</span>
                </p>
                <p className={styles.meta}>
                  {result.model} · {result.generatedAt.slice(0, 10)}
                  {fact.updatedAt !== result.source.updatedAt ? ' · 来源已更新，需复核' : ''}
                </p>
              </article>
            ))}
          </div>
        </div>
        <footer className={styles.footer}>点击问题标题进入研判，可将候选加入本地草稿，再由你保存。</footer>
      </dialog>
    </>
  );
}
