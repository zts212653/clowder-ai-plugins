import { type IssueClassification, type IssueInvestigation } from '../model/issue-coordination.js';
import styles from './coordination.module.css';
import { IssueClassificationCandidate } from './IssueClassifications';
import { IssueContextFacets } from './IssueContextFacets';
import type { IssueContextClassification } from '../classification/issue-context';
import { IssueCategoryPicker } from './IssueCategoryPicker';
import { categoryDefinition } from '../classification/taxonomy';

export function CoordinationEditor({
  value, subject, classification, context, featureBindings, sourceUpdatedAt, change, save, busy, dirty, error,
}: {
  value: IssueInvestigation;
  subject: string;
  classification?: IssueClassification;
  context?: IssueContextClassification;
  featureBindings?: string[];
  sourceUpdatedAt: string;
  change: (value: IssueInvestigation) => void;
  save: () => Promise<void>;
  busy: boolean;
  dirty: boolean;
  error: string;
}) {
  const historical = [
    ['分析证据', value.evidence], ['目标分支', value.branch], ['代码基线', value.base],
    ['修复引用', value.patch], ['任务链接', value.taskUrl], ['验证证据', value.verificationEvidence],
    ['标签建议', value.labelDraft], ['原自定义标记', value.tags],
    ['原问题类别', featureBindings?.length ? value.module : ''],
    ['原补丁记录', value.adoption === 'pending' ? '' : value.adoption === 'applied' ? '已纳入' : '无需改动'],
    ['原验证记录', value.verification === 'pending' ? '' : value.verification === 'passed' ? '已记录通过' : '仍可复现'],
  ].filter(([, text]) => text);
  return (
    <form onSubmit={(e) => { e.preventDefault(); void save(); }} className={styles.editor}>
      <div className={styles.editorIntro}>
        <h3>分类分析</h3>
        <p className={styles.editorSubject} title={subject}>{subject}</p>
        <p className={styles.muted}>先看自动结果，需要时调整分类或补充说明，再派工。</p>
      </div>
      <div className={styles.editorBody}>
        {context && <IssueContextFacets context={context} />}
        {!featureBindings?.length && <IssueCategoryPicker value={value.module} areas={classification?.labels.area}
          change={module => change({ ...value, module })} />}
        <IssueClassificationCandidate result={classification} featureBindings={featureBindings} sourceUpdatedAt={sourceUpdatedAt} />
        <p className={styles.muted}>选类只保存本地，不改来源标签；已有自定义标记保留在历史记录中。</p>
        {value.notes && <p className={styles.prose}>分析备注：{value.notes}</p>}
        <details className={styles.fieldGroup}>
          <summary>补充分析（可选）</summary>
          <label>分析备注<textarea aria-label="分析备注" rows={3} value={value.notes}
            placeholder="补充自动结果未覆盖的背景或派工依据"
            onChange={(e) => change({ ...value, notes: e.target.value })} /></label>
        </details>
        {!!historical.length && <details className={styles.fieldGroup}>
          <summary>已有历史记录（只读）</summary>
          <p className={styles.muted}>旧记录继续保留，当前工作台负责分类分析和派工。</p>
          <dl>{historical.map(([label, text]) => <div key={label}><dt>{label}</dt><dd className={styles.prose}>{text}</dd></div>)}</dl>
        </details>}
      </div>
      <div className={styles.saveBar}>
        <button type="submit" disabled={busy || !dirty}>{busy ? '保存中…' : '保存分析'}</button>
        <span role="status">{dirty ? '未保存 · 切换视图保留输入' : featureBindings?.length ? '随 Feature 处理 · 原记录保留'
          : value.module ? `已保存分类 · ${categoryDefinition(value.module)?.label ?? '待判断（原名称保留）'}` : '自动建议直接展示，无需重复填写'}</span>
        {error && <p role="alert">{error}</p>}
      </div>
    </form>
  );
}
