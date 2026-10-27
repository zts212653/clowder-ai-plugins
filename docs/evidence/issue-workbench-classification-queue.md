# Automatic classification queue — 2026-10-21

Source: owner continuation `0001792571187005-000021-9148af61`.
This is a plugin increment on PR #80, not completion of the requested live workflow.

The owner prepares a complete Open Issue catalog, chooses one configured café cat,
sees the batch size, and explicitly starts a durable serial queue. Preparation and
page viewing do not send messages. Pause/stop prevent new analysis and automatic
assignment; results already requested can still be retained. Restart reuses the
same jobs and delivery keys. No cat or thread is silently substituted. The batch
does not continuously watch new issues; preparing a new batch is explicit.

Assignment reuses the existing policy: current GitHub Organization members only,
member reporter first, then unique Feature/category rules, with current source,
permission, membership and existing-assignee checks. Classification completion is
separate from assignment, reception, acceptance and repair. Completed batches can
also stop their remaining automatic assignment retries.

## Author verification

- Observed RED: four runtime queue scenarios failed with `Unknown owner action`;
  the packed browser lacked the **自动研判** entry.
- GREEN: 59 team checks, including six queue scenarios, pass. They cover serial
  execution/restart, pause and late results, stop, stale revisions, unavailable cats,
  changed source grants, expired owner authority, incomplete catalogs, closed issues,
  and pause from an overlapping Host instance while source retrieval is pending.
- Packed browser journey passes preparation without sends, explicit start, pause,
  reload/resume, progress and stop, alongside the existing manual/cat, direct
  assignment, feedback, receipt recovery, stale-source and denied-access journey.
- The actual `GhTeamProvider.openIssues` read **296 unique Open Issues** from
  `zts212653/clowder-ai` at `2026-10-21T08:51:26.345Z`, through the canonical local
  authenticated CLI and all pages. This was a read, not cat classification. No
  GitHub writes or cat calls occurred.
- All **35 repository gate steps and six final packed browser/READ journeys passed**
  in the managed run (433 seconds). Readback matched all **1,745 frozen files**;
  this result paragraph was then updated without changing package inputs.
  The exact outputs are recorded under
  `packages/issue-workbench/artifacts/classification-queue-2026-10-21/verification.json`.
  The validator freezes source hashes and retains named logs. The existing Feishu
  packaging exemption is unchanged. These are author checks, not independent approval.

Visual inspection: packed three-column workbench and its existing team-record
drawer, including a 390px viewport. The queue controls remain inside the scrollable
drawer; the page has no horizontal overflow. Synthetic receiver/cat data is used
only by this isolated browser test, never inserted into the real READ preview.

## Complete live journey: not yet passed

The real 5198 preview still lacks an authorized Host team route. No installed Host,
live cat response, real assignment or second-account reception is claimed.
Current-account repository permission is READ. The exact Host integration and
authority findings, original no-Core boundary and proposed generic integration
are in [the delivery plan](../plans/issue-workbench-live-delivery.md).

Architecture ownership: queue policy/state and UI are owned by this plugin;
the queue reuses installation-scoped SDK storage and the declared Host schedule.
No new service, private timer, Core business copy, SDK dependency, official grant
policy or candidate-to-installable promotion is introduced. Existing local notes,
source configuration and previous job keys are retained without deletion or TTL.
Independent review and merge are not implied by author checks.

Tips exemption: this external plugin has no Core capability-tip registry; its
README and queue UI contain the start/pause/resume instructions.
