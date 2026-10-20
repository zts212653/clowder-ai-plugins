import assert from 'node:assert/strict';
import test from 'node:test';
import type {FeatureContext} from '@clowder-ai/plugin-sdk';
import {CommunityNarratorRuntime} from './community-narrator.js';
import {reviewVerdictInput} from './community-review-verdict.js';

test('explicit narrator destination does not consult deployment or reject an unavailable member', async () => {
  const context = {config:{get:async(key:string)=>key==='narratorCatId'?'unavailable-cat':'thread'},
    storage:{}, messaging:{}, threads:{}, get deployment(){throw new Error('Host deployment is not plugin policy');}} as unknown as FeatureContext;
  const narrator=new CommunityNarratorRuntime(context);
  try {
    const intent=await narrator.prepare({caseId:'issue',subjectKey:'issue:org/repo#1',sourceEventId:'event',briefingContext:'Issue'});
    assert.equal(intent?.catId,'unavailable-cat');
    assert.equal(intent?.threadId,'thread');
  } finally {await narrator.stop();}
});

test('review facts do not accept or require Host execution leases', () => {
  const fact={repoFullName:'org/repo',prNumber:1,reviewedHeadSha:'a'.repeat(40),verdict:'approved',summary:'Reviewed',
    delivery:{kind:'pending_delivery',reason:'Recorded locally'}};
  assert.equal(reviewVerdictInput.safeParse(fact).success,true);
  assert.equal(reviewVerdictInput.safeParse({...fact,actionLeaseRef:{leaseId:'lease',generation:1}}).success,false);
});
