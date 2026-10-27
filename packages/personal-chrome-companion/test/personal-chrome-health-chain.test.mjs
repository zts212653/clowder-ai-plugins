import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import test from 'node:test';
import { healthChainFixture } from './helpers/health-chain-fixture.mjs';

test('global Host Test confirms connection without choosing any of 21 authorized conversations', async (t) => {
  const f = await healthChainFixture(t);
  const before = await f.fingerprint();
  const result = await f.hostTest();
  assert.equal(result.ok, true, result.message);
  assert.match(result.message, /helper and extension.*connected/i);
  assert.match(result.message, /no conversation selected/i);
  assert.match(result.message, /sending readiness.*not.*verified/i);
  assert.equal(f.tabQueries.length, 0);
  assert.equal(f.contentRequests.length, 0);
  assert.equal(f.nativeRequests.length, 1);
  assert.equal(f.nativeRequests[0].kind, 'health_check');
  assert.equal(f.nativeRequests[0].conversationId, undefined);
  const status = await f.hostStatus();
  assert.equal(status.data.delivery.reloadRequired, false);
  assert.doesNotMatch(status.label, /Reload the extension once/);
  assert.deepEqual(await f.fingerprint(), before);
});

test('transport preserves dormant/unselected rather than inventing a stale page', async (t) => {
  const f = await healthChainFixture(t);
  const result = await f.adapter.check_health();
  assert.equal(result.status, 'dormant');
  assert.equal(result.errorCode, 'CONVERSATION_NOT_SELECTED');
  assert.equal(result.observedRevisions.pageAdapter, 'unobserved');
  assert.equal(f.tabQueries.length, 0);
});

test('an explicit exact conversation observes that page as ready without input/send', async (t) => {
  const f = await healthChainFixture(t);
  const before = await f.fingerprint();
  const result = await f.adapter.check_health('conversation-7');
  assert.equal(result.status, 'ready');
  assert.equal(result.errorCode, undefined);
  assert.deepEqual(result.observedRevisions, f.revisions);
  assert.deepEqual(f.tabQueries, [{ url: 'https://chatgpt.com/c/conversation-7*' }]);
  assert.equal(f.contentRequests.length, 1);
  assert.equal(f.contentRequests[0].request.kind, 'adapter_health');
  assert.equal(f.nativeRequests[0].conversationId, 'conversation-7');
  assert.deepEqual(await f.fingerprint(), before);
});

for (const [name, tabs, errorCode] of [
  ['missing', [], 'BOUND_TAB_NOT_FOUND'],
  ['duplicate', [{ id: 7, url: 'https://chatgpt.com/c/conversation-7' },
    { id: 8, url: 'https://chatgpt.com/c/conversation-7' }], 'AMBIGUOUS_BOUND_TABS'],
  ['a prefix lookalike', [{ id: 7, url: 'https://chatgpt.com/c/conversation-70' }], 'BOUND_TAB_NOT_FOUND'],
]) {
  test(`targeted health distinguishes ${name} tab from an obsolete page adapter`, async (t) => {
    const f = await healthChainFixture(t, { tabs });
    const result = await f.adapter.check_health('conversation-7');
    assert.equal(result.status, 'dormant');
    assert.equal(result.errorCode, errorCode);
    assert.equal(f.contentRequests.length, 0);
  });
}

for (const [name, options, errorCode] of [
  ['helper', { expectedHelper: `sha512:${'0'.repeat(128)}` }, 'STALE_HELPER'],
  ['extension', { extension: '0.2.11' }, 'STALE_EXTENSION'],
  ['page adapter', { pageAdapter: '2026-09-02.1' }, 'STALE_PAGE_ADAPTER'],
  ['unobserved targeted page', { pageAdapter: 'unobserved' }, 'STALE_PAGE_ADAPTER'],
]) {
  test(`a genuinely old ${name} still fails the real health chain`, async (t) => {
    const f = await healthChainFixture(t, options);
    const result = await f.adapter.check_health('conversation-7');
    assert.equal(result.status, 'stale_adapter');
    assert.equal(result.errorCode, errorCode);
    if (name.includes('page')) assert.equal(f.revisionContacts[0].errorCode, 'STALE_PAGE_ADAPTER');
    else assert.equal(f.contentRequests.length, 0);
  });
}

test('an invalid exact target is rejected before opening a diagnostic socket', async (t) => {
  const f = await healthChainFixture(t);
  await assert.rejects(f.adapter.check_health('conversation-7?other=1'), { code: 'INVALID_REQUEST' });
  assert.equal(f.nativeRequests.length, 0);
  assert.equal(f.tabQueries.length, 0);
});

test('Host Test fails an old extension rather than declaring every dormant result healthy', async (t) => {
  const f = await healthChainFixture(t, { extension: '0.2.11' });
  const result = await f.hostTest();
  assert.equal(result.ok, false);
  assert.match(result.message, /STALE_EXTENSION/);
  assert.equal((await f.hostStatus()).data.delivery.reloadRequired, true);
  assert.equal(f.tabQueries.length, 0);
});

