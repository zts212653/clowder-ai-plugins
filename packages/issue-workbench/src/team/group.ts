import { roleLabels } from '../classification/member-profile.js';
import { z } from 'zod';
import { routingContext, type RoutingInput } from '../classification/routing-context.js';
import { systemLabels } from '../classification/issue-context.js';
import type { TeamRecord } from './records.js';
import { features, hash, login, organization, rulesSchema } from './schema.js';
import type { TeamAnalysis, TeamContext, TeamIssue, TeamProvider } from './types.js';

export interface AssignmentOptions {
  groupName: string;
  organization?: string;
  members: string[];
  preferredLogin?: string;
  basis?: 'reporter' | 'feature' | 'category' | 'role' | 'weighted';
  eligibleMembers?: string[];
  profiles?: MemberProfile[];
  excluded?: Array<{ login: string; reason: string }>;
  affectedSystems?: RoutingInput['affectedSystems'];
  systemsSource?: 'human' | 'cat' | 'source';
  routingFocus?: RoutingInput['routingFocus'];
  recommendationReason?: string;
  blockedReason?: string;
  allocation?: { poolKey: string; committed: boolean };
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

export const memberProfilesSchema = z.array(z.object({
  login, system: z.enum(['macos', 'windows']),
  role: z.enum(['architect-reviewer', 'core-planner', 'member']), weight: z.number().int().min(1).max(20),
}).strict()).max(100).refine(rows => new Set(rows.map(row => row.login)).size === rows.length, '成员不能重复');
export type MemberProfile = z.infer<typeof memberProfilesSchema>[number];
export async function readProfiles(context: TeamContext) {
  const raw = await context.config.get('memberProfiles');
  try { return memberProfilesSchema.parse(JSON.parse(typeof raw === 'string' && raw.trim() ? raw : '[]')); }
  catch { throw new Error('成员环境与职责配置无效；请核对 login、system、role、weight，不能重复成员'); }
}

export async function assignmentPlan(context: TeamContext, provider: TeamProvider, signal: AbortSignal, issue: TeamIssue,
  analysis?: Partial<Pick<TeamAnalysis, 'category'> & RoutingInput> & { systemsSource?: 'human' | 'cat' | 'source' }, records: TeamRecord[] = [], snapshotGroup?: Awaited<ReturnType<typeof readGroup>>) {
  const group = snapshotGroup ?? await readGroup(context, provider, signal);
  const rawRules = await context.config.get('routingRules');
  const routing = routingContext(issue, analysis);
  const options: AssignmentOptions = { ...group, eligibleMembers: [], profiles: [], excluded: [],
    affectedSystems: routing.affectedSystems, systemsSource: analysis?.systemsSource ?? routing.systemsSource, routingFocus: routing.routingFocus };
  try { options.profiles = await readProfiles(context); }
  catch (error) { options.blockedReason = options.error = (error as Error).message; }
  const profiles = options.profiles!;
  const policyHash = hash([group, profiles, rawRules ?? null, analysis ?? null, routing, features(issue), issue.author]);
  if (options.blockedReason) return { options, policyHash };
  const systems = routing.affectedSystems;
  if (systems.length !== 1 || systems[0] === 'other') {
    options.blockedReason = options.error = !systems.length ? '受影响系统待判断，请先确认并保存单一操作系统'
      : systems.length > 1 ? '涉及多个操作系统，请先拆分问题或确认本次处理的单一系统'
      : '其他系统暂无成员能力配置，请先确认可处理的系统与成员';
  }
  for (const member of group.members) {
    const profile = profiles.find(row => row.login === member);
    const reason = !profile ? '未配置成员环境与职责' : options.blockedReason
      ?? (profile.system !== systems[0] ? `系统不兼容：成员仅处理 ${systemLabels[profile.system]}` : undefined);
    if (reason) options.excluded!.push({ login: member, reason });
    else options.eligibleMembers!.push(member);
  }
  if (options.blockedReason) return { options, policyHash };
  const eligible = profiles.filter(row => options.eligibleMembers!.includes(row.login));
  if (!eligible.length) {
    options.blockedReason = options.error = '当前组织没有配置可处理该操作系统的成员';
    return { options, policyHash };
  }
  const reporter = issue.author ? login.safeParse(issue.author) : undefined;
  const qualifiedReporter = reporter?.success && options.eligibleMembers!.includes(reporter.data) ? reporter.data : undefined;
  options.acceptanceSuggestedFor = qualifiedReporter;
  let candidates: MemberProfile[] = [];
  let basis: NonNullable<AssignmentOptions['basis']> = 'weighted';
  const role = systems[0] === 'macos' && routing.routingFocus === 'framework' ? 'architect-reviewer'
    : systems[0] === 'windows' && routing.routingFocus !== 'general' ? 'core-planner' : undefined;
  if (role) {
    candidates = eligible.filter(row => row.role === role); basis = 'role';
    if (!candidates.length) {
      options.error = `当前系统缺少${roleLabels[role]}，请确认职责配置或人工选择兼容成员`;
      return { options, policyHash };
    }
  } else if (qualifiedReporter) {
    options.preferredLogin = qualifiedReporter; options.basis = 'reporter';
    options.recommendationReason = `${systemLabels[systems[0] as 'macos' | 'windows']} 环境兼容；优先交给提交者本人`;
    return { options, policyHash };
  } else {
    let rules: z.infer<typeof rulesSchema>;
    try { rules = rulesSchema.parse(JSON.parse(typeof rawRules === 'string' ? rawRules : '[]')); }
    catch {
      options.error = '自动派工规则格式不正确；请修正规则，或明确选择系统兼容的组织成员';
      return { options, policyHash };
    }
    const bound = features(issue);
    const matches = rules.filter(rule => bound.length ? rule.features.some(feature => bound.includes(feature))
      : !!analysis?.category && rule.categories.includes(analysis.category)).map(rule => rule.login);
    candidates = eligible.filter(row => matches.includes(row.login));
    if (candidates.length) basis = bound.length ? 'feature' : 'category';
    else if (analysis?.category && analysis.category !== '待判断') candidates = eligible.filter(row => row.role === 'member' || row.role === 'core-planner');
    else { options.error = '请先确认问题类别，再按普通成员权重自动派工'; return { options, policyHash }; }
  }
  if (!candidates.length) {
    options.error = '当前系统没有匹配的普通成员，请确认职责或人工选择兼容成员';
    return { options, policyHash };
  }
  // The existing durable dispatch journal is the allocation ledger. Only a
  // verified GitHub assignment commits a slot; retries reuse the same job.
  const poolKey = hash([group.organization, systems[0], basis, basis === 'feature' ? features(issue) : basis === 'category' ? analysis?.category : role ?? null,
    candidates.map(row => [row.login, row.weight]).sort((a, b) => String(a[0]).localeCompare(String(b[0])))]);
  const counts = new Map<string, number>();
  for (const row of records) {
    if (row.kind === 'inbox' || !row.assignment?.allocation?.committed || row.assignment.allocation.poolKey !== poolKey || !row.assignment.login) continue;
    counts.set(row.assignment.login, (counts.get(row.assignment.login) ?? 0) + 1);
  }
  candidates.sort((a, b) => (counts.get(a.login) ?? 0) / a.weight - (counts.get(b.login) ?? 0) / b.weight
    || b.weight - a.weight || a.login.localeCompare(b.login));
  options.preferredLogin = candidates[0].login; options.basis = basis;
  options.allocation = { poolKey, committed: false };
  const reason = basis === 'role' ? roleLabels[role!] : basis === 'feature' ? 'Feature 分工' : basis === 'category' ? '类别分工' : '普通成员加权分配';
  options.recommendationReason = `${systemLabels[systems[0] as 'macos' | 'windows']} 环境兼容；${reason}；同级权重 ${candidates.map(row => `${row.login}:${row.weight}`).join('、')}，按已确认派工数分配`;
  return { options, policyHash };
}
