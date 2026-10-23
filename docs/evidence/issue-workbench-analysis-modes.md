# Manual and cat analysis choices — 2026-10-21

Owner request: manual analysis and cat analysis are alternative ways to investigate
an Issue; cats must be selected from the members configured in this café.
Source: thread `thread_mucwsgsjtlbabfcq`, message
`0001792568689509-000004-eea3dcc8`.

The existing three-column workbench now starts with **人工研判**. Owners can edit
and persist their local tags, solution and evidence without a team Host connection.
**猫猫研判** exposes the Host's configured member list and explicit send button.
Switching modes retains the manual draft and chosen cat, and sends no message.
GitHub Organization assignees remain a distinct list, usable without cat analysis.

The candidate runtime combines the public SDK's routable and unavailable member
projections. Unavailable members are visible and disabled. Refresh preserves the
selected identity even after withdrawal; an explicit owner change is required to
select another cat. Actual delivery rechecks current routing. This introduces no
new SDK method, persistent schema, credential, dependency or Core change.

## Regression evidence

- Before implementation, the member-list test failed because unavailable cats were
  omitted and availability was not returned. The packed browser journey failed at
  the missing **人工研判** control.
- After implementation, all 52 team tests and six packed browser/READ journeys
  passed. The browser journey checks manual save/reload, draft retention across
  mode changes, explicit selected-cat delivery, withdrawal/removal/recovery without
  substitution, and manual save/reload after Host authorization is denied.
- The disconnected multi-source packed journey exercises manual editing, source
  preferences, relationships, independent verification and restart persistence.

Final package checks and artifact integrity are recorded with the PR and ignored
local `packages/issue-workbench/artifacts/analysis-modes-2026-10-21/` evidence.
The increment is package-local; it consumes the earlier full repository baseline
and reruns package lint, all tests, build and packed acceptance on the final input.

## User-facing boundary

The existing 5198 preview reads real Issues from `zts212653/clowder-ai`, the original
requested repository. It retains source preferences and local records in its
isolated store. Team calls remain disconnected there: no invented roster, cat reply
or remote assignment is presented as real. Installed Host access/configuration,
live cat invocation, two-account acceptance and applicable independent review
remain unfinished. These author checks do not approve merge or complete the Task.
