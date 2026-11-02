---
title: F290 Share Collective published-package rollback evidence
doc_kind: evidence
feature_ids: [F290]
created: 2026-11-02
---

# Invitation rollback against published versions

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
The probe is adapted from Sonnet's independent review in
`thread_mvumss547y41x2uj#0001793633634352-001378-577be8fa`.
