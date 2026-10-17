import { useSourceClient } from '../ports/context';
'use client';

import { issueReviewContent } from '../model/issue-source.js';
import { useEffect, useState } from 'react';
import { IssueDiscussion } from './IssueDiscussion';
import { IssueStageFlow } from './IssueStageFlow';
import { SourceEvidence } from './SourceEvidence';
import { loadDiscussionPages } from './source-client';
import styles from './workbench.module.css';
import {
  acceptWork,
  type IssueFact,
  type LocalWork,
  labelDiff,
  type Stage,
  sourceVersion,
  stageNames,
} from './workbench-model';

const candidateLabels = [
  'bug',
  'enhancement',
  'question',
  'needs-info',
  'needs-maintainer-decision',
  'duplicate',
  'help wanted',
  'good first issue',
];

export function IssueDetail({
  fact,
  work,
  onSave,
  onBack,
  onDirtyChange,
  fetchedAt,
  detailStatus,
  loadVersion,
}: {
  fact: IssueFact;
  work: LocalWork;
  onSave: (value: LocalWork) => boolean;
  onBack: () => void;
  onDirtyChange: (dirty: boolean) => void;
  fetchedAt?: string;
  detailStatus?: string;
  loadVersion?: (version: string, offset?: number) => Promise<IssueFact>;
}) {
  const { draftAssignees = [] } = useSourceClient();
  const [reading, setReading] = useState(fact);
  useEffect(() => {
    if (reading.body === undefined && fact.body !== undefined) setReading(fact);
    else if (sourceVersion(reading) === sourceVersion(fact) && reading.fetchedAt !== fact.fetchedAt)
      setReading((current) => ({ ...current, fetchedAt: fact.fetchedAt }));
  }, [fact, reading]);
  const [newCommentIds, setNewCommentIds] = useState<string[]>([]);
  const sourceChanged = reading.body !== undefined && sourceVersion(reading) !== sourceVersion(fact);
  const reviewVersion = fact.reviewVersion ?? fact.updatedAt;
  const reviewChanged = work.solutionSource
    ? work.solutionSource !== reviewVersion
    : reading.reviewVersion && fact.reviewVersion
      ? reading.reviewVersion !== fact.reviewVersion
      : issueReviewContent(reading) !== issueReviewContent(fact);
  const labelVersion = JSON.stringify([...fact.labels].sort());
  const labelsChanged = (work.labelSource ?? JSON.stringify([...reading.labels].sort())) !== labelVersion;
  const [tab, setTab] = useState('discussion');
  const [solution, setSolution] = useState(work.solution);
  const [evidence, setEvidence] = useState(work.evidence);
  const [tag, setTag] = useState('');
  const [instruction, setInstruction] = useState(work.instruction);
  const [assignee, setAssignee] = useState(work.assignee);
  const [notice, setNotice] = useState('');
  const diff = labelDiff(fact, work);
  const dirty = solution !== work.solution || evidence !== work.evidence;
  const hasUnsaved = dirty || instruction !== work.instruction || assignee !== work.assignee;
  useEffect(() => {
    onDirtyChange(hasUnsaved);
  }, [hasUnsaved, onDirtyChange]);
  useEffect(() => {
    if (!hasUnsaved) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [hasUnsaved]);
  const save = (patch: Partial<LocalWork>, message: string) => {
    if (
      onSave({
        ...work,
        ...patch,
        ...(patch.addLabels || patch.removeLabels ? { labelSource: labelVersion } : {}),
        revision: work.revision + 1,
      })
    )
      setNotice(message);
  };
  function saveSolution() {
    save(
      {
        solution,
        evidence,
        solutionSource: reading.reviewVersion ?? reading.updatedAt,
        solutionArchive: reading.detailVersion,
        stage: work.stage === 'resolved' ? 'review' : work.stage,
      },
      '方案已保存在此浏览器。',
    );
  }
  function accept() {
    try {
      if (onSave(acceptWork(work))) setNotice('本地验收通过；GitHub 状态未修改。');
    } catch (error) {
      setNotice((error as Error).message);
    }
  }
  function draftTask() {
    const taskDraft = `请${assignee}分析 ${fact.url}\n问题：${fact.title}\n任务：${instruction.trim() || '定位问题，给出可验证的解决方案。'}\n已有方案：${work.solution || '尚无'}\n交付：结论、证据、解决方案、验证结果与未解决项。\n边界：GitHub READ；仅本地分析，未经我验收不标记解决。`;
    save(
      {
        assignee,
        instruction,
        taskDraft,
        taskSource: reading.reviewVersion ?? reading.updatedAt,
        taskArchive: reading.detailVersion,
      },
      '任务草稿已保存，尚未发送给猫猫。',
    );
  }
  return (
    <article className={styles.detail} aria-label={`问题 #${fact.number} 详情`}>
      <button className={styles.mobileBack} onClick={onBack} type="button">
        ← 返回问题列表
      </button>
      <div className={styles.eyebrow}>
        ISSUE #{fact.number} <span className={styles.pill}>GitHub · {fact.state === 'CLOSED' ? '已关闭' : '开放'}</span>
      </div>
      <h2 className={styles.issueTitle}>{fact.title}</h2>
      <div className={styles.row}>
        <a href={fact.url} target="_blank" rel="noreferrer">
          查看线上原文 ↗
        </a>
        <span className={styles.muted}>线上标签</span>
        {fact.labels.length ? (
          fact.labels.map((label) => (
            <span className={styles.sourceTag} key={label}>
              {label}
            </span>
          ))
        ) : (
          <span className={styles.muted}>无</span>
        )}
      </div>
      {fact.unavailable && <p className={styles.callout}>来源暂不可用，保留上次内容与本地工作；这不代表问题已删除。</p>}
      {detailStatus && (
        <p role="status" className={styles.hint}>
          {detailStatus}
        </p>
      )}
      {sourceChanged && (
        <div className={styles.sourceNotice} role="status">
          <span>GitHub 来源有更新{hasUnsaved ? '，未保存内容已保留' : ''} · 阅读区暂保留当前版本。</span>
          <button
            type="button"
            onClick={() => {
              const previousIds = new Set(reading.comments?.map((c) => c.id));
              setNewCommentIds(fact.comments?.filter((c) => !previousIds.has(c.id)).map((c) => c.id) ?? []);
              setReading(fact);
            }}
          >
            查看变化
          </button>
        </div>
      )}
      <div className={styles.localControls}>
        <label>
          本地阶段
          <select
            aria-label="本地阶段"
            value={work.stage}
            onChange={(event) => save({ stage: event.target.value as Stage }, '本地阶段已保存。')}
          >
            {Object.entries(stageNames)
              .filter(([key]) => key !== 'resolved' || work.stage === 'resolved')
              .map(([key, name]) => (
                <option key={key} value={key}>
                  {name}
                </option>
              ))}
          </select>
        </label>
        <IssueStageFlow stage={work.stage} />
        <div className={styles.tags}>
          <span className={styles.muted}>工作标签</span>
          {work.tags.map((value) => (
            <button
              key={value}
              type="button"
              title={`移除本地标签 ${value}`}
              onClick={() => save({ tags: work.tags.filter((t) => t !== value) }, '本地标签已移除。')}
            >
              {value} ×
            </button>
          ))}
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (tag.trim()) {
                save({ tags: [...new Set([...work.tags, tag.trim()])] }, '本地标签已保存。');
                setTag('');
              }
            }}
          >
            <input
              aria-label="新增本地工作标签"
              placeholder="如：待复现"
              value={tag}
              onChange={(event) => setTag(event.target.value)}
              maxLength={40}
            />
            <button type="submit" disabled={!tag.trim()}>
              添加
            </button>
          </form>
        </div>
      </div>
      <div role="tablist" aria-label="问题工作区" className={styles.tabs}>
        {[
          ['discussion', '问题与讨论'],
          ['solution', '解决方案'],
          ['cats', '交给猫猫'],
          ['labels', 'GitHub 标签草稿'],
        ].map(([id, name]) => (
          <button
            key={id}
            id={`issue-tab-${id}`}
            aria-controls={`issue-panel-${id}`}
            type="button"
            role="tab"
            aria-selected={tab === id}
            onClick={() => {
              setTab(id);
              setNotice('');
            }}
          >
            {name}
            {id === 'labels' && diff.add.length + diff.remove.length > 0
              ? ` · ${diff.add.length + diff.remove.length}`
              : ''}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`issue-panel-${tab}`} aria-labelledby={`issue-tab-${tab}`} className={styles.tabBody}>
        {tab === 'discussion' && (
          <IssueDiscussion
            fact={reading}
            fetchedAt={reading.fetchedAt ?? fetchedAt}
            newCommentIds={newCommentIds}
            loadMore={
              loadVersion && reading.detailVersion
                ? (all) =>
                    loadDiscussionPages(
                      reading,
                      loadVersion,
                      (part) =>
                        setReading((current) => (current.detailVersion === part.detailVersion ? part : current)),
                      all,
                    )
                : undefined
            }
          />
        )}
        {tab === 'solution' && (
          <>
            <SourceEvidence key={work.solutionArchive} version={work.solutionArchive} loadVersion={loadVersion} />
            <label className={styles.field}>
              解决方案
              <textarea
                aria-label="解决方案"
                rows={5}
                value={solution}
                onChange={(event) => setSolution(event.target.value)}
                placeholder="写下原因、建议做法和仍待确认的部分。"
              />
            </label>
            <label className={styles.field}>
              验证依据
              <textarea
                aria-label="验证依据"
                rows={3}
                value={evidence}
                onChange={(event) => setEvidence(event.target.value)}
                placeholder="填写复现结果、测试记录或证据链接，供验收时核对。"
              />
            </label>
            {reviewChanged && (work.solution || work.evidence || dirty) && (
              <p className={styles.hint}>来源有更新，方案与验证依据可能需复核；本地阶段保持原样。</p>
            )}
            <div className={styles.row}>
              <button
                className={styles.primary}
                type="button"
                onClick={saveSolution}
                disabled={!dirty || reading.body === undefined}
              >
                保存方案
              </button>
              <button
                type="button"
                disabled={dirty || !work.solution.trim() || work.stage === 'resolved'}
                onClick={() => save({ stage: 'review' }, '已进入待验收。')}
              >
                标记待验收
              </button>
              {work.stage === 'resolved' ? (
                <button type="button" onClick={() => save({ stage: 'analyzing' }, '已重新打开本地工作。')}>
                  重新处理
                </button>
              ) : (
                <button
                  type="button"
                  disabled={dirty || !work.solution.trim() || !work.evidence.trim()}
                  onClick={accept}
                >
                  本地验收通过
                </button>
              )}
            </div>
            <p className={styles.hint}>
              保存方案后可以验收。验收只改变本地进度，不会关闭 GitHub issue。{dirty ? ' 当前有未保存内容。' : ''}
            </p>
          </>
        )}
        {tab === 'cats' && (
          <>
            <SourceEvidence key={work.taskArchive} version={work.taskArchive} loadVersion={loadVersion} />
            <div className={styles.callout}>
              体验稿仅生成任务草稿。正式接入后，会在这里显示猫猫接球、回答与验证结果。
            </div>
            <label className={styles.field}>
              交给谁
              <select aria-label="交给谁" value={assignee} onChange={(event) => setAssignee(event.target.value)}>
                <option value="">待选择目标</option>
                {draftAssignees.map(name => <option key={name}>{name}</option>)}
              </select>
            </label>
            <label className={styles.field}>
              任务要求
              <textarea
                aria-label="任务要求"
                rows={4}
                value={instruction}
                onChange={(event) => setInstruction(event.target.value)}
                placeholder="例如：先复现，给出根因和解决方案，附验证依据。"
              />
            </label>
            <button type="button" className={styles.primary} onClick={draftTask} disabled={reading.body === undefined}>
              生成任务草稿
            </button>
            {work.taskSource && work.taskSource !== reviewVersion && (
              <p className={styles.hint}>来源有更新，任务草稿的依据需复核。</p>
            )}
            {work.taskDraft && (
              <div className={styles.taskDraft}>
                <span className={styles.pill}>待发送 · 不计入处理中</span>
                <pre>{work.taskDraft}</pre>
                <button type="button" onClick={() => save({ taskDraft: undefined }, '任务草稿已撤回。')}>
                  撤回草稿
                </button>
              </div>
            )}
          </>
        )}
        {tab === 'labels' && (
          <>
            <p className={styles.hint}>
              仅记录既有标签的增删建议。READ 账号不能提交；“本地已分析”不会自动变成线上 triaged。
            </p>
            {labelsChanged && (work.addLabels.length > 0 || work.removeLabels.length > 0) && (
              <p className={styles.callout}>
                线上标签已变化，当前差异已重算；草稿意图未改写，请核对。已无差异不代表执行成功。
              </p>
            )}
            <h3>建议添加</h3>
            <div className={styles.labelChoices}>
              {candidateLabels
                .filter((label) => !fact.labels.includes(label))
                .map((label) => (
                  <label key={label}>
                    <input
                      type="checkbox"
                      checked={work.addLabels.includes(label)}
                      onChange={(event) =>
                        save(
                          {
                            addLabels: event.target.checked
                              ? [...work.addLabels, label]
                              : work.addLabels.filter((v) => v !== label),
                          },
                          '标签草稿已保存。',
                        )
                      }
                    />
                    {label}
                  </label>
                ))}
            </div>
            <h3>建议移除</h3>
            <div className={styles.labelChoices}>
              {fact.labels.length ? (
                fact.labels.map((label) => (
                  <label key={label}>
                    <input
                      type="checkbox"
                      checked={work.removeLabels.includes(label)}
                      onChange={(event) =>
                        save(
                          {
                            removeLabels: event.target.checked
                              ? [...work.removeLabels, label]
                              : work.removeLabels.filter((v) => v !== label),
                          },
                          '标签草稿已保存。',
                        )
                      }
                    />
                    {label}
                  </label>
                ))
              ) : (
                <p className={styles.muted}>线上没有标签可移除。</p>
              )}
            </div>
            <p className={styles.hint}>
              当前 {diff.add.length} 项添加、{diff.remove.length} 项移除。可从页面上方预览整批变更。
            </p>
          </>
        )}
      </div>
      <output className={styles.notice}>{notice}</output>
    </article>
  );
}
