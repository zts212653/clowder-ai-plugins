import { analysisKey, digest, feedbackKey } from './config.js';
import type { Analysis } from './analysis.js';
import type { Host, Journal, Profile } from './types.js';

/** Owner index contains IDs only; report bytes and CAS revisions stay independent. */
export class FeedbackRecords {
  constructor(private readonly host: Host) {}

  async register(userId: string, id: string) {
    const key = `feedback-records:${digest(userId)}`;
    for (;;) {
      const current = await this.host.storage.get(key);
      const ids = (current?.value ?? []) as string[];
      if (ids.includes(id)) return;
      if ((await this.host.storage.compareAndSet(key, current?.revision ?? null, [...ids, id])).applied) return;
    }
  }

  async migrate(userId: string, targets: Profile[]) {
    const journal = (await this.host.storage.get(`feedback:${digest(userId)}`))?.value as Journal | undefined;
    const analysis = (await this.host.storage.get(analysisKey(userId)))?.value as Analysis | undefined;
    if (journal) {
      await this.host.storage.compareAndSet(feedbackKey(userId, journal.id), null, journal);
      await this.register(userId, journal.id);
    }
    const marker = `analysis-migration:${digest(userId)}`;
    if (!analysis || await this.host.storage.get(marker)) return;
    const matches = journal && (analysis.journalDigest === journal.digest ||
      analysis.candidate?.title === journal.report.title && analysis.candidate?.body === journal.report.body ||
      analysis.material.includes(`E2 用户现象\n${journal.report.title}\n${journal.report.body}\n\n`));
    const id = matches ? journal.id : analysis.id;
    if (!matches) {
      const source = analysis.material.split('E2 用户现象\n')[1]?.split(/\n\nE\d /)[0] ?? '';
      const [title, ...lines] = source.split('\n');
      const report = {...(analysis.candidate ?? {title:title || '历史反馈分析',body:lines.join('\n')}),attachments:[]};
      const target = journal?.target ?? targets[0]!;
      const legacy: Journal = {version:1,id,owner:userId,report,target,digest:digest({id,report,target}),state:'draft',createdAt:analysis.startedAt,reviewReady:analysis.state==='ready'};
      await this.host.storage.compareAndSet(feedbackKey(userId,id),null,legacy);
    }
    const key = analysisKey(userId,id);
    await this.host.storage.compareAndSet(key,null,analysis);
    if (analysis.threadId) {
      const mapping = await this.host.storage.get(`analysis-thread:${analysis.threadId}`);
      await this.host.storage.compareAndSet(`analysis-thread:${analysis.threadId}`,mapping?.revision ?? null,{key,id:analysis.id});
    }
    await this.register(userId,id);
    await this.host.storage.compareAndSet(marker,null,{id:analysis.id});
  }

  async list(userId: string) {
    const ids = (await this.host.storage.get(`feedback-records:${digest(userId)}`))?.value as string[] | undefined;
    const rows = await Promise.all((ids ?? []).map(id=>this.host.storage.get(feedbackKey(userId,id))));
    return rows.filter((row): row is NonNullable<typeof row>=>Boolean(row)).map(row=>row.value as Journal);
  }
}
