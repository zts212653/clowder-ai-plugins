import { z } from 'zod';
import { classifyIssueContext } from './issue-context.js';

export const affectedSystemsSchema = z.array(z.enum(['windows', 'macos', 'other'])).max(3)
  .transform(value => [...new Set(value)].sort());
export const routingFocusSchema = z.enum(['general', 'framework', 'core-plan']);
export type AffectedSystem = z.infer<typeof affectedSystemsSchema>[number];
export type RoutingFocus = z.infer<typeof routingFocusSchema>;
export interface RoutingInput { affectedSystems?: AffectedSystem[]; routingFocus?: RoutingFocus }
export const focusLabels = { general: '普通问题', framework: '框架与架构', 'core-plan': '核心功能方案' } as const;

/** Empty human/cat systems explicitly mean unknown, not permission to infer again. */
export function routingContext(issue: { title: string; body?: string }, human?: RoutingInput, cat?: RoutingInput) {
  const systemsSource: 'human' | 'cat' | 'source' = human?.affectedSystems !== undefined ? 'human' : cat?.affectedSystems !== undefined ? 'cat' : 'source';
  const affectedSystems = human?.affectedSystems ?? cat?.affectedSystems ?? classifyIssueContext(issue).systems;
  const prose = `${issue.title}\n${issue.body ?? ''}`;
  const inferredFocus = /框架|架构|\bframework\b|\barchitecture\b/i.test(prose) ? 'framework'
    : /核心.{0,16}(?:功能|方案)|(?:功能|方案).{0,16}核心|\bcore\b.{0,30}\b(?:feature|proposal|design)\b/i.test(prose) ? 'core-plan' : 'general';
  const focusSource: 'human' | 'cat' | 'source' = human?.routingFocus !== undefined ? 'human' : cat?.routingFocus !== undefined ? 'cat' : 'source';
  return { affectedSystems, systemsSource, routingFocus: human?.routingFocus ?? cat?.routingFocus ?? inferredFocus, focusSource };
}
