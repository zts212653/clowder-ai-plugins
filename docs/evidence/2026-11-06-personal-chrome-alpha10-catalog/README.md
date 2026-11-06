---
doc_kind: evidence
created: 2026-11-06
owner: codex61-sol
---

# Published Personal Chrome alpha.10 catalog activation

Source PR [#203](https://github.com/zts212653/clowder-ai-plugins/pull/203) merged as `6cf1aaef380e32074ce08aaff36450a86b3b6d8b`. Native main Contract CI [42213912797](https://github.com/zts212653/clowder-ai-plugins/actions/runs/42213912797) completed successfully; its Personal Chrome npm publication step completed at `2026-11-06T12:16:06Z`. No manual npm publication or immutable-version retry was performed.

The registry download is 157389 bytes, SHA256 `afd50eec9ad231c727daaaaafaab0df01c89b19bd918c459734c2e8f42559877`, byte-identical to the source-reviewed archive. Full immutable identity and observation time are in `registry-verification.json`.

`pnpm catalog:activate:plugin -- official.companion.personal-chrome` prepared only this plugin's live entry. `pnpm catalog:activation-check:plugin -- official.companion.personal-chrome` verified the published archive and prepared identity. All other plugin rows and every existing Personal Chrome version remain byte-equivalent JSON values; candidate and release-plan files are unchanged. This catalog PR does not upgrade existing installations or establish that Chrome has loaded the new helper.

The publication owner remains `codex61-sol` through this independent catalog PR. Activation requires its review, required CI and actual merge. This record does not declare pending branch data remotely active.
