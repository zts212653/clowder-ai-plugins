import { useRef, useState } from 'react';
import type { TeamHost, TeamIssueContext } from '../ports/team.js';
import type { TeamRecord, TeamRecordDetail } from '../team/records.js';
import styles from './team.module.css';

export function TeamAssignment({ host, context, row, busy, act }: {
  host: TeamHost; context: TeamIssueContext; row?: TeamRecordDetail; busy: boolean;
  act: (work: () => Promise<TeamRecord>) => Promise<void>;
}) {
  const options = context.assignmentOptions;
  const [login, setLogin] = useState(options.preferredLogin ?? '');
  const [delivery, setDelivery] = useState<'invitation' | 'assignment'>(row && row.kind !== 'inbox' && row.assignment ? row.assignment.delivery ?? 'assignment' : 'assignment');
  const [confirming, setConfirming] = useState(false);
  const requestId = useRef<string>();
  const record = row && row.kind !== 'inbox' && (row.kind === 'assignment' || row.analysis) ? row : undefined;
  if (record?.assignment && ['assigned', 'invited'].includes(record.assignment.status)) return null;
  if (!options.members.length) return <p className={styles.notice}>{options.error || '关联组织暂无可用成员，请刷新组织成员后重试'}</p>;
  const blocked = busy || row?.sourceStale || context.currentIssue.state !== 'open' || !options.members.includes(login)
    || context.currentIssue.assignees.some(member => member !== login);
  async function assign() {
    if (record) return host.assign({ id: record.id, expectedRevision: record.revision, login, delivery });
    requestId.current ??= crypto.randomUUID();
    return host.assignIssue({ repo: context.currentIssue.repo, number: context.currentIssue.number,
      sourceVersion: context.sourceVersion, requestId: requestId.current, login, delivery });
  }
  return <div>
    {options.error && <p className={styles.notice}>{options.error}</p>}
    <label>派工方式
      <select aria-label="派工方式" value={delivery} disabled={busy || confirming || !!record?.assignment?.commentAttempted}
        onChange={event => { setDelivery(event.target.value as 'invitation' | 'assignment'); requestId.current = undefined; }}>
        <option value="assignment">设置 GitHub 负责人</option>
        <option value="invitation">通知成员接手</option>
      </select>
    </label>
    <label>指派给组员
      <select aria-label="指派给组员" value={login} disabled={busy || confirming || !!record?.assignment?.commentAttempted}
        onChange={event => { setLogin(event.target.value); requestId.current = undefined; }}>
        <option value="">选择组织成员</option>
        {options.members.map(member => <option key={member} value={member}>@{member}</option>)}
      </select>
    </label>
    <p className={styles.muted}>{delivery === 'assignment'
      ? '派工会在 GitHub Issue 的 Assignees 中标记负责人，并在 Open 列表显示认领人。'
      : '只发送邀请，不标记已认领；认领状态仍以 GitHub 负责人为准。'}</p>
    <p className={styles.muted}>{options.basis === 'reporter'
      ? `提交者 @${options.preferredLogin} 是组员，优先交给本人及本人配置的猫猫处理。`
      : '只列出当前 GitHub 组织成员；发送时重新检查成员资格与所选操作的权限，并保留已有负责人。'}</p>
    {context.currentIssue.assignees.length > 0 && <p>当前负责人：{context.currentIssue.assignees.join('、')}。如需改派，请先在 GitHub 核对。</p>}
    {confirming ? <div className={styles.notice}>
      <p>将 {context.currentIssue.repo}#{context.currentIssue.number} {delivery === 'invitation' ? '发送任务邀请给' : '设置负责人为'} @{login}，并在 GitHub 公开记录{record?.analysis
        ? `研判分数 ${record.analysis.score == null ? '待研判' : `${record.analysis.score} / 10`} 和研判理由。`
        : '主人直接指派；尚无猫猫研判分数。'}</p>
      {delivery === 'invitation' && <p>在 Issue 评论中通知对方；邀请发出后仍待对方接手，GitHub 负责人保持原样。</p>}
      <p>成员的插件启用收件后，会通知本人配置的猫猫；此操作不会自动修代码或合入。</p>
      <div className={styles.actions}>
        <button type="button" disabled={blocked} onClick={() => void act(assign)}>{delivery === 'invitation' ? '确认发送邀请' : '确认指派'}</button>
        <button type="button" disabled={busy} onClick={() => setConfirming(false)}>取消</button>
      </div>
    </div> : <button type="button" disabled={blocked} onClick={() => setConfirming(true)}>{delivery === 'invitation' ? '通知成员接手' : '指派任务'}</button>}
  </div>;
}
