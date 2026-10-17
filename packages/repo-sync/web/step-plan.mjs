export { businessStep, plannedSteps } from './workflow-plan.mjs';

export function projectStep(group) {
  const actual = group.entries.filter(({ step }) => step.startedAt || step.status !== 'PENDING');
  if (group.terminalStatus) return { status: group.terminalStatus, latest: actual.at(-1) ?? null, actual };
  if (!actual.length) return { status: group.proof ? 'DONE' : group.status, latest: null, actual };
  const lastTask = actual.at(-1).task;
  const entries = actual.filter((entry) => entry.task.id === lastTask.id);
  // Parent wrappers can span later stages. Prefer the actual business events where available.
  const primary = entries.filter(
    ({ step }) => step.key === group.key || (group.key === 'acceptance-save' && step.key === 'receipts-save'),
  );
  const evidence = primary.length ? primary : entries;
  const latestByObject = new Map();
  for (const entry of evidence) {
    const subject = entry.step.label?.match(/#\d+/)?.[0] ?? '';
    latestByObject.set(`${entry.step.key}:${subject}`, entry);
  }
  const states = [...latestByObject.values()];
  const latestEvidence = new Map();
  for (const entry of entries)
    latestEvidence.set(`${entry.step.key}:${entry.step.label?.match(/#\d+/)?.[0] ?? ''}`, entry);
  const failed = [...latestEvidence.values()].findLast((entry) => entry.step.status === 'FAILED');
  const running = states.findLast((entry) => entry.step.status === 'RUNNING');
  const latest = failed || running || states.at(-1);
  const status = latest.step.status === 'DONE' ? (group.completionStatus ?? 'DONE') : latest.step.status;
  return { actual, latest, status };
}
