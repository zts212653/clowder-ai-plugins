# GitHub Operations

[Chinese](README.md) · English

`@clowder-ai/github-operations` tracks PR reviews, CI checks, merge conflicts, issues and comments, collects repository activity, and provides Community triage and issue drafts that require publication confirmation.

## Get started

1. Install through Clowder AI Settings. Authenticate the canonical GitHub CLI (`gh`) on the machine running Clowder AI.
2. Leave the optional GitHub access token empty to use the machine's existing `gh` login. Save configuration, then test the connection to check the current account. This read-only probe does not start polling or prove access to every repository.
3. Enable the plugin and use its installed GitHub Operations skill and tools to register tracking. Configuration, authentication and runtime health are separate states; tracking and background polling require the plugin to be running.

Other settings are optional, not installation prerequisites:

| Setting | Purpose |
| --- | --- |
| Notification author allowlist | Optional additional filter for comment/review notifications. Empty adds no restriction. |
| Notification author blocklist | Suppress named comment/review authors, case-insensitively. Blocklist wins. CI, merge and conflict state notifications are unaffected. |
| GitHub Webhook Secret | Configure only when using the optional repository webhook, with the exact callback URL exposed by the Host. |
| Repositories allowed for public issue drafts | Comma-separated `owner/repository` names. Empty disables new drafts and publishing. |

The five ordinary-use settings remain optional: GitHub token, notification author allowlist/blocklist, webhook secret and publication repository allowlist. The retained-state recovery mode and status controls are only for existing observers; leave them unused for a fresh installation. Internal policies, the legacy `mcpToken` and narrator target coordinates retain their declarations and saved values. Drafts are saved by the plugin; publishing needs an owner-authenticated preview that supports that saved draft. The migrated feedback entry may show only a saved summary, which does not prove the full publication journey; Settings has no draft or narrator operation buttons. Existing drafts, credentials and tracking records remain intact. Fresh installation requires no legacy import.

## Local update and verification

New tracking subscriptions, predicates, cursors, receipts and notification outboxes stay in plugin-private storage. Scheduled polling turns GitHub changes into ordinary conversation messages. New subscriptions create no Host Task and read no conversation content. Imported Host waits retain their original Task, owner, thread and generation; only that recovery path uses the declared task.read/task.write capabilities to verify the existing binding and settle its projection. Native admission authenticates the registrant and messaging validates the destination. Community summary lookup uses metadata visible to the current user. New subscriptions do not call Host Tasks; the manifest and installation page specify the requested permissions.

