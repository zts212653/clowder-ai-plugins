# Normal publication stays green; discovery remains accountable

## Cause and resulting behavior

The last green main Contract CI run before this gap was [40467721867](https://github.com/zts212653/clowder-ai-plugins/actions/runs/40467721867), `5b99aab2`, on October 27. In the independently inspected recent main run [41548448173](https://github.com/zts212653/clowder-ai-plugins/actions/runs/41548448173), validation and every npm upload succeeded; the final `Require published catalog activation` step failed. Activation-only #181 was likewise unable to satisfy unrelated pending candidates.

[#97](https://github.com/zts212653/clowder-ai-plugins/pull/97) correctly identified a real loss: npm packages could be published with no continuing discovery owner. But checking whole-catalog activation only after a source merge creates a systematic false failure: source merge precedes publication, and the separate catalog PR necessarily follows publication. PR CI skipped the publish job and could not expose that inevitable failure in advance.

This change checks the destination and owner of new immutable plugin releases in the required PR job, before merge. After upload it verifies distribution and reports waiting as data. The daily audit writes deduplicated, named GitHub reminders for published activation work, expired waits or missing ownership, and resolves its own bot-created reminders after activation or a reviewed disposition change. Strict whole-catalog completion remains available as an explicit manual command, rather than the default main gate.

## The 14 old candidates

All 13 entries below are unchanged published identities from [#118](https://github.com/zts212653/clowder-ai-plugins/pull/118), the permission-model cleanup. The paired public Host [#1720](https://github.com/zts212653/clowder-ai/pull/1720) and home intake [#6236](https://github.com/zts212653/cat-cafe/pull/6236) merged on October 27. The original source/intake work did not own bulk catalog activation. This repair now names `codex61-sol` for this catalog follow-through.

| Plugin | Live before | Prepared live |
| --- | --- | --- |
| GenOffice DOCX | alpha.2 | alpha.3 |
| Video analysis | alpha.3 | alpha.4 |
| Video generation | alpha.2 | alpha.3 |
| Xiangqi | alpha.2 | alpha.3 |
| Personal Chrome | alpha.8 | alpha.9 |
| DingTalk | alpha.7 | alpha.8 |
| Feishu/Lark | alpha.8 | alpha.9 |
| Telegram | alpha.7 | alpha.8 |
| WeCom agent | alpha.7 | alpha.8 |
| WeCom bot | alpha.7 | alpha.8 |
| Weixin | alpha.7 | alpha.8 |
| Xiaoyi | alpha.7 | alpha.8 |
| Enterprise workflow | alpha.4 | alpha.5 |

Each was prepared with the existing `pnpm catalog:activate:plugin -- <pluginId>` command under pinned Node 24.18.0/npm 11.16.0. Actual npm metadata and downloaded archive identity/bytes passed verification. Every previously live version row remains unchanged. Candidate and initial selection files are unchanged.

**Companion alpha.37 stays deferred**, with live alpha.35 unchanged. Owner `opus55` waits for bridge 1.7 Host admission and complete combined F335 acceptance. `2026-11-06T08:00:00Z` is a progress review date, not a feature completion deadline. A current production Host installer rejects alpha.37; this repair does not weaken that rejection.

Companion **alpha.36** came from #118, changing the manifest/development dependencies for Contract 0.3 and retaining the prior renderer behavior. Its archive is still in candidate history and is independently installable by the tested Host installer. That observation does not establish desktop runtime acceptance: exact companion archive/bridge admission is a separate boundary. The original #118 source/intake task is closed and explicitly did not hold catalog activation; no independent consumer waiting specifically for alpha.36 was found in that original handoff. Alpha.37 carries that cleanup forward, so it remains visible under the combined Companion wait rather than disappearing into an unrelated completed task. No Companion archive was activated here.

## Evidence and limits

[Host admission evidence](evidence/2026-11-03-catalog-host-admission.json) records the actual loaded Contract **0.3.2-candidate.0**, production source hashes, 13 successful isolated installs plus Companion alpha.36, and alpha.37 rejection. The probe used temporary directories and an in-memory inventory, with no accounts, runtime starts or Redis. The first probe in the development checkout loaded stale Contract 0.2; it was rejected as consumer evidence and rerun against Alpha. Nothing in this change installs/upgrades the owner's daily instances or claims real-account feature acceptance.

The executable Git-backed release journey uses the production PR validator, audit, issue reconciler and scoped activator with only npm/GitHub I/O replaced by deterministic fixture providers. It observes undeclared PR rejection; declared source PR acceptance; actual local Git merge; publication; a green pending audit with an owner reminder; no duplicate reminders on repeat; a separate scoped catalog PR merge while another version legitimately waits; reminder closure; and a green overdue audit naming the waiting owner. Corrupt published identity and failed notification delivery remain errors.

The real pnpm/gh-process boundary test also exercises pending → overdue, changed owner and a renewed deadline expiring again. Each creates a new issue and closes the old one; repeated observations are deduplicated and metadata-only edits stay in place. Escalation never depends on comment delivery. Bot-authored probe [#190](https://github.com/zts212653/clowder-ai-plugins/issues/190) independently verified the existing scanner's new-issue delivery to its Repo Inbox steward. Routing onward to another named cat follows the existing maintenance task convention and was not end-to-end tested by that probe.

Commands and exact remote review/CI receipts are attached to the repair PR. This note records author preparation and bounded verification, not a claim that a pre-merge file was already public or that existing installed instances had updated.
