import { useState } from 'react';
import type { TeamHost } from '../ports/team.js';
import type { TeamRecordDetail } from '../team/records.js';
import styles from './team.module.css';

export function TeamAcceptance({ host, row, busy, act }: {
  host: TeamHost; row: TeamRecordDetail; busy: boolean; act: (work: () => Promise<unknown>) => Promise<void>;
}) {
  const [copied, setCopied] = useState('');
  if (row.kind !== 'inbox' || !row.receiver) return null;
  const receiver = row.receiver;
  return <section aria-label="接单与开工">
    <h4>接单与开工</h4>
    {!receiver.current ? <p>当前分配已变化，请刷新并核对后再接单。</p> : <>
      {!receiver.accepted ? <>
        <p>确认由你的团队接手后，在收件对话中发出开工指令。</p>
        <button type="button" disabled={busy} onClick={() => void act(() => host.acceptInbox({ id: row.id, expectedRevision: row.revision }))}>接下此任务</button>
      </> : <>
        <p>你已接下任务。开工与处理进度以收件对话为准。</p>
        <label>开工指令<textarea aria-label="开工指令" value={receiver.requestText} readOnly rows={5} /></label>
        <div className={styles.actions}>
          <button type="button" onClick={async () => {
            try { await navigator.clipboard.writeText(receiver.requestText); setCopied('已复制，请到收件对话粘贴并发送'); }
            catch { setCopied('复制失败，请选中上方文字复制'); }
          }}>复制开工指令</button>
          {receiver.threadUrl && <a href={receiver.threadUrl} target="_blank" rel="noreferrer">打开收件对话</a>}
        </div>
        {copied && <p role="status">{copied}</p>}
        <p className={styles.muted}>在对话中确认并发送后，猫猫才按你的托付接续任务。此处接单记录保存在本猫咖；公开进展由启用分享后的成员回报。</p>
      </>}
    </>}
  </section>;
}
