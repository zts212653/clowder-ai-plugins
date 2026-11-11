---
doc_kind: evidence
created: 2026-11-07
updated: 2026-11-07
---

# GitHub observer consecutive-failure recovery

The previous recovery writer increased failures on an unsuccessful attempt and retained them after success. Independent provider failures could therefore eventually park a healthy subscription. The optional CI prefetch could propagate its error to PRs that had not been read. A local queue timeout or capacity refusal was indistinguishable from a provider failure.

## Result and ownership

- Typed waits, community collection and migrated issues now distinguish successful work, failed work and deferral. Success clears consecutive failures; quota, queue pressure, startup bookkeeping and skipped work do not clear or consume them. Successful journal reconciliation clears its streak; new route scopes already reset their own budget.
- Request deadlines still include queue time. Before-process admission failure has an explicit deferred error. Optional batch failure leaves individual observations independent; actual rate limits retain the credential fence.
- Original recovery records hold the latest credential-redacted failure. Status notices identify subject and reason without publishing exception text. The existing status-only wake policy remains; business task status is independent of observer health, now visible as `polling.state`.
- `github_retry_tracking` requires a live authenticated invocation, the same owning user, a visible original thread, an intact imported binding where applicable, and exact recovery scope/revision. It only resumes an existing `github_observation_failed` pause with remaining work. The original wait, owner, thread, generation, baseline and delivery progress remain byte-identical. Retry history is retained. A pending old notice is cancelled in place; a new pause uses a new revision in its durable notice/archive key.

Architecture cell: package-owned GitHub observation and recovery. Map delta: none. Host still owns lifecycle, invocation identity, storage and messaging. The original private record remains the only recovery writer; inspection is read-only.

## Validation

- RED: intermittent-failure, CI-batch isolation, local admission classification and all three other recovery-owner regressions failed against their previous mechanisms.
- Package build, typecheck and **919/919 tests**, zero skips, passed. Regression coverage includes quota/cold-start preservation, redacted diagnostics, denied/stale retries, unchanged business bytes, a second pause and an event that arrived during a pause.
- The exact self-contained factory and its installed SDK passed **9/9** isolated native-Host checks, zero skips, with portless owned Redis. The existing complete-entry, import-hold, directory crash, reroute, cancellation, outbox lost-ack and old-Host checks remain included. The new recovery check calls the actual worker action and verifies the paused event reaches its original owner through ordinary Host messaging.
- The first native run used a main checkout whose built storage class did not expose indexed CAS; that run is not acceptance evidence. The paired Host used for final verification is the already built `refactor/1843-due-recovery` checkout, whose storage class exposes indexed CAS. The fixture was corrected to provide the actual Host thread facade required by retry/notice delivery. The older migrated-outbox assertion was updated to expect a cleared streak after successful recovery.
- Release-plan validator against base `4da61815940ac073539322ca2fd36bc961de1811` passed; release-plan tests passed **14/14**. Public catalog discovery is unchanged; alpha.40 has its own deferred release destination.

Native probes use `host-complete-tracking.mjs`, `host-recovery-boundaries.mjs` and `host-tracking-faults.mjs`. Set `CLOWDER_1843_HOST_ROOT` to an explicitly built capable Host and `CLOWDER_1843_GITHUB_ARTIFACT_ROOT` to the extracted self-contained `package` directory. Run through that Host's `with-test-home.mjs`, with absolute test paths, `setup-cat-registry.js`, `--test-concurrency=1` and `REDIS_URL=redis://127.0.0.1:6398/15`; these fixtures create their own portless Redis and never use production Redis.

## Artifact identity

Built with Node 24.18.0, npm 11.16.0 and zlib 1.3.1-e00f703.

Canonical npm alpha.40 archive:

- SHA256: `403fc2326822eb56971ec57ae382abeab942efb3b3983d905190a6b3ca9ae7da`
- SRI: `sha512-UANORyFzAETnKgQNbCalt+noFUcqIvQ+D803619LXFX6HPQBPg6vlXW/E/3tY+387Bf34//eN2r2wkwfZ67qOg==`

Self-contained alpha.40 archive:

- SHA256: `5337c699ca53826fdcff437eefea59450af3a6e2979dfbe54dbedf37306055a1`
- SRI: `sha512-fgLCLWU0AxkXJbovR2iNBatnaYBsxurnFVmt/vROe0h42eulsxCch6XASeZHNyB2hHoOmabVnPwtncCeg1dbKQ==`
- 5,631 members, zero symlinks, 136 installed packages; relocated and runtime entrypoints load.

Source validation and isolated installed acceptance do not establish that a live installation has been upgraded or its paused subscriptions resumed. The maintained work continues through explicit installed-instance update confirmation, native recovery and live verification.
