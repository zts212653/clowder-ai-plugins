import { categoryDecisionRule, categoryDefinition, issueCategories, primaryCategory } from '../classification/taxonomy';
import styles from './coordination.module.css';

export function IssueCategoryPicker({ value, areas, change }: { value: string; areas?: string[]; change: (value: string) => void }) {
  const suggested = primaryCategory(areas);
  const definition = categoryDefinition(value || suggested);
  const legacy = !!value && !issueCategories.some(item => item.label === value);
  return <section aria-label="问题分类">
    <label>问题类别
      <select aria-label="问题类别选择" value={value} onChange={event => change(event.target.value)}>
        <option value="">采用自动建议 · {suggested}</option>
        {legacy && <option value={value}>原记录：{value} · 待核对</option>}
        {issueCategories.map(item => <option key={item.id} value={item.label}>{item.label}</option>)}
      </select>
    </label>
    <p className={styles.muted}>{value ? '保存后按此类别归组。' : '自动建议供参考；需要时直接选择类别。'} 来源、系统和类型是独立标签，不决定主类别。</p>
    {definition ? <div aria-label="当前类别边界">
      <p>适用：{definition.includes}</p><p className={styles.muted}>不含：{definition.excludes}</p>
      <p className={styles.muted}>例：{definition.example}</p>
    </div> : <p className={styles.muted}>原分类名称已保留；不属于当前分类表，暂归待判断。选择明确类别后再保存。</p>}
    <details className={styles.fieldGroup}>
      <summary>分类边界与例子</summary>
      <p>{categoryDecisionRule}</p>
      <dl>{issueCategories.map(item => <div key={item.id}><dt>{item.label}</dt><dd>
        {item.includes}<br />不含：{item.excludes}<br />例：{item.example}
      </dd></div>)}</dl>
    </details>
  </section>;
}
