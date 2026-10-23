import { z } from 'zod';
import { features, hash, login, organization, rulesSchema } from './schema.js';
import type { TeamAnalysis, TeamContext, TeamIssue, TeamProvider } from './types.js';

export interface AssignmentOptions {
  groupName: string;
  organization?: string;
  members: string[];
  preferredLogin?: string;
  basis?: 'reporter' | 'feature' | 'category';
  acceptanceSuggestedFor?: string;
  error?: string;
}

/** GitHub owns membership. Legacy manual lists and routing rules cannot add staff.
 * Read afresh at each effect boundary; a failed read never grants cached authority. */
export async function readGroup(context: TeamContext, provider: TeamProvider, signal: AbortSignal) {
  const raw = await context.config.get('teamOrganization');
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new Error('请在插件设置中关联 GitHub Organization，例如 meow-club；旧手工成员名单不会用于派工');
  }
  const org = organization.parse(raw);
  const members = [...new Set(z.array(login).parse(await provider.organizationMembers(org, signal)))].sort();
  signal.throwIfAborted();
  if (organization.parse(await context.config.get('teamOrganization')) !== org) {
    throw new Error('关联组织已变化，请刷新成员名单后重试');
  }
  return { groupName: org, organization: org, members };
}

export async function requireMember(context: TeamContext, provider: TeamProvider, signal: AbortSignal, target: string) {
  const group = await readGroup(context, provider, signal);
  if (!group.members.includes(login.parse(target))) throw new Error('目标用户已不在当前 GitHub Organization 成员名单中');
  return group;
}

export async function assignmentPlan(context: TeamContext, provider: TeamProvider, signal: AbortSignal, issue: TeamIssue, analysis?: Pick<TeamAnalysis, 'category'>) {
  const group = await readGroup(context, provider, signal);
  const rawRules = await context.config.get('routingRules');
  const reporter = issue.author && group.members.includes(issue.author) ? issue.author : undefined;
  const options: AssignmentOptions = { ...group, acceptanceSuggestedFor: reporter };
  if (reporter) {
    options.preferredLogin = reporter;
    options.basis = 'reporter';
  } else if (analysis || features(issue).length) {
    let rules: z.infer<typeof rulesSchema>;
    try { rules = rulesSchema.parse(JSON.parse(typeof rawRules === 'string' ? rawRules : '[]')); }
    catch {
      options.error = '自动派工规则格式不正确；请修正规则，或明确选择当前 group 成员';
      return { options, policyHash: hash([group, rawRules ?? null, reporter ?? null]) };
    }
    const bound = features(issue);
    const matches = [...new Set(rules.filter(rule => group.members.includes(rule.login) && (bound.length
      ? rule.features.some(feature => bound.includes(feature))
      : !!analysis && rule.categories.includes(analysis.category))).map(rule => rule.login))];
    if (matches.length === 1) {
      options.preferredLogin = matches[0];
      options.basis = bound.length ? 'feature' : 'category';
    } else {
      options.error = '请为当前分类或 Feature 配置一位明确匹配的 group 成员，或手动选择组员';
    }
  }
  return { options, policyHash: hash([group, rawRules ?? null, reporter ?? null, analysis?.category ?? null, features(issue)]) };
}
