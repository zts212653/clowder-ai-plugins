import { type IssueSourceComment, type IssueSourceFact, issueSourceContent } from '../model/issue-source.js';

export type Stage = 'new' | 'analyzing' | 'waiting' | 'review' | 'resolved';
export type IssueFact = IssueSourceFact;
export type IssueComment = IssueSourceComment;

export function sourceTime(value: string) {
  return new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
}
export type LocalWork = {
  stage: Stage;
  tags: string[];
  solution: string;
  evidence: string;
  assignee: string;
  instruction: string;
  taskDraft?: string;
  solutionSource?: string;
  taskSource?: string;
  solutionArchive?: string;
  taskArchive?: string;
  labelSource?: string;
  addLabels: string[];
  removeLabels: string[];
  revision: number;
};
export const emptyWork = (): LocalWork => ({
  stage: 'new',
  tags: [],
  solution: '',
  evidence: '',
  assignee: '',
  instruction: '',
  addLabels: [],
  removeLabels: [],
  revision: 0,
});
export const stageNames: Record<Stage, string> = {
  new: '待分析',
  analyzing: '分析中',
  waiting: '等待补充',
  review: '待验收',
  resolved: '本地已验收',
};
export const STORAGE_KEY = 'cat-cafe:issue-workbench:preview:v1';

export function labelDiff(fact: IssueFact, work: LocalWork): { add: string[]; remove: string[] } {
  return {
    add: [...new Set(work.addLabels)].filter((label) => !fact.labels.includes(label)),
    remove: [...new Set(work.removeLabels)].filter((label) => fact.labels.includes(label)),
  };
}

export function acceptWork(work: LocalWork): LocalWork {
  if (!work.solution.trim() || !work.evidence.trim()) throw new Error('请先保存解决方案和验证依据，再验收。');
  return { ...work, stage: 'resolved', revision: work.revision + 1 };
}

export function summarize(facts: IssueFact[], records: Record<string, LocalWork>) {
  const result = {
    new: 0,
    analyzing: 0,
    waiting: 0,
    review: 0,
    resolved: 0,
    drafts: 0,
    pendingIssues: 0,
    operations: 0,
  };
  for (const fact of facts) {
    const work = records[fact.number] ?? emptyWork();
    result[work.stage]++;
    if (work.taskDraft) result.drafts++;
    const diff = labelDiff(fact, work);
    const operations = diff.add.length + diff.remove.length;
    if (operations > 0) result.pendingIssues++;
    result.operations += operations;
  }
  return result;
}

export function makeBatch(repo: string, fetchedAt: string, facts: IssueFact[], records: Record<string, LocalWork>) {
  return {
    schemaVersion: 1,
    kind: 'issue-label-preview-only',
    batchId: crypto.randomUUID(),
    issuedAt: new Date().toISOString(),
    repo,
    sourceFetchedAt: fetchedAt,
    executable: false,
    items: facts.flatMap((fact) => {
      const work = records[fact.number] ?? emptyWork();
      const diff = labelDiff(fact, work);
      return diff.add.length + diff.remove.length
        ? [
            {
              type: 'issue',
              number: fact.number,
              title: fact.title,
              baseline: { state: fact.state, labels: [...fact.labels], updatedAt: fact.updatedAt },
              localRevision: work.revision,
              reason: work.solution || '本地人工标签建议，待维护者复核',
              ...diff,
            },
          ]
        : [];
    }),
  };
}

export function readSaved(raw: string | null): { enabled: boolean; records: Record<string, LocalWork> } {
  if (!raw) return { enabled: true, records: {} };
  const value = JSON.parse(raw);
  const strings = (x: unknown): x is string[] => Array.isArray(x) && x.every((v) => typeof v === 'string');
  if (
    value?.version !== 1 ||
    typeof value.enabled !== 'boolean' ||
    !value.records ||
    typeof value.records !== 'object' ||
    Array.isArray(value.records)
  )
    throw new Error('不支持的体验稿记录格式');
  for (const [key, entry] of Object.entries(value.records)) {
    const w = entry as LocalWork;
    if (
      !/^\d+$/.test(key) ||
      !w ||
      !Object.hasOwn(stageNames, w.stage) ||
      ![w.solution, w.evidence, w.assignee, w.instruction].every((v) => typeof v === 'string') ||
      ![w.tags, w.addLabels, w.removeLabels].every(strings) ||
      !Number.isSafeInteger(w.revision) ||
      w.revision < 0 ||
      [w.taskDraft, w.solutionSource, w.taskSource, w.labelSource, w.solutionArchive, w.taskArchive].some(
        (v) => v !== undefined && typeof v !== 'string',
      )
    )
      throw new Error('体验稿记录不完整，已保留原数据');
  }
  return { enabled: value.enabled, records: value.records };
}

export function sourceVersion(fact: IssueFact) {
  // Comment pages share one immutable source version; expanding them is not a remote edit.
  if (fact.detailVersion)
    return JSON.stringify([
      fact.detailVersion,
      fact.title,
      fact.state,
      [...fact.labels].sort(),
      fact.updatedAt,
      fact.unavailable === true,
    ]);
  return issueSourceContent(fact);
}
export function batchIsStale(
  batch: ReturnType<typeof makeBatch>,
  facts: IssueFact[],
  records: Record<string, LocalWork>,
) {
  return batch.items.some((item) => {
    const fact = facts.find((f) => f.number === item.number);
    return (
      !fact ||
      fact.unavailable ||
      (records[item.number]?.revision ?? 0) !== item.localRevision ||
      fact.updatedAt !== item.baseline.updatedAt ||
      fact.state !== item.baseline.state ||
      JSON.stringify([...fact.labels].sort()) !== JSON.stringify([...item.baseline.labels].sort())
    );
  });
}
