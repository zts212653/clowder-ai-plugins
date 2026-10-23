# Issue workbench: configurable public and internal sources

Status (2026-10-14 update): the owner approved the expanded multi-source MVP after
the original single-source plan. PR #80 now adds `mountCoordination`: approved source
selection and per-source branch/base preferences, lightweight aggregate queue,
manual reversible relations and independent repository investigation/verification.
The following original single-source design is historical input, superseded by this
increment where it says aggregation is not required. No real internal platform has
been connected: its API contract and repository address are still required.

Implementation ownership stays Core-export for business types/service/UI. Plugins
owns the mounting/transport ports, isolated example Host and packed consumer tests.
The Host supplies stable source IDs derived from provider instance + canonical repo,
an isolated owner storage root and a current authorization callback for every binding.
Each binding owns its catalog/cache/cooldown and detail reader. This is a transitional
application port, not a new SDK contract or a grant encoded in profile configuration.

The new file store separates source work, preferences and relation records; relation
conclusions require both grants. It uses revision checks and an exclusive per-record
file lock followed by atomic replacement. There is no automatic stale-lock deletion:
after a Host crash an operator must confirm no writer remains before removing that
specific `.lock` file. Authored JSON records never expire or get deleted on disable.
The preview serves synthetic sources or the existing isolated public GitHub reader;
it is loopback only, rejects foreign Origin/Host and is not a production auth server.

Acceptance: packed-browser journey covers configure/read/edit/link/reopen, unsaved
input retention, separate verification, partial failure and revoked access. Store tests
exercise two writer instances, restart, same-number isolation and stale revisions.
The old workbench/browser records remain available at their original entry; no silent
copy or migration to the new Host store occurs. Fixed-SDK installation and migration
remain separate from this pre-SDK delivery.

Owner request: 2026-10-14, continue usability/testing and support public and internal
team repositories through configuration. Discussion: 砚砚 + 多多. Implementation
owner: 砚砚. The internal hosting platform is still an open input, not assumed GitLab.

## Result the user should get

Before: the running prototype points at a fixed repository; developers must wire
another transport/store to use a different source.

After: add a source using its repository URL and a Host-managed connection, check
read access, save it with a recognizable name, then select that repository in the
same workbench. Each source has its own observations, update state and local work.
Switching back recovers previous work. Internal/public is an access characteristic,
not a different plugin or an assumed network location.

User journey:

1. Settings → Issue workbench → Sources → Add repository.
2. Paste a repository URL. Detect the supported provider and instance. Choose an
   existing authorized connection, or use the Host's normal connection flow.
3. Run a bounded READ check. Show the resolved repository, site, acting connection,
   readable scope and observed visibility. Only show ready after successful access;
   unknown visibility is displayed as unknown, not guessed from the hostname.
4. Save and enable that source. Configuration alone does not start a full download.
5. Open Workspace; choose the source in the header. Display name + site/repository
   and a neutral visibility label remain visible. One configured source needs no
   distracting selector. Unsupported providers offer a clear explanation.
6. Update the selected repository, open an issue, page its discussion, save a plan,
   switch away/back and restart. Keep each source's list/detail times, counts,
   failures and retry state separate. No cross-source aggregation is required here.

Source removal disconnects configuration; it does not delete authored work. Any
explicit data deletion remains a separate user action. Disable/revoke and offline
are distinct: retained files do not bypass a revoked Host authorization.

## Baseline verified in code

At Plugins `58166606bb69458c4b0c7797747daaa7be7da5eb`:

- `WorkbenchHost` accepts repo, dataScope, storage and an injected transport; it has
  no end-user source selector or provider-instance identity.
- Browser storage currently keys owner scope + repository path. Node archives key
  repository path under a caller-supplied directory. Independent roots are possible,
  but the package does not derive or enforce multi-origin binding itself.
- `GhIssueSourceReader` is GitHub GraphQL-specific and accepts owner/repo, not GitLab
  nested project paths. UI text also names GitHub in several places.
- Existing source/local work separation, closed-issue discovery, failed-update
  retention and version-pinned discussion pages should be preserved.

The original Core integration at `5719f0f2ea7bf5c8132b7dfb83dab8bd7c97ce67` still
uses a fixed browser repository, global GitHub execution options and a community
routing repo registration as the read allowlist. That community configuration also
requires a guard thread/cat; adding an Issue READ source must not require enabling
community routing or bot behavior.

A synthetic probe of the built package used two origins, both `example/project#1`.
With one supplied root, opening the first source after refreshing the second
returned the second origin. With explicit separate Host-selected roots, reopening
both recovered their own observations. This proves the need and feasibility of
namespace isolation; it does not prove an implemented configuration flow.
See [probe evidence](../evidence/issue-workbench-origin-isolation.json).

## Configuration and ownership

Use one durable source profile per configured repository. The following are
proposed application fields, not additions to the published SDK contract:

| Information | Who supplies it / purpose |
| --- | --- |
| profile id, display name | Stable configuration identity and human-friendly selector |
| provider, instance origin | Verified supported adapter and approved service location |
| canonical repository id, current path/URL | Resolved by that provider; path is display/routing, not durable identity |
| connectionRef | Host-managed authorization reference; no raw secret in plugin config |
| owner/data scope | Host-selected stable user/tenant storage boundary |
| visibility + checked time | Observed source metadata; public/private/internal/unknown as supported |
| enabled intent, last selected source | Persisted user preferences, separate from live/auth health |

Host owns connection selection, credential retrieval, per-request grants, process
lifecycle, network destination policy and durable data location. Plugin owns source
normalization, update/paging rules and workbench business behavior. A config id is
not an authorization grant. Tokens, arbitrary shell arguments and arbitrary env var
names are not configuration options.

