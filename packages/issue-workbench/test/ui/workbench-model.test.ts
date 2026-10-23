import { describe, expect, it } from 'vitest';
import {
  acceptWork,
  batchIsStale,
  emptyWork,
  type IssueFact,
  labelDiff,
  makeBatch,
  summarize,
} from '../../src/ui/workbench-model';

const issue: IssueFact = {
  number: 42,
  title: 'A real report',
  url: 'https://github.com/example/repo/issues/42',
  state: 'open',
  labels: ['bug', 'needs-info'],
  updatedAt: '2026-10-10T07:31:00Z',
};

describe('local work is separate from GitHub facts', () => {
  it('counts actual differences once per issue and excludes existing labels and no-op removals', () => {
    const local = {
      ...emptyWork(),
      addLabels: ['bug', 'enhancement', 'enhancement'],
      removeLabels: ['needs-info', 'missing'],
    };
    expect(labelDiff(issue, local)).toEqual({ add: ['enhancement'], remove: ['needs-info'] });
    expect(summarize([issue], { 42: local })).toMatchObject({ new: 1, pendingIssues: 1, operations: 2 });
    expect(issue.labels).toEqual(['bug', 'needs-info']);
  });
  it('requires both a solution and verification evidence for local acceptance', () => {
    expect(() => acceptWork({ ...emptyWork(), solution: 'Proposed fix' })).toThrow(/验证/);
    const local = { ...emptyWork(), solution: 'Proposed fix', evidence: 'Reproduced and checked the result' };
    expect(acceptWork(local).stage).toBe('resolved');
    expect(local.stage).toBe('new');
    expect(issue.state).toBe('open');
  });
  it('does not count an unsent cat task as underway or completed', () => {
    const work = { ...emptyWork(), taskDraft: 'Please investigate #42' };
    expect(summarize([issue], { 42: work })).toMatchObject({
      new: 1,
      drafts: 1,
      analyzing: 0,
      resolved: 0,
      pendingIssues: 0,
    });
  });
  it('recomputes current label differences while frozen exports keep their original source baseline', () => {
    const work = { ...emptyWork(), addLabels: ['enhancement'] };
    const records = { 42: work };
    const batch = makeBatch('example/repo', issue.updatedAt, [issue], records);
    const bytes = JSON.stringify(batch);
    const refreshed = { ...issue, labels: [...issue.labels, 'enhancement'] };
    expect(labelDiff(refreshed, work)).toEqual({ add: [], remove: [] });
    expect(batchIsStale(batch, [refreshed], records)).toBe(true);
    expect(batchIsStale(batch, [issue], records)).toBe(false);
    expect(JSON.stringify(batch)).toBe(bytes);
    expect(work.addLabels).toEqual(['enhancement']);
  });
});
