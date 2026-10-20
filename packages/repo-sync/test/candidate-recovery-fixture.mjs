import { Receiver } from '../src/engine.mjs';
import { ensureIssues } from '../src/issue-lifecycle.mjs';
import { setIssueToken } from '../src/issue-auth.mjs';
import { codehubPlatform } from './codehub-fixture.mjs';
import { repositories } from './fixtures.mjs';
import { git } from '../src/process.mjs';

export async function recoveryFixture(t, { manual = false, lost, local = false, internalPaths = [] } = {}) {
  const f = await repositories();
  await git(f.source, ['update-ref', 'refs/heads/main', f.u1]);
  const platform = await codehubPlatform(f, { lost });
  t.after(platform.close);
  const adapter = { mode: 'gitlab', apiUrl: platform.api, projectId: 'team/core', authMode: 'session' };
  const config = { ...f.config, internalWebUrl: platform.web, commitStrategy: 'rewrite', internalPaths,
    ...(manual ? {} : { issues: adapter, pullRequests: { ...adapter } }) };
  const receiver = new Receiver(config);
  if (!manual) setIssueToken(receiver.config, platform.token, 'test');
  await receiver.adopt(f.u0, f.i0);
  const plan = { ...f.plans[0], issues: [{ ...f.plans[0].issues[0], requiredTargets: [f.u1] }] };
  await receiver.setQueue([plan]);
  await receiver.start();
  if (manual) await receiver.linkIssue('issue-71', '71', `${platform.web}/issues/71`);
  else await receiver.change((s) => ensureIssues(receiver, s, receiver.active(s)));
  const s = await receiver.read(), d = receiver.active(s);
  // Simulate the frozen candidate made by an old release, before tree validation.
  d.candidate = await receiver.git.mergeNode(await receiver.git.tree(f.u0), [f.i0], 'old incorrect candidate');
  d.commitMappings = [{ source: f.u1, internal: d.candidate }];
  await receiver.store.save(s);
  if (!local) await receiver.prepare();
  const original = (await receiver.status()).active;
  if (manual && !local) await receiver.linkPr(`${platform.web}/merge_requests/71`);
  return { ...f, config, receiver, platform, original, plan };
}
