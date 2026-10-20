import assert from 'node:assert/strict';
import test from 'node:test';
import { formatProviderBriefing } from './provider-briefing.js';
import type { RepoInboxSignal } from './business/infrastructure/connectors/github-repo-event/types.js';

const signal: RepoInboxSignal = { eventType: 'issues.opened', repoFullName: 'Acme/Repo', subjectType: 'issue', number: 7,
  title: 'bounded title', url: 'https://attacker.invalid/', authorLogin: 'contributor', authorAssociation: 'NONE', deliveryId: 'delivery', action: 'opened' };
test('provider briefing bounds untrusted scalar fields and constructs its own subject URL', () => {
  const text = formatProviderBriefing({ ...signal, title: 'x'.repeat(9000), authorLogin: 'a'.repeat(500), authorAssociation: 'z'.repeat(500) });
  assert.ok(text.length < 1600);
  assert.match(text, /https:\/\/github.com\/acme\/repo\/issues\/7/);
  assert.doesNotMatch(text, /attacker|x{513}|a{129}|z{65}/);
  assert.match(text, /github_inspect_subject/);
  assert.throws(() => formatProviderBriefing({ ...signal, repoFullName: 'acme/repo/extra' }), /invalid/);
});
test('unknown provider actions cannot resolve inherited object members', () => {
  for (const action of ['constructor', 'toString', '__proto__']) {
    assert.match(formatProviderBriefing({ ...signal, action }), /^🔔 \*\*Issue #7\*\* updated\n/);
  }
});
