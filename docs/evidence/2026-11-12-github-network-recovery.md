---
doc_kind: evidence
created: 2026-11-12
updated: 2026-11-12
---

# GitHub observation resumes after temporary network failures

The owner reported that closing a laptop or temporarily losing connectivity should not end PR tracking. The five-failure policy introduced in PR #199, and retained by #207, removed valid waits from the due index. Reconnecting and restarting could not produce a new successful observation. This repair preserves bounded requests without making transport failure a subscription lifetime limit.

Accepted source: `thread_owned_c5d1d70498e3a6cf3bf5f3e2d3dd295bcee316e3#0001794492300697-001527-80e36e62`.

## Behavior and boundaries

- Recognized GitHub transport failures and unavailable CI snapshots retain automatic observations with persisted exponential backoff, a fifteen-minute cap and stable scope jitter. Success clears the streak. Quota, queue admission and shutdown remain deferrals. No write/publication request gains a transport retry loop.
- Typed PR/Issue waits, private community collection and migrated issues retain their original business records. Recovery does not register a new wait, capture a new baseline or change its generation, responsible cat, original thread or collected/delivered cursors. A subsequent ordinary matched outcome can still auto-renew as before.
- Versioned original-owner censuses republish old network pauses, including null due projections. Their page progress survives interruption, and ready ticks continue using due indexes rather than scanning history. Corrupt rows, cancelled subscriptions, migration holds and unavailable authority remain protected. Non-transient failures retain explicit attention/retry semantics.
- Recovery status reports `backing_off` and its next deadline. One prolonged typed outage produces one status notice; subsequent probes do not create a notice per revision. Pending obsolete pause notices are retained as cancelled rather than sent after automatic recovery resumes.
- Local journal routing failures retain their separate integrity/reconciliation policy. They are not indiscriminately reclassified as network failures.

Architecture cell: package-owned GitHub observation and recovery. Map delta: none. The original private row remains the only recovery owner, and Host authority/storage/message delivery are unchanged.

Canonical source: `src/observation-recovery.ts`, `src/typed-wait-recovery-storage.ts`, `src/typed-wait-record.ts`, `src/community-collection-record.ts`, `src/migrated-issue-record.ts` (paths relative to `packages/github-operations`).

Consumer evidence: `rg -n 'observationAttempt|resumeLegacyNetworkFailure|observationRetryDelay' packages/github-operations/src` identifies the three observation owners. `typed-wait-poller.ts`, `community-collection-runtime.ts` and `migrated-issue-runtime.ts` retain their existing authorization and cancellation checks. The journal has no new network retry consumer.

Claim guard: the production runtime regression fails at five provider reads instead of eight, and the legacy-pause test fails to observe a change with a null due score. The installed Host checks additionally verify original business bytes, cold recovery and delivery to the original recipient.

## Validation

- Observed RED on the original implementation for PR, Issue, community collection and migrated issue: five reads instead of eight. The corrected legacy fixture separately reproduced no matched outcome after an already-ready old census. A GraphQL EOF and an unavailable CI snapshot independently reproduced the same lifetime exit before their recovery classifications were added.
- Package build and typecheck pass. Package tests: **936 passed, zero failed/skipped**. New coverage includes persisted capped deadlines, one notice per outage, cancellation and real local expiry during backoff, original offline changes, cold recreation and legacy projection migration. Existing authority, quota, queue, batch-isolation, corruption, outbox and routing checks remain included.
- Self-contained alpha.43 passed **3/3** new native Host/owned portless Redis scenarios: prolonged PR outage, prolonged Issue outage and legacy null-score upgrade. All **9** existing complete-action/recovery-boundary/fault scenarios also passed on this artifact. The first combined native run rejected a PR fixture missing its explicit comment author filter; correcting that test input produced the final 3/3 result without changing shipped bytes.
- All **796** built dist files match the extracted self-contained artifact byte for byte. No production runtime, instance, configuration or subscription was changed by these isolated checks.

Commands:

```sh
pnpm --filter @clowder-ai/github-operations build
pnpm --filter @clowder-ai/github-operations typecheck
pnpm --filter @clowder-ai/github-operations test
```

Native probes: `host-network-recovery.mjs`, `host-complete-tracking.mjs`, `host-recovery-boundaries.mjs`, `host-tracking-faults.mjs`. Set `CLOWDER_1843_HOST_ROOT` to a built capable Host and `CLOWDER_1843_GITHUB_ARTIFACT_ROOT` to the extracted package; run through that Host's `packages/api/scripts/with-test-home.mjs` with its `test/helpers/setup-cat-registry.js` preload and `--test-concurrency=1`. Fixtures own Unix-socket Redis children and never connect to production Redis.

Raw logs: `/tmp/github-network-1532-package-tests.log`, `/tmp/github-network-1532-native.log`, `/tmp/github-network-1532-native-network.log`.

## Artifacts and delivery

Toolchain: Node 24.18.0 / npm 11.16.0, using the repository's canonical pack scripts.

- Canonical npm alpha.43: SHA1 `7a92a490d59a1ff4ae7897e00b1156a4ad25469e`; integrity `sha512-JZRwEF8bklOTnVkeU073zFMTUvq+OgJoV8jX0lefjdgxfH2RWRF9aF8IRfRcFAtaV195H86ZvOZDt5nUO4voBg==`.
- Self-contained alpha.43: SHA256 `55ca932742c2a74bcc11a776c4fbdab721b8bcf51b062981b8030fddbb4b4344`; 5,643 members, zero symlinks, 136 installed packages. Relocated factory/runtime entrypoints load.
- Exact archive: `/tmp/github-network-1532-artifacts/f202-w1-tarballs/self-contained/clowder-ai-github-operations-0.1.0-alpha.43-darwin-arm64-55ca932742c2.tgz`.

Independent review, required remote CI, registry publication and an authorized original-instance update remain separate delivery evidence. Public catalog discovery is not activated by this repair. Production still running alpha.41 is not evidence that alpha.43 has been adopted.
