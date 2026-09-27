---
title: F170 first-consumer Host interaction draft
date: 2026-09-27
status: draft
---

# F170 first-consumer Host interaction draft

This is a reviewable contract/SDK candidate, **not a published API or executable Host contribution**. The files under `packages/plugin-contract/drafts/` and `packages/plugin-sdk/drafts/` are excluded from both npm packages. The Xiangqi manifest continues to declare only its existing pure MCP position tools. Names and version `v: 0` are provisional until the Host owner and Design Gate freeze them.

## Journey and authority

Before: a person confirms on a standalone board, the plugin saves a move, and an in-memory callback may be lost before the Host accepts the notification. After the proposed Host seam exists: the real Settings surface selects a companion and conversation; the Host signs a durable binding generation and trusted human confirmation; the plugin saves one move with its action reference; the Host admits that action idempotently and schedules the selected companion. The person sees saved, pending, accepted, running, failed, or completed status and can retry without playing twice.

The Host owns package identity, grants, selected target, trusted confirmation, runtime lease, session handle, restricted storage and UI, notification admission and execution. The plugin owns FEN, legal moves, journal CAS, operation digest comparison, analysis freshness, and candidate selection. The selected cat still commits its own move. The Host never parses chess moves or stores a second scorebook.

## Contract-to-execution matrix

| Contract/SDK method or draft | Existing Host handler | Executable fixture now | Missing executable seam |
| --- | --- | --- | --- |
| `FeatureBinding` + `createFeatureContextSession` (SDK beta.15) | `runtime-composition.ts` owns inventory/Broker; builtin supervisor checks package and grant on MCP tool calls | Existing `feature-context.test.ts`, `plugin-builtin-contribution-supervisor.test.js` | Inject current, authenticated caller and selected interaction session into a supervised plugin process; no cat/thread/root from MCP arguments |
| Draft `openCurrentSelection()` | `HandleService.issueThreadHandle/resolveForSend` binds message address to instance/user/thread | `plugin-sdk/drafts/interaction-client.test.mjs` accepts the current binding and rejects cross-session/old lease | Host-selected companion and conversation authority separate from ThreadHandle message-address scope |
| Draft `host-confirmed-action` envelope | `createMessagingBrokerHandlers` supports bounded send/receipts; `messaging.send` does not wake cats | Draft valid/forged-target JSON fixtures; parser rejects raw cat/thread/dataRoot; SDK fixture rejects unissued proof, changed digest and old lease | Trusted Host human confirmation control; durable admission + queue with actionId, generation, digest and opaque object/state refs; cat invocation authority |
| `ui.register` (SDK) and current `UiContribution` | Builtin supervisor executes stdio MCP only; `plugin-package-assets.ts` serves icon/README, not an app | Host Settings preview branch uses real Settings shell with synthetic data and the original board | Generic restricted page mount/command bridge and grant/lifecycle fencing; no desktop-window/content-editor/meeting impersonation |
| Plugin journal confirmation action | Host delivery adapter does not exist yet | `notification-recovery.test.mjs`: commit→crash→same action retry, lost receipt after durable accept, undo and binding change | Host durable idempotent accept/execute and receipt status; production Host must verify proof, grant, target and runtime lease |

## Draft state contract

- **Authorization generation** is durable for one explicit owner selection. Ordinary process restart invalidates the runtime lease, then Host revalidates the same binding and may resume with a new lease. Switching companion/conversation, changing material grants/package, disabling or uninstalling invalidates the old generation. No old action is redirected to a new target.
- **Trusted confirmation** is created by the authenticated Host human surface. A plugin iframe's `confirmed=true`, a method call, or a caller-supplied target is never proof. Host issues a bounded one-time confirmation handle for an exact object reference, expected state token, action ID and operation digest. The draft parser only checks shape; Host checks issuance, principal, expiry, consumption, generation, package/grant and lease. Plugin independently checks digest against the current game revision/FEN/move before CAS.
- **Durable move** carries `actionId`, generation, state token and operation digest in the same atomic game journal event as the move. The separate receipt file only records Host acceptance. If it is absent after crash, the journal reconstructs pending work and retries the same action ID. Host's durable ledger must return the same receipt for the same ID/digest and reject the same ID with different content. A plugin receipt cannot substitute for Host admission.
- **Execution** distinguishes accepted, queued, running, completed/failed and revoked. The Host must fence authority before enqueue, execution and cat commit. Undo/restart removes superseded actions from the plugin's pending projection without erasing historical events. A revoked binding cannot replay to a new target; pre-revocation completed results remain visible.

## Fixture boundaries and next gate

Run `node --test packages/plugin-contract/drafts/interaction-action.test.mjs packages/plugin-sdk/drafts/interaction-client.test.mjs` and `pnpm --filter @clowder-ai/xiangqi test`. These are contract-shape and synthetic Host fixtures. They do not prove a real Host-issued confirmation, browser surface, durable queue, or selected cat invocation. The Host prototype records which steps are synthetic. A future Host implementation requires its own generic, non-chess fixtures for forged proof, expired/reused proof, cross-binding, old grant/package/lease, crash after accept before enqueue and after enqueue before receipt, and revoke across accepted/queued/running states.

No private score, conversation, path or production endpoint is an input to this draft. Do not add this draft to package exports, catalog, or production runtime before the Host owner freezes the contract and the user judges the Settings experience.
