import { nextAction } from './action-policy.mjs';
import { actionBar, actionSignature } from './actionbar.mjs';
import { attempts, stageSummary } from './attempts.mjs';
import { captureDraft, restoreDraft } from './connections.mjs';
import { restoreExpansion } from './expansion.mjs';
import { currentStage, preDeliveryPresentation, stagePresentation } from './flow-stage.mjs';
import { updatePanorama } from './panorama.mjs';
import { retainView } from './view-state.mjs';

export function updateLiveWorkflow(content, snapshot, record, task, selected, key) {
  const nodes = content.querySelectorAll('[data-attempts-stage]');
  if (!nodes.length) return false;
  const delivery = record?.delivery ?? snapshot.state?.active;
  const historical = selected !== 'current' && selected !== snapshot.state?.active?.id;
  if (historical) return true;
  const opened = new Set(
    [...content.querySelectorAll('[data-attempt][open]')].map((node) => node.dataset.attempt),
  );
  for (const node of nodes)
    node.innerHTML = attempts(Number(node.dataset.attemptsStage), record, task, false, snapshot);
  for (const node of content.querySelectorAll('[data-attempt]'))
    if (opened.has(node.dataset.attempt)) node.open = true;
  const policy = nextAction({ ...snapshot, operation: task }, delivery);
  const current = delivery ? currentStage(delivery, policy) : preDeliveryPresentation(0, task, policy).current;
  const taskOwns = !delivery || task?.deliveryId === delivery.id || task?.deliveryIds?.includes(delivery.id);
  const failed = taskOwns && task?.persistence?.status === 'FAILED' ? 5 :
    taskOwns && task?.status === 'FAILED' ? task.steps?.findLast((s) => s.status === 'FAILED')?.stage ?? policy.stage :
    delivery?.error ? policy.stage : 0;
  for (const node of content.querySelectorAll('[data-stage]')) {
    const state = delivery ? stagePresentation(
      Number(node.dataset.stage),
      delivery,
      current,
      failed,
      snapshot.state?.automation,
    ) : preDeliveryPresentation(Number(node.dataset.stage), task, policy);
    node.dataset.stageState = state.state;
    const mark = node.querySelector(':scope > summary .stage-mark');
    if (mark) {
      mark.textContent = state.mark;
      mark.className = `stage-mark ${state.tone}`;
    }
    const caption = node.querySelector(':scope > summary [data-stage-caption]');
    if (caption) caption.textContent = state.caption;
    const detail = node.querySelector(':scope > summary [data-stage-detail]');
    if (detail)
      detail.textContent = stageSummary(
        Number(node.dataset.stage),
        record,
        task,
        false,
        snapshot,
        state.state,
      );
  }
  const footer = content.querySelector('.next-action');
  if (footer && footer.dataset.policy !== actionSignature(policy, snapshot)) {
    const drafts = captureDraft();
    const restore = retainView(content, snapshot.config?.bindingId, snapshot.connection?.revision);
    footer.outerHTML = actionBar(policy, false, snapshot);
    restoreDraft(drafts);
    restore();
  }
  const errorSlot = content.querySelector('#error-slot');
  content.querySelector(`[data-stage="${current}"] .stage-body`)?.append(...(errorSlot ? [errorSlot] : []));
  restoreExpansion(content, snapshot, selected, key, delivery);
  updatePanorama(content, snapshot, record, historical, key);
  return true;
}
