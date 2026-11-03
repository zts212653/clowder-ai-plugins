---
doc_kind: guide
created: 2026-11-03
updated: 2026-11-03
---

# Publication and catalog follow-up

A source PR is merged before npm publication, and catalog activation is a separate reviewed PR after publication. Pending activation is therefore a normal state. It must have an owner and a destination without making main fail after every successful release.

When advancing a selected plugin candidate, add a record to `catalog/release-plans.json` in the same PR:

- `pluginId`, `version`, `integrity`: the exact selected candidate identity. A record for an older version cannot cover a new release.
- `disposition`: `activate` when publication will be followed by the scoped catalog PR, or `defer` when acceptance or a dependency must finish first.
- `owner`: the named cat or maintainer responsible for following through, using its stable lowercase handle.
- `reviewBy`: a UTC date for checking progress again, not a promise to finish the feature by then. New or edited plans require a future date. Existing overdue waits do not block unrelated source PRs.
- `sourceRef`: the public release PR or issue that explains the decision.
- For `defer`, also provide `reason` and `condition`: why it waits and what must be true before activation.

The required **Typecheck + Conformance** PR job invokes the production plan validator against the exact PR base. To reproduce that boundary locally after installing dependencies:

```sh
pnpm catalog:release-check -- --base-sha <exact-40-character-base-commit>
```

Missing plans, owners, waiting conditions or mismatched immutable identities block the PR before publication. Existing archive, package, dependency and test checks remain in place. Core library versions without a discoverable plugin catalog entry do not need a fictitious plugin plan.

After publication, `pnpm catalog:release-audit` verifies the actual live archives and published candidate bytes and writes a report. States are `active`, `activation-pending`, `deferred`, `overdue` or `unowned`; publication availability is shown independently. Pending/deferred/overdue/unowned are follow-up data and do not fail main. Real distribution corruption or a failed reminder write still reports its actual error.

The daily/manual **Catalog Activation Audit** runs the same command with `--notify`. It creates one GitHub issue per release needing action, names the responsible owner, gives the reason, release condition, review date and source, and updates it when those facts change. Future deferrals remain visible in the report without premature issues. Unchanged issues are not reposted. Bot-created reminders close when the release is activated, superseded or moved into a reviewed future wait. The audit never edits third-party issues, publishes packages or writes live discovery. Manual and daily reminder writers are serialized.

Activation still uses the existing verified single-plugin path and independent catalog review:

```sh
pnpm catalog:activate:plugin -- <pluginId>
pnpm catalog:activation-check:plugin -- <pluginId>
```

Do not bulk activate unrelated waiting candidates. A successful audit means its observations and reminders were delivered; only `active` means that exact plugin is available from live discovery. An existing installation is upgraded separately by its owner. `pnpm catalog:activation-check` remains an explicit strict whole-catalog completion command and is intentionally not the post-publication CI gate.
