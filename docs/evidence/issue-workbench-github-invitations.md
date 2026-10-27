# GitHub identity task invitations

Original request: thread_mucwsgsjtlbabfcq, user message
0001792573957400-000029-9ee8ff06 (2026-10-21): notify the GitHub member and let their
own locally authenticated installation receive the task.

Before: dispatch required editing GitHub assignees, conflating commenting and
assignment authority. After: the existing assignment control offers **通知成员接手**
or **设置 GitHub 负责人**. A task invitation publishes a structured comment mentioning
the selected organization member. It does not set an assignee or claim acceptance.
The recipient enables intake once, using their own GitHub identity and local
thread/cat configuration. The sender never supplies that local destination.

## Ownership and behavior

- GitHub owns comment author, issue identity, repository access and assignees.
  The configured organization owns membership. Both invitation sender and target
  must be current members; comment text cannot claim sender authority.
- Plugin-owned records retain delivery mode, source hash, publication intent and
  comment id. `invited` means published and awaiting acceptance; statistics keep
  invitation and assignment counts distinct. Existing records remain compatible.
- Host owns configuration, grants, local destination, scheduling and persistent
  storage. No Host files, permissions or production stores change in this delta.
- Manual UI defaults to invitation; existing API calls without a mode retain
  assignment behavior. Automatic dispatch requires its existing explicit enable
  and a saved `dispatchMode=invitation` to send invitations. Reporter-first,
  Feature/category rules and existing-assignee protection still apply.
- Resumable paginated repository-comment reconciliation runs on enabled startup and
  the existing 60-second schedule. No notification inbox is marked read; neither
  notification retention nor read status participates in delivery identity.
  Issue source, actual comment author, target, unchanged protocol and current
  organization membership are checked again before delivery/report publication.
- Comment edits/deletion, source changes, closure, or conflicting assignment
  withdraw the current invitation. Reopening restores a separate delivery epoch
  while retaining previous receipts/withdrawal history. Incomplete reads preserve
  existing inbox state. Publication with a lost response remains uncertain;
  background recovery cannot blindly repeat the POST.
- Reports use `invitation:<GitHub comment id>` and the actual recipient author.
  Delivery is not acceptance, repair authorization, verification or merge authority.

The listener deliberately uses durable comments, not the Notifications API.
GitHub documents repository-wide comment pagination and read access, whereas the
Notifications API does not support fine-grained tokens. Both were checked on
2026-10-21: [comments](https://docs.github.com/en/rest/issues/comments#list-issue-comments-for-a-repository),
[notifications](https://docs.github.com/en/rest/activity/notifications).
The first real repository probe exposed a 45-second timeout while reading all
comments in one CLI call. That failure was fixed before delivery: read up to five
100-comment pages per tick, newest first, and persist the next page only after
inbox effects complete. Restart resumes that page. A completed sequence advances
its source timestamp with one-second overlap; later polls read changed comments.
Previously received invitations are revalidated independently, so a discovery
page cannot silently withdraw an older task. A failed page retains the old cursor.
The same real probe also found bot-authored comments: provider authors are now
decoded separately from human routing targets, so bot/deleted authors cannot break
an entire page or become trusted staff. Initial catch-up is still O(repository comments); large historical backlogs span
multiple ticks, while the newest invitations are processed first. No webhook or
unbounded CLI response is required.

## Validation and actual boundary

TDD RED: owner runtime rejected `delivery` and provider lacked `invitations`.
GREEN: 65 team tests, including READ sender/no assignee effects, complete pages,
forged/edited/stale/wrong-target comments, offline startup, restart deduplication,
withdrawal, policy changes, explicit receipts and uncertain publication recovery.
The two packed team browser journeys pass: existing assignment behavior and a new
invitation journey with two independent Host stores. Desktop/mobile confirmation
screenshots were inspected under artifacts/github-delivery-2026-10-21/.
The new journey returns an explicit accepted report to the sender page.

Full repository gate results are recorded in the ignored artifact directory's
verification.json only after completion; this note does not pre-claim that result.
The real repository read probe now succeeds for five 100-comment pages, with
10 organization members, zero matching invitations in those pages and continuation
at page 6. It records only identity/counts/paths in read-live.json; it does not
claim the whole historical backlog has finished. Host health recovery includes
catch-up/current state and the next page for each persisted scan.
No real members receive test messages. No independent review is asserted.

**The full installed user journey remains incomplete.** The known generic Host
connection is still absent and the earlier plugin-only scope has not changed.
Real sender/receiver dogfood needs an authorized Issue and recipient plus that
Host connection. This candidate code and synthetic packed journey are not proof
that real cats have received or repaired a task. Original entrusted Task remains
open; no merge, feature close, production deployment or npm publication is implied.

Architecture: extend the existing Issue plugin runtime/provider/UI, without a new
store, router, public SDK contract or Core permission. The larger runtime retains
its existing serialized action/CAS boundary; this delta adds a single optional
mode to that boundary rather than introducing an alternate dispatcher.
