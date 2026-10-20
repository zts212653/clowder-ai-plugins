import { createHash } from 'node:crypto';
import { fail } from './config.mjs';

const sha = (v) => typeof v === 'string' && /^[a-f0-9]{40}$/.test(v);
const hash = (v) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const digest = (v) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
export function validateRecovery(d) {
  if (d.exitInspection) {
    const r = d.exitInspection;
    if (!hash(r.id) || r.deliveryId !== d.id || typeof r.branch !== 'string' || (r.candidate !== null && !sha(r.candidate)) ||
        !sha(r.internal) || !['LOCAL_ONLY', 'BRANCH_ONLY', 'OPEN_PR', 'CLOSED_PR', 'MANUAL_REQUIRED', 'UNKNOWN', 'MERGED'].includes(r.kind) ||
        !Number.isFinite(Date.parse(r.observedAt))) invalid();
  }
  if (d.repairHistory !== undefined && !Array.isArray(d.repairHistory)) invalid();
  for (const old of d.repairHistory ?? []) { if (!old) invalid(); validateRepair(d, old, old.plan); }
  validateRepair(d, d.repair, d.repairPlan);
}
function validateRepair(d, repair, p) {
  if (p && (!hash(p.id) || !sha(p.internal) || !sha(p.target) || !sha(p.original) || !sha(p.tree) ||
      !hash(p.settings) || !sha(p.previewCommit) || !Number.isSafeInteger(p.attempt) || p.attempt < 0 ||
      p.target !== d.target || p.original !== d.candidate || typeof p.changes !== 'string' ||
      p.id !== digest({ internal: p.internal, target: p.target, original: p.original, tree: p.tree,
        attempt: p.attempt, settings: p.settings, changes: p.changes }))) invalid();
  if (!repair) return;
  const r = repair.delivery;
  if (!p || repair.planId !== p.id || !['PREPARING', 'WAITING_REVIEW', 'COMPLETE', 'CANCELLED'].includes(repair.status) ||
      !r || r.id !== digest([d.id, p.id]).slice(0, 24) ||
      ![ `sync/repair-${r.id}`, `sync/repair-${r.id}-pr` ].includes(r.branch) ||
      r.target !== d.target || r.base?.internal !== p.internal || r.base?.upstream !== d.base.upstream ||
      (r.candidate !== null && !sha(r.candidate)) ||
      !['CODE_PREPARE_REQUIRED', 'PR_REQUIRED', 'WAITING_APPROVAL', 'COMPLETE', 'CANCELLED'].includes(r.status) ||
      (r.checks?.passed && r.checks.head !== r.candidate)) invalid();
  if (repair.status === 'COMPLETE' && (!sha(r.acceptedInternal) || !sha(r.candidate) ||
      repair.mappings?.length !== 1 || repair.mappings[0].source !== d.target ||
      repair.mappings[0].internal !== r.candidate)) invalid();
}
function invalid() {
  fail('LEDGER_INVALID', '退出检查或修复记录不完整；保留原候选与台账，不能重新创建对象。');
}
