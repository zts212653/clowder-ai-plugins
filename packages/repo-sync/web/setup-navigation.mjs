export function revealSetupResult(kind, snapshot) {
  if (!['configure', 'configure-repositories'].includes(kind) || snapshot.state) return;
  const previous = document.querySelector('[data-setup-repositories]');
  for (const details of previous?.querySelectorAll('details') ?? []) details.open = false;
  if (previous) previous.open = false;
  const input = document.querySelector('#upstream');
  input?.focus({ preventScroll: true });
  document.querySelector('#baseline-step')?.scrollIntoView({ block: 'start' });
}
export function focusBaselineInput() {
  const upstream = document.querySelector('#upstream');
  const target = upstream?.value ? document.querySelector('#internal') : upstream;
  target?.focus({ preventScroll: true });
  target?.scrollIntoView({ block: 'center' });
}
export function createTaskFocus() {
  let last = '';
  return (task, snapshot) => {
    if (!task) return;
    const key = `${task.id}:${task.status}:${task.persistence?.status ?? ''}`;
    if (key === last) return;
    const target = taskTarget(task, snapshot);
    if (!target?.textContent.trim()) return;
    last = key;
    target.setAttribute('tabindex', '-1');
    target.focus({ preventScroll: true });
    target.scrollIntoView({ block: 'start' });
  };
}
function taskTarget(task, snapshot) {
  if (task.action === 'adopt' && task.status === 'SUCCEEDED' && snapshot.state)
    return document.querySelector('#baseline-step [data-view="workbench"]');
  if (
    ['RUNNING', 'FAILED', 'CANCELLED', 'INTERRUPTED', 'STOP_UNCONFIRMED'].includes(task.status) ||
    task.persistence?.status === 'FAILED'
  )
    return document.querySelector(
      task.status === 'FAILED' && task.error?.details?.differences ? '#baseline-differences' : '#operation',
    );
  return null;
}
