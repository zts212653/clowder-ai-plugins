import assert from 'node:assert/strict';
import test from 'node:test';
import { createGithubAuthentication } from '../web/github-auth.mjs';
import { createIssueAuthentication } from '../web/issue-auth.mjs';

for (const kind of ['github', 'internal']) {
  test(`${kind}: a configuration refresh cannot route the submitted secret into another binding`, async (t) => {
    const originalDocument = globalThis.document;
    globalThis.document = { addEventListener() {}, querySelector: () => null };
    t.after(() => {
      globalThis.document = originalDocument;
    });
    let requests = 0;
    t.mock.method(globalThis, 'fetch', async () => {
      requests++;
      throw Error('a secret must not be sent');
    });
    const snapshot = () => ({ config: { bindingId: 'new-binding' } });
    const refresh = async () => assert.fail('wrong binding must not refresh');
    const controller =
      kind === 'github'
        ? createGithubAuthentication(snapshot, refresh)
        : createIssueAuthentication(snapshot, refresh, {});
    assert.equal(await controller.complete({ config: { bindingId: 'saved-binding' } }, 'SYNTHETIC_SECRET'), false);
    assert.equal(requests, 0);
  });
}
