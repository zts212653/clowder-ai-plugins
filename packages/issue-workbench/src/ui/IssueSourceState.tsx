import type { IssueSourceFact } from '../model/issue-coordination.js';
import styles from './issue-source-state.module.css';
import { IssueClaimState } from './IssueClaimState';

type StateFact = Pick<IssueSourceFact, 'state' | 'unavailable' | 'assignees'>;
export function issueSourceState(fact: StateFact) {
  if (fact.unavailable) return 'UNAVAILABLE';
  return fact.state === 'OPEN' || fact.state === 'CLOSED' ? fact.state : 'UNKNOWN';
}
export function matchesSourceState(fact: StateFact, filter: string) {
  const state = issueSourceState(fact);
  return filter === 'all' || (filter === 'OTHER' ? state === 'UNKNOWN' || state === 'UNAVAILABLE' : state === filter);
}
const labels = {
  OPEN: 'Open · 开放',
  CLOSED: 'Closed · 已关闭',
  UNKNOWN: 'Unknown · 未知',
  UNAVAILABLE: '来源暂不可用',
};

/** Source lifecycle is independent of this repository's investigation/verification. */
export function IssueSourceState({ fact }: { fact: StateFact }) {
  const state = issueSourceState(fact);
  return (
    <>
    <span
      className={styles.badge}
      data-source-state={state}
      title={state === 'CLOSED' ? '来源已关闭；本仓是否修复仍以本仓验证记录为准。' : '来源平台的问题状态'}
    >
      <svg
        width="14"
        height="14"
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        aria-hidden="true"
      >
        <circle cx="8" cy="8" r="6" />
        {state === 'CLOSED' ? (
          <path d="m4.7 8 2.2 2.2 4.4-4.4" />
        ) : state === 'OPEN' ? (
          <path d="M8 4.5v4M8 10.5v1" />
        ) : (
          <path d="M5 8h6" />
        )}
      </svg>
      {labels[state]}
    </span>
    {state === 'OPEN' && <IssueClaimState assignees={fact.assignees} />}
    </>
  );
}

export function IssueSourceStateFilter({
  facts,
  value,
  change,
}: {
  facts: StateFact[];
  value: string;
  change: (value: string) => void;
}) {
  const options = [
    { key: 'all', label: '全部' },
    { key: 'OPEN', label: 'Open' },
    { key: 'CLOSED', label: 'Closed' },
    { key: 'OTHER', label: '其他状态' },
  ].map((option) => ({ ...option, count: facts.filter((fact) => matchesSourceState(fact, option.key)).length }));
  return (
    <div className={styles.filters} role="group" aria-label="来源状态筛选">
      {options
        .filter((option) => option.key !== 'OTHER' || option.count || value === 'OTHER')
        .map((option) => (
          <button key={option.key} type="button" aria-pressed={value === option.key} onClick={() => change(option.key)}>
            {option.label} · {option.count}
          </button>
        ))}
    </div>
  );
}
