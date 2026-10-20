# GitHub Operations

[Chinese](README.md) · English

`@clowder-ai/github-operations` tracks PR reviews, CI checks, merge conflicts, issues and comments, collects repository activity, and provides Community triage and issue drafts that require publication confirmation.

## Get started

1. Install through Clowder AI Settings. Authenticate the canonical GitHub CLI (`gh`) on the machine running Clowder AI.
2. Optionally configure a Personal Access Token in the plugin secret field, or use the machine's existing `gh` login. Never put credentials in conversations, tool arguments or repository content.
3. Enable the plugin and use its installed GitHub Operations skill and tools. Saving configuration and enabling runtime work are separate actions; tracking and background polling require the plugin to be running.

Other settings are optional, not installation prerequisites:

| Setting | Purpose |
| --- | --- |
| Noise Bot Login List | Filter known setup-only comment noise. |
| GitHub Webhook Secret | Configure only when using the optional repository webhook, with the exact callback URL exposed by the Host. |
| Repositories allowed for public issue drafts | Comma-separated `owner/repository` names. Empty disables new drafts and publishing. |
| Community narrator cat / thread | Set both to an available cat and an accessible existing thread for manual triage briefings. Empty disables new requests. |

The legacy `mcpToken` key remains for inventory continuity; it is not a current action credential and is not needed to use native MCP. Fresh installation requires no old configuration, permissions or cursor import. Existing stored metadata is not implicitly deleted.

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
