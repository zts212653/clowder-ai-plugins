import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture } from './service-fixture.js';
import { pngFixture } from './png-fixture.js';
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

test('a published feedback stays in history but never becomes the default panel again', async () => {
  const f = fixture();
  const image = pngFixture().toString('base64');
  const saved = await f.call({op:'save',feedbackId:'published-a',targetId:'clowder',
    report:{title:'Already reported',body:'Delivered feedback',attachments:[{mime:'image/png',base64:image}]}});
  const {id,digest} = saved.journal;
  await f.call({op:'approve',digest,confirmed:true});
  await f.call({op:'submit',digest});

  const { FeedbackService } = await import('../src/service.js');
  const restarted = new FeedbackService(f.host,()=>f.adapter);
  const open = (input: unknown) => restarted.dispatch(input,f.ctx) as Promise<{
    journal?: HydratedJournal; revision?: number; items: {id:string;status:string;issueUrl?:string}[];
  }>;
  const initial = await open({op:'bootstrap',resume:true});
  assert.equal(initial.journal,undefined);
  assert.equal(initial.revision,undefined);
  assert.equal(initial.items.find(item=>item.id===id)?.status,'published');
  const history = await open({op:'bootstrap',feedbackId:id});
  assert.equal(history.journal?.issue?.url,initial.items.find(item=>item.id===id)?.issueUrl);
  assert.equal(history.journal?.screenshotItems?.[0]?.base64,image);
  assert.equal((await open({op:'bootstrap',resume:true})).journal,undefined);

  await open({op:'save',feedbackId:'draft-b',draftOnly:true,targetId:'clowder',
    report:{title:'Continue drafting',body:'Draft to resume',attachments:[]}});
  await open({op:'bootstrap',feedbackId:id});
  assert.equal((await open({op:'bootstrap',resume:true})).journal?.id,'draft-b');
  assert.equal(f.creates(),1);
});
