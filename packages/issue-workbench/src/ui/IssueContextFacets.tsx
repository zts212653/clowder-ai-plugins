import { originLabels, systemLabels, type IssueContextClassification } from '../classification/issue-context';
import styles from './classifications.module.css';

export function IssueContextFacets({ context, compact = false }: { context: IssueContextClassification; compact?: boolean }) {
  return <section aria-label="问题来源与操作系统">
    <dl className={styles.facets}>
      <div><dt>问题来源</dt><dd>{originLabels[context.origin]}</dd></div>
      <div><dt>操作系统</dt><dd>{context.systems.map(system => systemLabels[system]).join('、') || '待判断'}</dd></div>
    </dl>
    {!compact && <>
      <p className={styles.meta}>{context.basis === 'title' ? '暂按标题判断；读取正文后补全。' : '根据标题和正文自动判断；信息不足时保留待判断。'}</p>
      {(!!context.originEvidence.length || !!context.systemEvidence.length) && <details>
        <summary>查看判断依据</summary>
        {!!context.originEvidence.length && <p className={styles.evidence}>来源依据：{context.originEvidence.join('；')}</p>}
        {!!context.systemEvidence.length && <p className={styles.evidence}>系统依据：{context.systemEvidence.join('；')}</p>}
      </details>}
    </>}
  </section>;
}
