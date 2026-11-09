# Bounded GitHub tracking status — alpha.41

Small status checks previously called `typedWaitStatus`, collected the typed namespace three times,
then expanded migrated issues, registration attempts and four recovery owners into one response.
There was no input filter or continuation in the installed alpha.40 tool declaration.
Retained notice histories also expanded individual recovery rows. No production full-list call was
made to reproduce this issue.

The status action now reads bounded namespace pages directly. Tracking is the default view;
recovery and registration diagnostics are explicit views. Repository, responsible cat/thread and
attention filters apply before projection. The existing result arrays contain the selected page.
Recovery identities (`taskId`, `scope`, recovery `revision` and separate `sourceRevision`) remain
available. Large records have explicit omission markers; notice history is counted. An oversized
corrupt record advances as a source anchor instead of trapping the cursor.

Each request returns at most 50 logical records / 65536 JSON-result bytes and examines at most
500 records / eight storage pages. Redis COUNT is only a hint: the cursor retains the source,
scan position and last consumed key so a static oversized page's tail remains readable. Empty
nonterminal pages continue. Remaining totals are unknown; these are live pages without a snapshot
guarantee during changes. Filtered pages disclose scanned sources with unresolved attribution.

`github_inspect_subject(subjectKey, fromSequence, limit)` remains the existing observation/event
entry. It does not establish whether a subscription exists or expose its recovery facts; no
replacement observation tool was added.

## Observed validation

- The three new entrypoint regression checks first failed on the original behavior: ignored page
  limits, whole-installation expansion and oversized responses. Environment/build failures were
  resolved before recording this behavioral RED.
- Package suite: **926/926**, zero skips, after building its emitted modules. The initial all-package
  invocation preceded that build and failed on missing dist files; it is not counted as a product regression.
- Final typecheck and seven targeted status tests pass. They exercise the actual module action:
  multiple repos/cats/threads, all four recovery owners, malformed/unattributed sources, empty
  nonterminal scans, COUNT overshoot, byte stopping, changed-query cursors, credential redaction,
  foreign users, authority revocation and unchanged persistent values.
- The source action's 300-subscription fixture finds 25 matching rows in five pages, maximum
  **5864 bytes**. No original wait, route, baseline, generation or retry budget is changed.
- The self-contained artifact loads its own compiled factory and SDK with **136 physical
  dependencies**, zero symlinks. Its manifest schema accepts the new query and rejects limit 51 /
  unknown subjectKey. Its `github_inspect_subject` input remains unchanged. The packaged status
  action reads the same 25-of-300 scenario in five pages, maximum **5204 bytes**, unchanged storage,
  and zero provider calls. This is an isolated packaged consumer, not production installation acceptance.

Sonnet's R1 review of `e91a8cc2` found that gh's actionable error lived in stderr while the status
summary kept only its generic message, and that task-summary omissions overwrote title clipping
markers. Both new real-action regressions were observed RED before repair. R2 retains redacted
message/code/stderr and one cause (including stderr), with each text field capped at 2000 characters;
stack/deeper causes remain explicitly omitted. Summary merges now preserve prior truncation markers
in tasks, recovery identity fields and diagnostic anchors. All seven status tests and **926 package
tests** pass. The R2 packaged consumer additionally verifies stderr/cause redaction and title markers:
diagnostic result **837 bytes**, recovery result **5786 bytes**, unchanged storage and zero provider reads.
This repair changes only status projection and its documentation; the previously checked pagination,
schema, original-owner storage and recovery writers remain covered by their existing evidence.

The same 300-record / 100-notices-per-record in-memory data was also fed to the original main
typed reader and the new packaged reader. The old measurement is explicitly the typed portion,
not the full old tool envelope; the separate early “450k tokens” report was not remeasured or
treated as an observed value.

Same-fixture JSON measurements: original typed portion **5699773 bytes / 300 tracking + 300 recovery
rows**; new default **20102 bytes / 20 tracking records**; new repository/cat page **5490 bytes / 5
tracking records**. Both new pages have continuation. Storage is byte-for-byte unchanged.

The reproducible packaged consumer is `packages/github-operations/test/packed-tracking-status.mjs`:

```sh
node --import tsx packages/github-operations/test/packed-tracking-status.mjs /absolute/unpacked/package
```

## Exact artifacts

Node **24.18.0**, npm **11.16.0**; no dependency-version changes.
These are the current R2 artifacts. R1 archive `d65937eb5bb0…` is superseded and remains preserved in
the sibling `github-bounded-tracking-alpha41` delivery directory; no previously delivered archive was overwritten.

Canonical npm archive `clowder-ai-github-operations-0.1.0-alpha.41.tgz`:

- SHA1: `b706f67375bf460eb96494879b3157455d4a0b04`
- integrity: `sha512-2RHxH0NGbrsFRVjTuMADMCyrJJRNv/TGw5MSSIr9D/p1nKK3b/Xz6FcZxJvepiIr1IFGZTUjN4YLnUS/1YdFvg==`

Self-contained archive `clowder-ai-github-operations-0.1.0-alpha.41-darwin-arm64-c48f1b9c9b43.tgz`:

- SHA256: `c48f1b9c9b436cc62abe91399f1903e018636135c3c93853317e5058f5ed9c2d`
- Persistent delivery directory: `/Users/lysander/.cat-cafe/evidence/github-bounded-tracking-alpha41-r2/`.
  Includes canonical and self-contained receipts, extracted consumer, before/after measurements and
  packaged-consumer output. These are local delivery artifacts, not public registry availability.

The candidate catalog records alpha.41; its release plan is explicitly deferred under
`codex61-sol`, source PR **208**, review by **2026-11-15T09:00:00Z**. Public discovery remains unchanged.
The PR number was established with a source-only draft after affected-package validation because
the release-plan validator requires this PR's actual URL. Full repository validation follows the
completed candidate/release records before the final review target is announced.

## Acceptance boundary

At implementation time, the installed plugin projection is **alpha.40 / running**, with an empty
`github_list_tracking` input schema. Neither the production plugin nor runtime was installed or
restarted. No real GitHub observer, test issue/comment or subscription was created; validation
uses in-memory fixtures and does not access production Redis.

The repository's **39 gate steps are all covered at HEAD
`2387914065dc6d878f5749df904175656b011a4d`**. Managed job
`managed-job-289865565e07cc6a0f1b3625995f4d3bb805a696` passed 1–20, then the unrelated Feishu
build's fixed CLI download timed out. Both existing CLI 1.0.85 archives were verified against the
upstream checksums and copied to this checkout's ignored cache; its build then passed without
product changes. Job `managed-job-688a405aa34478e6e01e5016aae29a553aebf021` used the exported
`buildGateSteps` definitions at that unchanged HEAD and passed 21–39 (733 seconds), including
catalog/release validation and all **26 publishable-package** pack checks. This is prefix/suffix
coverage, not a claim that the original failed command exited successfully.

Required CI run **42556514093** passed the complete gate for R1 `e91a8cc2`. R2 revalidates the
affected package, the regenerated artifacts, candidate catalog and release plan; its new exact-HEAD
CI and Sonnet delta verdict must be checked separately before merge.

Independent review, merge and checkout disposition remain pending. After source integration, the original task's home retains installed
acceptance: name the actual consumer/version, inspect the live schema, and perform bounded read-only
queries over existing data before closing that original task. Source tests do not establish that
the actual installed caller can use these arguments.
