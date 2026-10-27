import { useState } from 'react';
import type { TeamHost } from '../ports/team.js';
import type { TeamRecordDetail } from '../team/records.js';

export function TeamRecovery({ host, row, busy, act }: {
  host: TeamHost; row: TeamRecordDetail; busy: boolean;
  act: (work: () => Promise<unknown>) => Promise<void>;
}) {
  const [confirm, setConfirm] = useState(false);
  const uncertain = row.kind !== 'inbox'
    ? !!row.assignment?.commentAttempted && !row.assignment.commentId
    : !!row.receipt?.commentAttempted && !row.receipt.commentId;
  const retryable = (row.kind !== 'assignment' || row.automatic) && ((row.kind !== 'assignment' && row.error) || uncertain || (row.kind !== 'inbox'
    ? row.assignment && !['assigned', 'invited'].includes(row.assignment.status)
    : row.status === 'pending' || row.withdrawal?.status === 'pending'));
  return <>
    {retryable && <button type="button" disabled={busy}
      onClick={() => void act(() => host.retry(row.id))}>重试此记录</button>}
    {uncertain && <div>
      <button type="button" disabled={busy} onClick={() => setConfirm(true)}>核对并重新发布</button>
      {confirm && <div role="group" aria-label="确认重新发布">
        <p>先核对 GitHub 评论。上次发布结果不确定，重新发布可能产生重复评论；不会更改负责人。</p>
        <a href={row.issue.url} target="_blank" rel="noreferrer">查看原问题</a>
        <button type="button" disabled={busy} onClick={() => {
          setConfirm(false); void act(() => host.republish(row.id, row.revision));
        }}>确认重新发布</button>
        <button type="button" onClick={() => setConfirm(false)}>取消</button>
      </div>}
    </div>}
  </>;
}
