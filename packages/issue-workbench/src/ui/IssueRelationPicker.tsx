import { issueRefKey } from '../model/issue-coordination.js';
import { useEffect, useId, useRef, useState } from 'react';
import type { RelationCandidate } from './CoordinationLinks';
import styles from './coordination.module.css';

const normalize = (text: string) => text.normalize('NFKC').toLocaleLowerCase().trim();
const label = (candidate: RelationCandidate) => `${candidate.source} #${candidate.ref.number} · ${candidate.title}`;

export function IssueRelationPicker({
  candidates,
  value,
  change,
}: {
  candidates: RelationCandidate[];
  value: string;
  change: (key: string) => void;
}) {
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [activeKey, setActiveKey] = useState('');
  const selected = candidates.find((candidate) => issueRefKey(candidate.ref) === value);
  useEffect(() => {
    if (value && !selected) change('');
  }, [value, selected, change]);
  const terms = normalize(query).split(/\s+/).filter(Boolean);
  const matches = candidates.filter((candidate) => {
    const text = normalize(label(candidate));
    return terms.every((term) => text.includes(term));
  });
  // Exact issue numbers precede partial matches, without collapsing equal numbers across sources.
  const exactNumber = (candidate: RelationCandidate) =>
    terms.some((term) => term.replace(/^#/, '') === String(candidate.ref.number));
  matches.sort((a, b) => Number(exactNumber(b)) - Number(exactNumber(a)));
  const options = matches.slice(0, 30);
  const activeIndex = options.findIndex((candidate) => issueRefKey(candidate.ref) === activeKey);
  const activeId = activeIndex < 0 ? undefined : `${id}-option-${activeIndex}`;
  useEffect(() => {
    if (open && activeId) document.getElementById(activeId)?.scrollIntoView({ block: 'nearest' });
  }, [open, activeId]);
  function choose(candidate: RelationCandidate) {
    change(issueRefKey(candidate.ref));
    setQuery('');
    setActiveKey('');
    setOpen(false);
  }
  return (
    <div className={styles.issuePicker}>
      <label htmlFor={id}>关联问题</label>
      <div className={styles.pickerInput}>
        <input
          id={id}
          ref={input}
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={open}
          aria-controls={open ? `${id}-list` : undefined}
          aria-activedescendant={open ? activeId : undefined}
          aria-describedby={`${id}-hint`}
          autoComplete="off"
          placeholder="搜索标题、#编号或来源"
          value={selected ? label(selected) : query}
          onFocus={() => setOpen(true)}
          onBlur={() => setOpen(false)}
          onChange={(event) => {
            setQuery(event.target.value);
            change('');
            setActiveKey('');
            setOpen(true);
          }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing || event.keyCode === 229) return;
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault();
              setOpen(true);
              if (!options.length) return;
              const next =
                event.key === 'ArrowDown'
                  ? (activeIndex + 1) % options.length
                  : activeIndex <= 0
                    ? options.length - 1
                    : activeIndex - 1;
              setActiveKey(issueRefKey(options[next].ref));
            } else if (event.key === 'Enter' && open) {
              event.preventDefault();
              if (activeIndex >= 0) choose(options[activeIndex]);
            } else if (event.key === 'Escape') {
              event.preventDefault();
              setOpen(false);
              setActiveKey('');
            }
          }}
        />
        {(selected || query) && (
          <button
            type="button"
            aria-label="清除关联问题选择"
            onClick={() => {
              change('');
              setQuery('');
              setActiveKey('');
              input.current?.focus();
            }}
          >
            清除
          </button>
        )}
      </div>
      <span id={`${id}-hint`} className={styles.muted}>
        输入部分文字；多个关键词用空格分隔。选择后再保存关联。
      </span>
      {open && (
        <>
          <div id={`${id}-list`} role="listbox" aria-label="关联问题候选" className={styles.pickerOptions}>
            {options.map((candidate, index) => (
              <button
                type="button"
                role="option"
                id={`${id}-option-${index}`}
                key={issueRefKey(candidate.ref)}
                tabIndex={-1}
                aria-selected={activeKey === issueRefKey(candidate.ref)}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => choose(candidate)}
              >
                <span className={styles.muted}>
                  {candidate.source} #{candidate.ref.number}
                </span>
                <span>{candidate.title}</span>
              </button>
            ))}
          </div>
          <span className={styles.muted} role="status">
            {!matches.length
              ? '没有匹配的问题，请更换关键词。'
              : matches.length > options.length
                ? `匹配 ${matches.length} 个，显示前 ${options.length} 个；继续输入可缩小范围。`
                : `匹配 ${matches.length} 个问题`}
          </span>
        </>
      )}
    </div>
  );
}
