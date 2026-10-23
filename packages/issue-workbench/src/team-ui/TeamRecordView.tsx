import type { TeamRecordDetail } from '../team/records.js';
import styles from './team.module.css';

export function TeamRecordView({ row }: { row: TeamRecordDetail }) {
  const analysis = row.kind === 'analysis' ? row.analysis : undefined;
  const score = row.kind === 'inbox' ? row.score : row.analysis?.score;
  const reports = { accepted: '已接手', working: '处理中', blocked: '受阻', ready: '待验证' };
  return <div className={styles.result}>
    {row.sourceStale && <p className={styles.notice}>原文已更新，请重新研判</p>}
    <dl>
      <div><dt>优先级</dt><dd>{score == null ? '待研判' : `${score} / 10`}</dd></div>
      <div><dt>当前负责人</dt><dd>{row.currentIssue.assignees.map(login => `@${login}`).join('、') || '未认领'}</dd></div>
      <div><dt>提交者</dt><dd>{row.currentIssue.author ? `@${row.currentIssue.author}` : '无法确认'}</dd></div>
      <div><dt>工作人员组</dt><dd>{row.assignmentOptions.groupName || '尚未配置'}</dd></div>
      <div><dt>来源状态</dt><dd>{row.currentIssue.state === 'open' ? 'Open · 开放' : 'Closed · 已关闭'}</dd></div>
    </dl>
    {row.assignmentOptions.acceptanceSuggestedFor && <div className={styles.notice}>
      <p>建议合入前邀请 @{row.assignmentOptions.acceptanceSuggestedFor} 参与验收</p>
      <p className={styles.muted}>这是一项建议，尚不表示已验收；研判反馈和成员接手回执也不等于修复验收。</p>
    </div>}
    {analysis && <>
      <p>{row.kind === 'analysis' && row.features.length ? `随 Feature 处理 · ${row.features.join('、')}` : analysis.category}</p>
      <p>{analysis.reason}</p>
      <details><summary>依据与研判来源</summary>
        <blockquote>{analysis.evidence}</blockquote>
        <p>{analysis.blocksRuntime ? '运行受阻' : '未报告运行阻塞'} · {analysis.workaround || '未提供替代办法'}</p>
        <p>研判猫：{row.kind === 'analysis' ? row.catId : ''}</p>
      </details>
    </>}
    {row.kind === 'analysis' && row.status !== 'analyzed' &&
      <p role="status">{row.status === 'delivered' ? '已发送，等待研判' : '待发送'}</p>}
    {row.kind !== 'assignment' && row.error && <p role="alert">{row.error}</p>}
    {row.kind !== 'inbox' && row.assignment && <p>
      {row.assignment.status === 'invited' ? '任务邀请已发布，等待成员接手' : row.assignment.status === 'assigned' ? '分配与公开记录已写入 GitHub'
        : row.assignment.status === 'needs-decision' ? '分配需要确认' : '分配待核对'}
      {row.assignment.reason ? ` · ${row.assignment.reason}` : ''}
    </p>}
    {row.kind === 'inbox' && <p>{row.status === 'inactive' ? '原分配已结束' : row.status === 'delivered' ? '团队已收取' : '等待投递'}
      {row.withdrawal?.status === 'pending' ? ' · 变更提醒待发送' : row.withdrawal?.status === 'delivered' ? ' · 变更提醒已发送' : ''}</p>}
    {row.kind === 'inbox' && row.receipt && <p>{row.receipt.commentId ? '回执已发布' : '回执发布结果待核对'}</p>}
    <p>{row.sharedReceipts.length ? '历史成员报告（按当时任务记录）' : '暂无成员接手回执'}</p>
    {row.sharedReceipts.map(report => <div key={report.id} className={styles.report}>
      <strong>{report.login} · {reports[report.status]}</strong>
      <p>{report.summary}</p>
      {report.evidenceUrls.map(url => <a key={url} href={url} target="_blank" rel="noreferrer">查看 GitHub 证据</a>)}
    </div>)}
  </div>;
}
