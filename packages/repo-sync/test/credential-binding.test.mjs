import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { createGithubAuthentication } from '../web/github-auth.mjs';
import { createIssueAuthentication } from '../web/issue-auth.mjs';

const savedGlobals = {
  document: globalThis.document,
  location: globalThis.location,
  fetch: globalThis.fetch,
};
let calls;
beforeEach(() => {
  calls = [];
  globalThis.document = { addEventListener() {}, querySelector: () => null };
  globalThis.location = { href: 'http://127.0.0.1:5231/', origin: 'http://127.0.0.1:5231' };
  globalThis.fetch = async (path, options) => {
    calls.push({ path, body: JSON.parse(options.body) });
    return { ok: true, json: async () => ({ authentication: { available: true } }) };
  };
});
afterEach(() => {
  for (const [name, value] of Object.entries(savedGlobals)) {
    if (value === undefined) delete globalThis[name];
    else globalThis[name] = value;
  }
});

function authentication(kind) {
  const original = {
    config: { bindingId: 'same-git-binding', mode: 'continuous' },
    connection: { revision: 'api-project-a-revision' },
    token: 'local-request-fixture',
  };
  let current = structuredClone(original);
  const snapshot = () => current;
  const client =
    kind === 'internal'
      ? createIssueAuthentication(snapshot, async () => {}, { hidden: true, textContent: '' })
      : createGithubAuthentication(snapshot, async () => {});
  return {
    client,
    result: structuredClone(original),
    changeRevision() {
      current = { ...current, connection: { revision: 'api-project-b-revision' } };
    },
  };
}

for (const kind of ['internal', 'github']) {
  test(`${kind} credential completion rejects a changed configuration revision even when the Git binding matches`, async () => {
    const context = authentication(kind);
    context.changeRevision();
    const accepted = await context.client.complete(context.result, 'nonsecret-test-token');
    assert.equal(
      accepted,
      false,
      'the token belongs to the saved configuration, not the newest same-binding API scope',
    );
    assert.equal(calls.length, 0, 'a stale saved configuration must not supply credentials');
  });

  test(`${kind} credential completion freezes the saved revision across asynchronous module loading`, async () => {
    const context = authentication(kind);
    const providing = context.client.complete(context.result, 'nonsecret-test-token');
    context.changeRevision();
    await providing;
    assert.equal(
      calls.length,
      1,
      'the admitted request may use the original scope, whose server will recheck its revision',
    );
    assert.equal(
      calls[0].body.expectedRevision,
      context.result.connection.revision,
      'the request must never adopt a later revision while carrying the earlier token',
    );
  });
}
