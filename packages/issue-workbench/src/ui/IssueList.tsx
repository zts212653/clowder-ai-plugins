'use client';

import styles from './workbench.module.css';
import { IssueSourceState } from './IssueSourceState';
import { emptyWork, type IssueFact, type LocalWork, type Stage, stageNames } from './workbench-model';

export function IssueList({
  visible,
  records,
  query,
  filter,
  selected,
  onSearch,
  onFilter,
  onSelect,
}: {
  visible: IssueFact[];
  records: Record<string, LocalWork>;
  query: string;
  filter: string;
  selected: number;
  onSearch: (value: string) => void;
  onFilter: (value: string) => void;
  onSelect: (value: number) => void;
}) {
  return (
    <aside className={styles.list} aria-label="问题列表">
      <label className={styles.search}>
        <span className={styles.srOnly}>搜索问题</span>
        <input
          type="search"
          aria-label="搜索问题"
          value={query}
          onChange={(event) => onSearch(event.target.value)}
          placeholder="搜索编号、标题或工作标签"
        />
      </label>
      <div className={styles.listMeta}>
        <span>
          {filter === 'all' ? '当前范围' : stageNames[filter as Stage]} · {visible.length}
        </span>
        {filter !== 'all' && (
          <button type="button" onClick={() => onFilter('all')}>
            清除筛选
          </button>
        )}
      </div>
      <div className={styles.rows}>
        {visible.length ? (
          visible.map((item) => {
            const local = records[item.number] ?? emptyWork();
            return (
              <button
                type="button"
                className={styles.issueRow}
                key={item.number}
                aria-pressed={selected === item.number}
                onClick={() => {
                  onSelect(item.number);
                }}
              >
                <span className={styles.rowMeta}>
                  <span>#{item.number}</span>
                  <span>{stageNames[local.stage]}</span>
                </span>
                <IssueSourceState fact={item} />
                <span className={styles.rowTitle}>{item.title}</span>
                {local.tags.length > 0 && <span className={styles.localTagText}>{local.tags.join(' · ')}</span>}
              </button>
            );
          })
        ) : (
          <div className={styles.empty}>
            <p>没有匹配的问题。</p>
            <button
              type="button"
              onClick={() => {
                onSearch('');
                onFilter('all');
              }}
            >
              查看全部问题
            </button>
          </div>
        )}
      </div>
    </aside>
  );
}
