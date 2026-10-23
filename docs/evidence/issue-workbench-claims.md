# Open Issue ownership — 2026-10-23

Operator request: Open Issues must clearly show whether they are claimed and by
whom; dispatch marks that information on the Issue. This extends PR #80. The
complete isolated Host requested earlier remains the acceptance environment.

## Behavior

- Both list and detail show `未认领` for an empty GitHub Assignees list, or
  `已认领 · @login` for all current assignees. Unknown legacy metadata is explicitly
  `认领状态待更新`; the next source refresh backfills it.
- Owner-confirmed dispatch defaults to setting GitHub Assignees, then reads the
  provider again. The verified observation updates the list and detail immediately.
  Refreshing sources also reflects reassignment or removal performed on GitHub.
- Invitation remains a separately selected action. It does not mark the Issue
  claimed. Historical dispatch records, analysis and local drafts cannot establish
  current ownership. Existing assignees and confirmation/permission checks remain.
- Both source adapters carry ownership: standalone GraphQL and the installed
  module's REST-derived coordination facts. Core stays frozen at
  `031244712b8b62d1dc017ed379efd09b15dd4fc6`; plugin export transformations reproduce
  the mapped changes without editing a Host checkout.

## Verification

New regressions first failed for missing metadata, missing visible state, incomplete
owner lists, legacy refresh and installed coordination. The affected canonical
package gate subsequently passed: manifest, lint/typecheck, source/UI/team tests,
build and an archive installed outside the monorepo with no runtime dependencies.
There are 81 team regressions, 29 source/port tests and 21 UI tests.

All seven packed browser journeys and thirteen isolated Host checkpoints passed.
The browser dispatch journey verifies default owner marking, confirmation before
write, immediate claimant display, reload persistence, remote reassignment and
removal. The invitation journey verifies the Issue stays unclaimed. These writes
use explicit provider fixtures, never live GitHub Issues.

The final archive SHA-256 is
`d8979c80948dbe4e5bf3e1d200a95e60254ee8e26bbaab88ca1941178da38b1b`.
It was installed into the existing complete isolated Host (API 3142, Web 5142,
Redis 6358), preserving the plugin instance and stored human/model work.
A fresh browser session read 849 real Issues. Issue #1514 displayed
`已认领 · @mindfn`; #1709 displayed `未认领`, matching independent `gh issue view`
reads. List and detail agreed; the narrow layout had no horizontal overflow or
page errors. No live assignment was attempted. Automatic assignment, intake and
public progress sharing remain off. Original service PIDs and configuration
hashes were unchanged.

The full repository gate was attempted and failed at step 5: the same two
unchanged Contract tests' child processes aborted with SIGABRT under
`NODE_USE_ENV_PROXY=1`. Repeating the unchanged canonical suite with that variable
unset passed all 634 tests. No assertions, timeouts, tests or source were relaxed.
The failure is retained and is **not** described as a single green full-gate run.
The affected Issue gate and bilingual package inventory were checked separately.

Local evidence: `packages/issue-workbench/artifacts/claims-2026-10-23/`;
live browser/install/isolation evidence: isolated Host
`.cat-cafe/lab-evidence/claims/`. These local artifacts are not published credentials
or evidence of production installation. This report does not close the complete
Feature or establish remote CI approval. Production installation and the previously
requested designated two-account GitHub dispatch/acceptance remain outstanding.
