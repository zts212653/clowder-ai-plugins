import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture } from './service-fixture.js';
import type { HydratedJournal } from '../src/types.js';

test('a restarted service resumes the selected draft and explicit new feedback stays blank', async () => {
  const f = fixture();
  const call = (input: unknown, userId = f.ctx.userId) => f.service.dispatch(input, {...f.ctx, userId}) as Promise<{journal?: HydratedJournal; revision: number}>;
  const saved = await call({op:'save',feedbackId:'draft-a',draftOnly:true,targetId:'clowder',clientId:'chosen-member',projectRef:'C:/selected-project',report:{kind:'feat',title:'feat: 粘贴截图',body:'关闭后继续填写',attachments:[]}});
  const { FeedbackService } = await import('../src/service.js');
  const reopened = await new FeedbackService(f.host).dispatch({op:'bootstrap',resume:true},f.ctx) as {journal?: HydratedJournal};
  assert.equal(reopened.journal?.id,'draft-a');
  assert.equal(reopened.journal?.report.body,'关闭后继续填写');
  assert.equal(reopened.journal?.clientId,'chosen-member');
  assert.equal(reopened.journal?.projectRef,'C:/selected-project');
  assert.equal((await call({op:'bootstrap',resume:true},'other-owner')).journal,undefined);
  await call({op:'new'});
  assert.equal((await call({op:'bootstrap',resume:true})).journal,undefined);
  await call({op:'bootstrap',feedbackId:saved.journal!.id});
  assert.equal((await call({op:'bootstrap',resume:true})).journal?.id,'draft-a');
});

test('a resume-pointer CAS conflict does not poison a successfully written draft revision', async () => {
  const f=fixture();
  const compare=f.host.storage.compareAndSet;
  f.host.storage.compareAndSet=async(key,expected,value)=>key.startsWith('feedback-selection:')?{applied:false}:compare(key,expected,value);
  const saved=await f.service.dispatch({op:'save',feedbackId:'draft-a',draftOnly:true,targetId:'clowder',report:{title:'A',body:'first',attachments:[]}},f.ctx) as {journal:HydratedJournal;revision:number;selectionSaved:boolean};
  assert.equal(saved.selectionSaved,false);
  const edited=await f.service.dispatch({op:'save',feedbackId:'draft-a',revision:saved.revision,draftOnly:true,targetId:'clowder',report:{title:'A',body:'second',attachments:[]}},f.ctx) as {journal:HydratedJournal;revision:number};
  assert.equal(edited.journal.report.body,'second');
  assert.ok(edited.revision>saved.revision);
});
