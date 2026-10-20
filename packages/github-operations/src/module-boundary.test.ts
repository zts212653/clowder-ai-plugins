import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import test from 'node:test';

test('default package does not ship the legacy automatic rebase/push executor', async () => {
  for (const directory of ['src', 'dist']) {
    await assert.rejects(access(new URL(`../${directory}/business/infrastructure/email/ConflictAutoExecutor.${directory === 'src' ? 'ts' : 'js'}`, import.meta.url)), { code: 'ENOENT' });
  }
});

test('package does not restore the old Host admission coverage helper', async () => {
  for (const directory of ['src', 'dist']) {
    await assert.rejects(access(new URL(`../${directory}/business/infrastructure/github/pr-review-event-wait-coverage.${directory === 'src' ? 'ts' : 'js'}`, import.meta.url)), { code: 'ENOENT' });
  }
});

test('narrator production source uses SDK persistence rather than a private Redis client', async () => {
  for (const directory of ['src', 'dist']) {
    const extension = directory === 'src' ? 'ts' : 'js';
    await access(new URL(`../${directory}/business/domains/community/narrator/SdkNarratorDelivery.${extension}`, import.meta.url));
    await assert.rejects(access(new URL(`../${directory}/business/domains/community/narrator/RedisNarratorDedupStore.${extension}`, import.meta.url)), { code: 'ENOENT' });
  }
});

test('automatic member policy is absent and narrator keeps only a plain briefing formatter',async()=>{
 for(const name of ['GuardianMatcher','RoleResolver','narrator/NarratorDriver'])for(const directory of ['src','dist'])
  await assert.rejects(access(new URL(`../${directory}/business/domains/community/${name}.${directory==='src'?'ts':'js'}`,import.meta.url)),{code:'ENOENT'});
 for(const directory of ['src','dist'])await access(new URL(`../${directory}/business/domains/community/narrator/narrator-briefing.${directory==='src'?'ts':'js'}`,import.meta.url));
});


test('plugin does not retain a Host feedback-source factory',async()=>{
 for(const directory of ['src','dist'])await assert.rejects(access(new URL(`../${directory}/business/model/types/frustration-issue.${directory==='src'?'ts':'js'}`,import.meta.url)),{code:'ENOENT'});
});
