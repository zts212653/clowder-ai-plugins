import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import { memoryStorage } from '../test/memory-storage.js';
import { SdkCommunityWorkflowIssueStore } from './business/domains/community/CommunityWorkflowStores.js';
import { createCatId } from './business/model/index.js';
import { CommunityRequestContext } from './business/routes/community-request-context.js';
import { communityIssueRoutes } from './business/routes/community-issues.js';

test('triage author is bound to the native caller, never to the body or owner forwarding', async t => {
  const app = Fastify(); t.after(() => app.close());
  const context = new CommunityRequestContext(app);
  const issues = new SdkCommunityWorkflowIssueStore(memoryStorage());
  const issue = (await issues.create({ repo: 'org/repo', issueNumber: 1, issueType: 'feature', title: 'Proposal' }))!;
  await issues.update(issue.id, { state: 'discussing' });
  await app.register(communityIssueRoutes, {
    requestContext: context, communityIssueStore: issues,

    taskStore: { listByKind: async () => [], getBySubject: async () => null, upsertBySubject: async () => { throw new Error('unexpected tracking'); }, delete: async () => false },
  });
  const url = `/api/community-issues/${issue.id}/triage-complete`;
  const payload = { catId: 'forged-cat', verdict: 'WELCOME', questions: ['Q1','Q2','Q3','Q4','Q5'].map(id => ({ id, result: 'PASS' })) };
  const owner = await context.injectOwner({ kind: 'owner', id: 'user' }, { method: 'POST', url, payload });
  assert.equal(owner.statusCode, 401);
  const caller = { catId: 'real-cat', userId: 'user', threadId: 'thread', invocationId: 'invocation', assertCurrent: async () => {} };
  const forged = await context.injectNative(caller, { method: 'POST', url, payload });
  assert.equal(forged.statusCode, 403);
  assert.equal((await issues.get(issue.id))?.directionCard, null);
  const valid = await context.injectNative(caller, { method: 'POST', url, payload: { ...payload, catId: 'real-cat' } });
  assert.equal(valid.statusCode, 200);
  const card = (await issues.get(issue.id))?.directionCard;
  assert.deepEqual((card?.entries as Array<{ catId: string }>).map(entry => entry.catId), ['real-cat']);
});

test('guardian is explicitly selected and signoff uses the current caller without member policy',async t=>{
 const app=Fastify();t.after(()=>app.close());const context=new CommunityRequestContext(app);
 const issues=new SdkCommunityWorkflowIssueStore(memoryStorage());const issue=(await issues.create({repo:'org/repo',issueNumber:2,issueType:'feature',title:'Explicit guardian'}))!;
 await issues.update(issue.id,{state:'accepted'});
 await app.register(communityIssueRoutes,{requestContext:context,communityIssueStore:issues,
  taskStore:{listByKind:async()=>[],getBySubject:async()=>null,upsertBySubject:async()=>{throw new Error('Unexpected Task');},delete:async()=>false}});
 const caller={catId:'author',userId:'owner',threadId:'thread',invocationId:'invocation',async assertCurrent(){}};
 const requestUrl=`/api/community-issues/${issue.id}/request-guardian`;
 assert.equal((await context.injectNative(caller,{method:'POST',url:requestUrl,payload:{author:'author',reviewer:'reviewer'}})).statusCode,400);
 const invited=await context.injectNative(caller,{method:'POST',url:requestUrl,payload:{guardianCatId:'explicit-guardian'}});
 assert.equal(invited.statusCode,200);const value=invited.json();assert.equal(value.guardianAssignment.guardianCatId,'explicit-guardian');
 const signoff={method:'POST' as const,url:`/api/community-issues/${issue.id}/guardian-signoff`,payload:{signoffToken:value.signoffToken,approved:false,checklist:[]}};
 assert.equal((await context.injectNative(caller,signoff)).statusCode,403);
 assert.equal((await context.injectNative({...caller,catId:'explicit-guardian'},{...signoff,payload:{...signoff.payload,catId:'author'}})).statusCode,400);
 assert.equal((await context.injectNative({...caller,catId:'explicit-guardian'},signoff)).statusCode,200);
 assert.equal((await issues.get(issue.id))?.guardianAssignment?.signedOff,true);
});
