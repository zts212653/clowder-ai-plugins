---
doc_kind: evidence
created: 2026-11-02
updated: 2026-11-02
topics: [task229, private-storage, github-operations]
---

# Task229 private-storage R1

Same Task `0001791512176765-000229-f6d76223`, plugin PR186. Accepted source remains
`thread_owned_3fbc6b34db775710e020aac39b26be69d0f4e0e3#0001793602335397-000214-8141ec14`.
Original Sol56 review is `local_cat / iterative`; R1 findings are message
`thread_muj292lfdw77vqa1#0001793645639112-001911-9b3dbf51` on `7d5a0e8f683d3f809ce1840953a52114a56d5922`.

## Corrections

The old CI batch treated a scanned row as current authority. Every candidate is now reread by key;
the batch registers cancellation for its keys before its final current-record check and remote call.
It sends only current active PR targets. Unregister aborts the batch as well as per-target polling.
The pending poll awaits the actual provider child instead of releasing it through a raced promise.
The existing per-channel queue keeps CI batches single-flight; no new authority or watchdog is added.

Three actual `GitHubTrackingRuntime` regressions cover scan then unregister (no batch), replacing a
registration after scan (use its current destination), and unregister during a batch (abort while
retaining the provider child until cleanup). Existing admission, page cursor and notification behavior
remain under the same production runtime tests.

The real review-verdict storage wrapper omitted optional scan. It now forwards the port through its
native caller/repository-policy fence before and after the read. Both current-Host fixtures that
previously omitted scan now use the existing test `scanMemory`, including literal namespace and cursor
semantics. There is no production list fallback.

## Failure-mode sweep

All three product storage forwarding wrappers were read: typed-wait runtime and Community request
context already retained scan; the review-verdict wrapper was the missing one and is repaired.
The cold `PlanningStorage` is a local planner using writes/direct reads, not a current Host page
consumer. Key-only registration test doubles use no listing and intentionally remain partial.

Other scanned background effects were checked: migrated issue `one()` rereads its key and binding
before effects; narrator `flush()` rereads the outbox and checks authority; the other typed-wait CI
batch checks `currentSubscription()` first. This CI batching path was the missed effect boundary.

## Observed validation

- Original Contract CI failed 51 cases; the author's selected real suites plus three new race cases
  reproduced 54 failures and 9 passes. The corrected group passed 63/63. Original outputs are retained.
- The unmodified native `pnpm gate:ci` then passed all 38 stages in 920 seconds. Its complete GitHub
  operations group passed 742/742, zero failure/cancellation/skip, including the stronger cleanup
  assertion added after the first targeted green. Native typechecks and builds are included.
- The native gate has five Windows-only DACL tests skipped on macOS. Its pack gate passed 24 packages
  and retained the existing feishu-meeting-intake npm-internal pack exemption. These are explicit
  limits; the run is not reported as having zero skips across every package.
- SDK8 bytes are unchanged. GitHub32 was rebuilt and repacked, and its candidate row was refreshed
  from actual SHA1/SRI. The self-contained archive physically includes SDK candidate.8 and exercises
  the compiled Core producer: original imported ID, one HSCAN, no HGETALL, and refusal after revoke.
- All 82 current source/emitted/test/metadata bindings were recomputed without drift. The GitHub
  tarball's packaged files were also compared byte-for-byte to the files after the full native gate.

The gate ran from the owned `clowder-ai-plugins-task229-private-storage` checkout, using its existing
CI script and pinned Node24.18.0/npm11.16.0/zlib1.3.1-e00f703. The outer build/shared permit receipt is
under that repository's common Git directory; no cross-repository host-pool guarantee is claimed.
The child environment excluded household runtime/API/Redis/model credentials. No formal runtime
HTTP/Redis/restart, model call, registry publication or candidate activation was performed.

Raw outputs and the executed one-off driver are copied with an extra `.txt` extension so their
original bytes are preserved. Original whitespace remains in the raw outputs. `SHA256SUMS` covers the
archive; `raw/final-bindings.json.txt` binds product/test inputs. Native commands and stage durations
are recorded in `raw/stage-results.json.txt`; the full CI log is included, not just its success tail.
The driver records its original execution layout; replay in another checkout must supply the matching
owned layout and the native artifact toolchain. No new repository runner or monitor is introduced.

## Ownership and rollout

Architecture cell: plugin, github-signals, community-ops

Map delta: none

Why: the same plugin hash, business records, writer, permissions and lifecycle remain authoritative.
The existing pending request maps only retain cancellation ownership. There is no business migration.

Core6484 was separately approved and merged as `92cb4585b6f9a98d12f559e42727dc7c98e3ecdf`.
Its author checkout is retained for this paired package verification; original Task deployment wait
g40 is state-only on the boot69 baseline. This plugin subject still requires its own new exact-HEAD
approval. Core's approval does not approve this plugin, publication or activation.

GitHub32 must activate only after the new Core port is loaded. Before repacking, registry reads found
alpha32 absent and confirmed published alpha31 as a positive control. No publication step ran here.
Rollback still uses unchanged business IDs and the legacy string cursor, which remains written.
No formal installation, overall responsiveness, sidebar, F102 Alpha or old Task execution-writeback
closure is claimed. Existing connector background/startup full reads remain separately censused.

The batch cancellation code stays with the runtime that already owns per-key cancellation and the
per-channel serialized queue. It does not introduce a parallel policy owner or an API execution fallback.
