import type { MemberProfile } from '../team/group.js';
import { systemLabels } from './issue-context.js';
export const roleLabels = { 'architect-reviewer': '架构师 / 审核者', 'core-planner': '核心方案', member: '普通成员' } as const;
export function memberDescription(profile?: MemberProfile) {
  return profile ? `${systemLabels[profile.system]} · ${roleLabels[profile.role]} · 权重 ${profile.weight}` : '环境与职责未配置';
}
