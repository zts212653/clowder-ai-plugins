import { expect, test } from 'vitest';
import { hostRouteBodySchema, validateHostRoute, type CollectiveOwnerRouteOptions } from '../../../owner-route-validation.js';

const input = () => ({ defaultIngressThreadId: 'inbox', humanNotificationThreadId: 'notice', expectedRevision: 3,
  agentRoutes: { 'human:cat': { catId: 'cat', threadId: 'work' } } });
function options() {
  const threads = new Map(['inbox', 'notice', 'work', 'private'].map(id => [id, { id, createdBy: 'owner', participants: ['cat'] }]));
  let available = true, supported = true;
  const value: CollectiveOwnerRouteOptions = { isCatAvailable: () => available,
    supportsParticipation: () => supported, resolveAgentIdentity: () => ({ displayName: 'Cat (model)' }),
    threadStore: { async get(id) { return threads.get(id) ?? null; } } };
  return { value, threads, quota(exists: boolean) { available = exists; }, native(exists: boolean) { supported = exists; } };
}
test('original strict raw-route DTO rejects body owner, synthesized standing revision and unknown fields', () => {
  expect(hostRouteBodySchema.parse(input())).toEqual(input());
  expect(() => hostRouteBodySchema.parse({ ...input(), localOwnerUserId: 'owner' })).toThrow();
  expect(() => hostRouteBodySchema.parse({ ...input(), agentRoutes: { 'human:cat': { ...input().agentRoutes['human:cat'], standingWorkRevision: 7 } } })).toThrow();
});
test('plain route quota availability is independent of native participation support', async () => {
  const f = options(); f.native(false);
  expect(await validateHostRoute(f.value, 'owner', 'human', input())).toBeUndefined();
  f.quota(false);
  expect(await validateHostRoute(f.value, 'owner', 'human', input())).toMatchObject({ code: 'ROUTE_CAT_UNAVAILABLE' });
});
test('raw route retains exact paired-human prefix and nonempty target agent', async () => {
  const f = options(), row = input().agentRoutes['human:cat'];
  expect(await validateHostRoute(f.value, 'owner', 'human', { ...input(), agentRoutes: { 'foreign:cat': row } })).toMatchObject({ code: 'TARGET_NOT_LOCAL' });
  expect(await validateHostRoute(f.value, 'owner', 'human', { ...input(), agentRoutes: { 'human:': row } })).toMatchObject({ code: 'AGENT_ROUTE_MISMATCH' });
});
test('public participation requires current native policy, exact cat target and real display name', async () => {
  const f = options(), route = { ...input(), agentRoutes: { 'human:cat': { ...input().agentRoutes['human:cat'], participation: { displayName: 'Cat (model)', channelIds: ['general'] } } } };
  expect(await validateHostRoute(f.value, 'owner', 'human', route)).toBeUndefined();
  f.native(false); expect(await validateHostRoute(f.value, 'owner', 'human', route)).toMatchObject({ code: 'PARTICIPATION_UNSUPPORTED' });
  f.native(true); route.agentRoutes['human:cat'].participation.displayName = 'body identity';
  expect(await validateHostRoute(f.value, 'owner', 'human', route)).toMatchObject({ code: 'PARTICIPATION_UNSUPPORTED' });
});
test('standing configuration stays within public channels and owned participant threads without creating authority', async () => {
  const f = options(), row = { ...input().agentRoutes['human:cat'], participation: { displayName: 'Cat (model)', channelIds: ['general'] },
    standingWork: { channelIds: ['general'], requestingHumanIds: ['requesting-human'], threadId: 'private', expiresAt: null } };
  const route = { ...input(), agentRoutes: { 'human:cat': row } };
  expect(await validateHostRoute(f.value, 'owner', 'human', route)).toBeUndefined();
  row.standingWork.channelIds = ['foreign'];
  expect(await validateHostRoute(f.value, 'owner', 'human', route)).toMatchObject({ code: 'OWNER_ADMISSION_SCOPE_MISMATCH' });
  row.standingWork.channelIds = ['general']; f.threads.get('private')!.createdBy = 'another-owner';
  expect(await validateHostRoute(f.value, 'owner', 'human', route)).toMatchObject({ code: 'ROUTE_THREAD_UNAVAILABLE' });
});
test('all destination threads must belong to the owner and contain every configured agent cat', async () => {
  const f = options(); f.threads.get('notice')!.createdBy = 'foreign';
  expect(await validateHostRoute(f.value, 'owner', 'human', input())).toMatchObject({ code: 'ROUTE_THREAD_UNAVAILABLE' });
  f.threads.get('notice')!.createdBy = 'owner'; f.threads.get('work')!.participants = [];
  expect(await validateHostRoute(f.value, 'owner', 'human', input())).toMatchObject({ code: 'ROUTE_CAT_NOT_IN_THREAD' });
});