test('the explicit authorized-row action is a complete read-only way out of a stale-page warning', async (t) => {
  const f = await healthChainFixture(t, { pageAdapter: '2026-09-02.1' });
  const before = await f.fingerprint();
  const checkPage = f.pageCheckAction();
  assert.equal(typeof checkPage, 'function', 'Settings needs an owner-selected page check, not a terminal-only diagnostic');
  const stale = await checkPage({ conversationId: 'conversation-7' });
  assert.equal(stale.data.health.status, 'stale_adapter');
  assert.equal((await f.hostStatus()).data.delivery.pageReloadRequired, true);
  assert.equal((await f.hostTest()).ok, false, 'connection-only health cannot clear a known stale page');
  f.state.pageAdapter = f.revisions.pageAdapter; // Owner reloads that conversation page.
  const ready = await checkPage({ input: { conversationId: 'conversation-7' } });
  assert.equal(ready.data.health.status, 'ready');
  assert.match(ready.label, /selected.*page.*ready/i);
  assert.equal((await f.hostTest()).ok, true);
  assert.equal((await f.hostStatus()).data.delivery.pageReloadRequired, undefined);
  assert.ok(f.contentRequests.length >= 2);
  assert.ok(f.contentRequests.every(({ request }) => request.kind === 'adapter_health' && request.conversationId === 'conversation-7'));
  assert.equal(f.nativeRequests.filter((request) => request.conversationId === 'conversation-7').length, 2);
  assert.deepEqual(await f.fingerprint(), before);
});

test('the owner-selected page action rejects absent, malformed or revoked targets before Chrome', async (t) => {
  const f = await healthChainFixture(t);
  const checkPage = f.pageCheckAction();
  assert.equal(typeof checkPage, 'function');
  await f.revoke('conversation-7');
  for (const input of [{}, { conversationId: 'conversation-7?extra=1' }, { conversationId: 'not-authorized' },
    { conversationId: 'conversation-7' }, { conversationId: 'conversation-8', text: 'do-not-send' }]) {
    const result = await checkPage(input);
    assert.equal(result.data.health.status, 'failed');
  }
  assert.equal(f.nativeRequests.length, 0);
  assert.equal(f.tabQueries.length, 0);
});

test('checking a historical schema-v1 authorization never migrates or rewrites it', async (t) => {
  const f = await healthChainFixture(t);
  await writeFile(f.paths.conversationBindingPath, JSON.stringify({ schemaVersion: 1, provider: 'chatgpt',
    conversationId: 'conversation-7', chatUrl: 'https://chatgpt.com/c/conversation-7',
    boundAt: '2026-10-24T00:00:00.000Z', updatedAt: '2026-10-24T00:00:00.000Z' }) + '\n', { mode: 0o600 });
  const before = await f.fingerprint();
  const result = await f.pageCheckAction()({ conversationId: 'conversation-7' });
  assert.equal(result.data.health.status, 'ready');
  assert.deepEqual(await f.fingerprint(), before);
});

test('checking another current page cannot clear the exact stale page, including loaded Settings requests', async (t) => {
  const f = await healthChainFixture(t, { pageAdapter: '2026-09-02.1' });
  const before = await f.fingerprint();
  const check = 'personal-chrome-host.check-conversation';
  const status = 'personal-chrome-host.authorizations.status';
  const firstSettings = await f.settings();
  const otherSettings = await f.settings(); // Both initially observe the same record generation.
  const stale = await firstSettings[check]({ conversationId: 'conversation-7' });
  assert.equal(stale.data.health.status, 'stale_adapter');
  assert.equal((await (await f.settings())[status]({})).data.delivery?.pageReloadRequired, true);
  f.state.tabs = [{ id: 8, url: 'https://chatgpt.com/c/conversation-8' }];
  assert.equal((await otherSettings[check]({ conversationId: 'conversation-8' })).data.health.status, 'stale_adapter');
  f.state.pageAdapter = f.revisions.pageAdapter;
  assert.equal((await otherSettings[check]({ conversationId: 'conversation-8' })).data.health.status, 'ready');
  assert.equal((await (await f.settings())[status]({})).data.delivery?.pageReloadRequired, true,
    'a new Settings invocation must retain the other page warning');
  assert.equal((await f.hostTest()).ok, false, 'active runtime sees the same persisted warning');
  f.state.tabs = [{ id: 7, url: 'https://chatgpt.com/c/conversation-7' }];
  assert.equal((await (await f.settings())[check]({ conversationId: 'conversation-7' })).data.health.status, 'ready');
  assert.equal((await f.hostTest()).ok, true);
  assert.equal((await (await f.settings())[status]({})).data.delivery?.pageReloadRequired, undefined);
  assert.deepEqual(await f.fingerprint(), before);
});

test('revoking the exact stale authorization removes its warning without probing or changing other pages', async (t) => {
  const f = await healthChainFixture(t, { pageAdapter: '2026-09-02.1' });
  const actions = await f.settings();
  await actions['personal-chrome-host.check-conversation']({ conversationId: 'conversation-7' });
  assert.equal((await (await f.settings())['personal-chrome-host.authorizations.status']({})).data.delivery?.pageReloadRequired, true);
  const beforeQueries = f.tabQueries.length;
  await actions['personal-chrome-host.authorizations.revoke']({ conversationId: 'conversation-7' });
  assert.equal(f.tabQueries.length, beforeQueries);
  assert.equal((await f.hostTest()).ok, true);
  const status = await (await f.settings())['personal-chrome-host.authorizations.status']({});
  assert.equal(status.data.authorizedCount, 20);
  assert.equal(status.data.delivery?.pageReloadRequired, undefined);
});

test('loaded Settings rejects a genuinely old running helper against the current package artifact', async (t) => {
  const f = await healthChainFixture(t, { helper: `sha512:${'0'.repeat(128)}` });
  const result = await (await f.settings())['personal-chrome-host.test']({});
  assert.equal(result.ok, false);
  assert.match(result.message, /STALE_HELPER/);
  assert.equal(f.tabQueries.length, 0);
});