[Host generic proposal #232](https://github.com/mindfn/clowder-ai/pull/232) separately handles project MCP synchronization and empty binding presentation. GitHub-specific grants and draft UI changes are not prerequisites. When tools are missing, inspect project capability synchronization. When a visible tool fails, inspect the persisted phase and safe failure code from `github_list_tracking`; HTTP 502 alone does not identify a PAT problem. First registration reads a fresh GitHub baseline; later polling belongs to the plugin. Different authenticated threads have independent private subscriptions to the same subject, retaining old cancelled history. Reuse the exact registrationId and input after an unknown response. Register successfully before triggering a review event being tested.

Actor lists accept comma/whitespace-separated logins, case-insensitively, as additional filters on registered conditions. Filtering preserves provider evidence and collection cursors; widening a list does not replay filtered history. Already admitted durable notifications remain available for delivery recovery.

Use the delivered exact archive with its SHA256 and SHA512 SRI. Extract it and select the resulting `package` directory through Settings' directory installation. Updating the same pluginId through a local directory preserves the instance, credentials and durable tracking state; do not uninstall first. An enabled plugin follows the Host's ordinary suspend/update/resume lifecycle. A fresh installation can upload the self-contained `.tgz` directly.

For an existing catalog/npm installation, use the directory update: the current Host's archive replacement requires matching local-archive provenance and may reject a direct upload as already installed. Do not work around that by uninstalling.

After updating, confirm `0.1.0-alpha.19`, the hidden internal fields, and optional visible fields. Save, test the account, and confirm runtime health. Read existing registrations with `github_list_tracking` and local observations with `github_inspect_subject`. Register an explicitly authorized PR if needed, reusing its registrationId after an ambiguous response. `github_refresh_pull_requests` followed by `github_repository_observations` checks the provider read path. Initial registration is silent; verify delivery on a subsequent real review or CI change. Isolated package tests do not establish that the live installation has recovered. To roll back, install the extracted previous verified package without clearing the instance or history.

## Track PRs and issues

The native `github-tracking` MCP server exposes:

- `cat_cafe_register_pr_tracking` to register a PR.
- `cat_cafe_register_issue_tracking` to register an issue.
- `cat_cafe_unregister_tracking` to stop tracking while retaining history.

Use their advertised schemas. A registration takes a repository, number and unique `registrationId`; reuse the same ID and arguments after an unknown response. The Host authenticates the cat, thread and invocation. Those identities are not tool arguments.

The first live baseline is silent. Later matching changes become ordinary messages. Repository inbox collection has its own registration. Installing alone does not start GitHub polling for unregistered subjects. An on-demand title read for display does not register tracking or refresh the repository index.

Closing or merging a subject retires tracking after final collection and delivery. Failed collection does not advance cursors; pending messages remain recoverable. Disable cancels provider work and joins cleanup, while re-enable recovers from durable state.

## Community triage and publishing

Review records describe GitHub revisions and results; Host assignments are managed through ordinary collaboration. Guardian invitations use an explicit `guardianCatId`, with caller identity checked at sign-off. Feedback cards submit explicit content and a repository through the ordinary draft action; the plugin manages drafts in private storage.

Community pages read repository facts and expose the declared collaboration and draft operations. Public issue publication requires explicit confirmation and an allowed target repository. Empty publication settings cannot be bypassed.

With narrator cat and thread configured, manual triage saves a frozen target and briefing before the existing schedule materializes its delivery. Changing either setting pauses the old delivery instead of redirecting it. Restore the original settings to retry. Enabling later does not automatically wake historical cases.

Submit external-review results through `github_record_external_review_verdict`. `pending_verification` means the submission is durable, **not** that delivery or lease completion has been approved. Missing trusted publisher association returns `insufficient`; a matching GitHub object alone is not completion evidence.

## Understand capability names

MCP, the skill and schedules are directly used features. Other contributions connect those features to Host pages, messages and verification:

| Name | Purpose |
| --- | --- |
| Tools / `github-tracking` MCP | Register, inspect and stop tracking, and perform declared Community actions. |
| Skill | Explain the tools' intended use. |
| Schedules | Poll registered work and recover pending collection or delivery. |
| `community-http-01`–`29` | Internal Community page route IDs, not 29 GitHub webhooks that users must configure. |
| `github/events` | Optional external repository webhook. It verifies HMAC over original request bytes and accepts registered repositories only. |
| `github/pr-title` | Read a current PR title for display without changing tracking state. |
| `github-notification` / `github-wait` identities | Attribute plugin notifications and waits, not new GitHub accounts or caller permissions. |

These contributions belong to one plugin, with one manifest, ID, version and capability declaration. They are not extra plugins or setup steps. This package declares no limb. The Host controls their presentation; removing real wiring is not a display fix.

## Authority and recovery

The Host owns installation, grants, thread access, storage mechanics and generic message/wake delivery. The plugin owns GitHub reads, filtering, tracking and Community business. Installation does not imply consent to every grant.

Configured GitHub tokens and webhook secrets are used for account access and request verification. Tracking state, cursors, deduplication records and delivery progress are stored privately so pending work can resume.

Tool arguments, comments, repository text and message metadata never supply caller identity, owner authority, approval or publication permission. Native MCP uses the SDK's authenticated action transport; it does not revive the retired external GitHub MCP integration.

A PR poll admits at most 20 waits using shared CI base facts. Each PR's deeper read has a 10-second deadline within the 30-second poll budget. Failure preserves its baseline and generation. Registration/cancellation is rechecked before consuming results; pending notifications can recover even when new batch facts are unavailable.

Release note: this is an unpublished local candidate. Real-account journeys and public distribution require separate acceptance.

## Continue existing tracking after a consumer migration

For an existing observation history, configure **Continue existing tracking (optional)**
with the exact value `import-only` before activating the replacement. Collection,
webhooks and registration remain paused; normal registration freezes a new
baseline and cannot preserve an old wait. The recovery status/source buttons show
what is imported and which source fields are missing. Use the reviewed owner
recovery flow and original-owner binding requested there, then explicitly release
one collector. An incomplete or ambiguous old delivery keeps recovery paused.
The [recovery contract](../../docs/plans/2026-10-21-github-cutover-preparation.md)
describes the operator entry and rollback limits; this is not installation or
persistent-grant approval.
