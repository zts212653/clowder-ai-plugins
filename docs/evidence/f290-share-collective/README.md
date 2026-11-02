---
title: F290 Share Collective published-package rollback evidence
doc_kind: evidence
feature_ids: [F290]
created: 2026-11-02
---

# Share Collective release evidence

## Retained Client

The current **draft** package contains the invitation Client from exact Cat Café source
`4f8617b1f65cea54763b9e23bf157222ab28cbc0`. Its code has been independently reviewed,
but the design is not yet accepted and that source has not been merged. The retained asset
digest is `1f2e0b39c541dea0f498d1ed2424978783ef615d314b3684c139086621a4d976`.
After the Client is accepted and merged, retain it again from the final merged source and
rebuild the package candidate before release. The previous published alpha.25 used the
merged Cat Café source `d425f561eaf31812554336c0ef380a510e5f187e` (PR #6471).

After a frozen install and `pnpm --filter @cat-cafe/collective-client build` in an isolated
checkout of that source, run the following from this repository. This command **updates**
the checked-in Client assets in the current worktree. The browser probe requires the
workspace's Companion Playwright dependency and an installed Chromium:

```sh
node docs/evidence/f290-share-collective/retain-client-assets.mjs <clean-source-root> 4f8617b1f65cea54763b9e23bf157222ab28cbc0
env -u NODE_ENV pnpm --filter @clowder-ai/collective-connector test:source
env -u NODE_ENV node docs/evidence/f290-share-collective/retained-client-auth-probe.cjs
env -u NODE_ENV node docs/evidence/f290-share-collective/retained-client-full-probe.mjs <clean-source-root>
```

The retention script verified 583 source inputs byte-for-byte against the Git commit, 282
installed dependency inputs against the build record, the source-lock DOMPurify binding,
and every retained asset against its manifest. The package's source-continuity suite passed
4/4. The browser probe used the **packaged** assets with a synthetic Service and identity
provider: an invited person with multiple Collectives reached the target, an unowned target
was rejected, and a network interruption retained the target for retry. The full probe runs
the reviewed Client's real-Service scenarios against the retained asset directory, including
a real browser clipboard inside a cross-origin Host fixture and distinct forwarding ports.
All seven scenarios passed with simulated people and GitHub. The Host fixture reproduces the
actual iframe policy but is not the full Café application. No real GitHub or friend was used.

## Invitation rollback against published versions

The [probe](published-rollback-probe.mjs) exercises the current built Service against the
actual published `@clowder-ai/collective-connector` alpha.22 and alpha.24 packages. It uses
synthetic state and a fake identity provider; it does not touch an existing Service, actual
accounts, or deployment data. It installs both old packages in temporary directories with
package scripts disabled and removes those directories after the run. An npm connection is
required.

From the repository root, with its dependencies installed:

```sh
env -u NODE_ENV pnpm --filter @clowder-ai/collective-connector build
env -u NODE_ENV node docs/evidence/f290-share-collective/published-rollback-probe.mjs
```

On 2026-11-02, against source `171acbac0bb760fe2b4bad69525745858635d6be`, all **28/28**
checks passed. Both real old packages rejected unconverted new state without changing its
bytes. Converted copies opened; used and revoked invitations remained unusable; a ready
invitation could admit a member. After restoring metadata onto the advanced old-version
state, the member and inviter remained, an old-version invitation had no invented inviter,
and a repeated revoke returned `revoked` while the revoked invitation stayed unusable.

This is reproducible evidence for the offline conversion functions, not a production
rollback or authorization to change the deployed Service. The deployment instructions
retain the required stopped-Service backup, private conversion copy, and restoration steps.
The probe was adapted from an independent review of the rollback path.
