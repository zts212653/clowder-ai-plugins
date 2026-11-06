---
title: Personal Chrome submission observation and long thinking
date: 2026-11-06
status: author-verified
---

# Submission and model thinking stay separate

The observed page uses `data-user-message-bubble="true"` rather than only the legacy user-role selector. Submission observation now supports both, requires a unique stable provider turn ID, and deduplicates markers on the same turn. Missing IDs stay unknown; DOM positions never become provider IDs. A submitted-but-unobserved result carries the existing validated diagnostic fingerprint phase `submitted_waiting_receipt` so Host can distinguish it from a pre-submit failure. There is no new send, retry, authorization, persistence or protocol shape.

The browser fallback answer observer and content-script context retention now share a bounded one-hour lifetime (retention adds one cleanup minute). The adapter checks the exact user anchor and rejects an answer after a later user turn, including modern user bubbles. Observation expiry retains the original submission and Host receipt. This does not guarantee arbitrary-duration answers or a stable ID on every ChatGPT page.

## Evidence

- The original three regressions failed: modern user marker, post-submit diagnostic, and a 31-minute answer against the old two-minute observation limit. `source-red.log.gz` retains that run.
- Package build and both TypeScript checks passed. The final full package suite passed **277/277**, zero skips. A final affected terminal-observation check passed **2/2** after adding assertions that submission and Host ID survive observation failure.
- Adapter and actual generated content-script checks passed **5/5**. Virtual time advances 31 minutes, then inserts the exact causal assistant answer. The bundled check verifies the actual generated artifact retains the helper context; each journey observes exactly one submission. A later modern user turn rejects the unrelated answer.
- The final canonical archive was unpacked afresh and the same five checks passed against its distributed adapter, native modules and content script. Only test files and a development-dependency link were supplied by the harness; product bytes came from the identified archive. `packed-long-thinking.log.gz` retains this separate check.
- `artifact.json` identifies the real archive produced by the repository's native pack script with the workflow-pinned Node/npm/zlib versions. The earlier system-toolchain archive is not the release identity. The archive itself is retained outside Git; native CI publication and registry consumption remain separate required receipts.

All DOM, Chrome messaging, authorization and socket fixtures are synthetic. No account page, production Chrome instance, native ledger, pairing, binding or real model was changed or invoked. This author evidence is not review approval, publication or activation.

Reproduce from `packages/personal-chrome-companion`: `pnpm build`, `pnpm typecheck`, then `node --import tsx --test --test-concurrency=2 test/*.test.mjs test/*.test.ts`. Run `test/personal-chrome-bundled-long-thinking.test.mjs` against the generated content script. Compressed logs retain raw decoded hashes in `manifest.json`.