For self-hosted services, accept a validated instance origin via the Host's approved
connection registry. The adapter derives its API endpoint. Do not disable TLS
verification or inherit an unrelated global CLI account/hostname as a fallback.
Corporate CA/proxy requirements belong to the managed connection environment.

## Identity, retention and switching

Separate authored work from source observations:

- Work identity: stable owner/data scope + provider instance + canonical repository
  id + stable issue id (number remains display data). Rotating the same connection's
  token does not create a new workspace or lose plans.
- Observation/cache identity: the same source identity plus the effective read
  authorization scope. Different accounts with different visible issues/comments
  cannot share a successful-read cursor or cached private content just because the
  repository URL matches. Authorization is still checked when serving retained data.
- Store roots, browser keys, request-flight dedupe, retry/cooldown state, archive refs
  and frozen label batches must all use the correct identity. Changing the header
  alone is insufficient. Do not key by an editable profile label or token string.
- Resolve rename/transfer using provider identity before moving a record. A changed
  URL, missing issue or 404 alone does not prove deletion or justify merging records.
  Preserve old records; a new identity requires an explicit migration/link decision.
- Do not modify an active mount's repo/transport in place. Before switching, preserve
  or explicitly discard unsaved edits, cancel/detach old requests, and open the new
  bound scope. Old completions must not populate the new source. Remember filters
  and selected issue separately per source.
- Closed/unavailable source entries with local work remain discoverable. Distinguish
  confirmed closed, temporarily unavailable and removed authorization. A local plan
  never disappears merely because the latest remote list omits its issue.

Legacy single-source records need an explicit, idempotent import into one verified
source identity. Keep the old data and a migration receipt; never guess that an old
owner/repo key belongs to a same-named repository on a different instance.

## Platform support and evidence

| Internal platform | Implementation path | Current truth |
| --- | --- | --- |
| Private GitHub.com repository | Existing GraphQL reader with explicitly bound connection/repository | Reader reusable; configuration/auth journey still needed |
| GitHub Enterprise Server | Existing reader family + explicit host/connection + server-version capability check | Not yet validated against the team's server |
| GitLab | Separate READ adapter for project issues, notes, pagination and identity | Not implemented; requires confirmed platform/version |
| Gitea/other | Provider-specific contract and capability evidence first | Do not advertise a generic REST/webhook adapter as working |

The official [gh api manual](https://cli.github.com/manual/gh_api) provides an
explicit hostname option. Its [environment documentation](https://cli.github.com/manual/gh_help_environment)
distinguishes GitHub.com and Enterprise Server credential variables. The design
therefore binds host and connection together rather than reusing ambient settings.
The [Enterprise GraphQL guide](https://docs.github.com/en/enterprise-server@3.18/graphql/guides/forming-calls-with-graphql)
documents that service's endpoint/authentication. Exact server compatibility still
requires a capability probe and tests; sharing GraphQL does not prove every field.
GitLab documents separate [Issues](https://docs.gitlab.com/api/issues/) and
[Notes](https://docs.gitlab.com/api/notes/) APIs; the current GitHub reader cannot be
made GitLab-compatible by replacing its base URL.

External media in source Markdown is another explicit boundary: loading the text
must not implicitly authorize arbitrary remote images/video. The connection/Host
policy should govern media requests; the UI can retain placeholders and source
links when media is unavailable. Internal-content routing to cats/models later
must also obey the configured Host destination policy, not an "internal" label.

## Implementation sequence and verification

1. **Source identity and binding.** Add validated config/bound-source types, owner/
   instance/repository/read-scope keys and a source-service factory. Wire both store
   roots and browser ports. Test same names across sites, same issue numbers across
   repositories, different owners/read scopes, token rotation and source rename.
2. **Connection check and configuration.** Reuse Host-managed connection/auth entry,
   add explicit source registration independent of community guard routing, and
   return bounded diagnostics. Test wrong account, insufficient scope, unsupported
   provider/version, network/TLS failure, revoke and disable. Never report failure
   as an empty repository. Implement the actual internal adapter once identified.
3. **Source chooser and recovery.** Add the header chooser and source setup states;
   keep the existing workbench UI. Test switch with dirty edits, slow old responses,
   saved selection, restart, closed/unavailable issues with local work and retry
   isolation. Source chooser text must identify same-named repositories clearly.
4. **Migration and paired acceptance.** Import legacy data without overwriting,
   test repeat/interrupted import and preserved evidence. Pack the exact artifact
   and verify two synthetic sources through save/switch/reload/failure. Only then
   verify an explicitly authorized real internal READ connection in isolation.

Mapped Core business/UI changes follow the existing frozen-SHA → guarded export →
validation → Plugins PR workflow. Package-specific ports/tests remain in Plugins.
Formal Settings installation remains subject to fixed SDK/Host integration; a
synthetic source chooser must not be presented as a completed installed lifecycle.

This research increment records design and feasibility evidence only. It does not
change the current package artifact or claim that the above acceptance has passed.
The one external input needed for provider-specific implementation is the internal
platform (and server version if self-hosted); no repository contents or token need
be posted in chat.

## Discussion disposition

Both participants converged on one workbench, named profiles, visible source context
and provider separation. The first experience draft also suggested remote issue/
comment creation, a generic REST adapter, environment-variable token configuration,
warning colors and keyword-based leakage detection. Those suggestions were removed:
they exceed this READ/local-work increment or conflate internal access with platform
and network location. 多多 accepted the five corrections and added the closed/
unavailable issue with retained local work scenario. This is a design discussion,
not an independent code-review approval.
