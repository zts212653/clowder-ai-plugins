---
title: F290 Share Collective published-package rollback evidence
doc_kind: evidence
feature_ids: [F290]
created: 2026-11-02
---

# Share Collective release evidence

## Retained Client

The current **draft** package contains the invitation Client from exact Cat Café source
`f2bb508c3fb0b6a8679931e025d3b1a0180c618f`. Its baseline `033b7fdee12539df532ad22ae4b0d4de88d3b28a`
was independently reviewed; the new non-zero exit guidance awaits incremental review.
The design is not yet accepted and the source has not been merged. The retained asset
digest is `d5aa7572799b85594dc6efd96c1c349aba5a4f9ff54f290ed8b3cac4c1e082f7`.
After the Client is accepted and merged, retain it again from the final merged source and
rebuild the package candidate before release. The previous published alpha.25 used the
merged Cat Café source `d425f561eaf31812554336c0ef380a510e5f187e` (PR #6471).

After a frozen install and `pnpm --filter @cat-cafe/collective-client build` in an isolated
checkout of that source, run the following from this repository. This command **updates**
the checked-in Client assets in the current worktree. The browser probe requires the
workspace's Companion Playwright dependency and an installed Chromium:

```sh
node docs/evidence/f290-share-collective/retain-client-assets.mjs <clean-source-root> f2bb508c3fb0b6a8679931e025d3b1a0180c618f
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

The [probe](published-rollback-probe.mjs) exercises the current built Service, or an
explicitly supplied installed candidate package, against the
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

To verify a packaged candidate instead of the source build, install the exact candidate
archive in a separate temporary directory and pass the installed package root:

```sh
probe_root="$(mktemp -d)"
npm install --ignore-scripts --no-audit --no-fund --prefix "$probe_root" "<candidate-archive>"
env -u NODE_ENV F290_NEW_PACKAGE_ROOT="$probe_root/node_modules/@clowder-ai/collective-connector" \
  node docs/evidence/f290-share-collective/published-rollback-probe.mjs
```

It prints the loaded package version and still uses temporary synthetic data.

On 2026-11-02, against source `171acbac0bb760fe2b4bad69525745858635d6be`, all **28/28**
checks passed. Both real old packages rejected unconverted new state without changing its
bytes. Converted copies opened; used and revoked invitations remained unusable; a ready
invitation could admit a member. After restoring metadata onto the advanced old-version
state, the member and inviter remained, an old-version invitation had no invented inviter,
and a repeated revoke returned `revoked` while the revoked invitation stayed unusable.
The same **28/28** checks passed on the installed unpublished alpha.26 r3 draft archive
(SHA-256 `22e51ae2b96926b6e8a99b2005c4f849baaf7e30a6ab26d2490329ac8b1c7ca6`).
The candidate must be tested again if its Service code or final package changes.

This is reproducible evidence for the offline conversion functions, not a production
rollback or authorization to change the deployed Service. The deployment instructions
retain the required stopped-Service backup, private conversion copy, and restoration steps.
The probe was adapted from an independent review of the rollback path.
