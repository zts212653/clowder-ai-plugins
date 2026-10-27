import styles from './issue-claim-state.module.css';

/** Current GitHub ownership, independent of invitations, cat analysis and local drafts. */
export function IssueClaimState({ assignees }: { assignees?: string[] }) {
  const state = assignees === undefined ? 'unknown' : assignees.length ? 'claimed' : 'unclaimed';
  return <span className={styles.claim} data-claim-state={state}
    title={state === 'unknown' ? '更新来源后核对 GitHub 负责人。' : '以 GitHub Issue 的 Assignees 为准；邀请不代表已认领。'}>
    {state === 'unknown' ? '认领状态待更新' : state === 'claimed'
      ? `已认领 · ${assignees!.map(login => `@${login}`).join('、')}` : '未认领'}
  </span>;
}
