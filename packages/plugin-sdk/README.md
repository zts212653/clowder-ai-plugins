# @clowder-ai/plugin-sdk

Runtime helpers and typed Host boundaries for Clowder AI plugins.

`context.config.get` and `context.secrets.get` expose the plugin-activation snapshot. After an operation changes configuration, runtime paths must use the values currently held by the live process or adapter rather than rereading that snapshot.

`context.ownerThreads` is an optional strict owner webhook port. When supplied by the Host, all three methods are present: `get(threadId)`, `create({ title })`, and `addParticipants({ threadId, catIds })`. They return `{ id, createdBy, participants }`; `get` may return `null`. Reads require `thread.listMetadata`; writes require `thread.write`. The Host also requires its current authenticated owner webhook request and checks `createdBy` ownership. Plugin bindings, native callers and generic accessible `context.threads` are not substitutes.

Older carriers leave `ownerThreads` absent. Callers must report the missing port rather than fall back to a wider thread API. `create` is an ordinary write, not an idempotent ensure; failed writes are never automatically retried. The SDK preserves Host refusals, validates immutable projection snapshots, and refuses calls or late results after feature stop. This owner-thread port does not grant owner authority, supply participant eligibility, or admit or dispatch Work.

### Participant roster

`context.participantRoster?.listForNativeContribution({ contributionId })` mirrors the optional Host public participant roster. It accepts only a contribution coordinate; Host derives the admitted instance, action methods, caller authority and owning feature grants. Owner reads do not require a participation invocation; native reads require a verified same-owner invocation. Host refusals propagate without retries or catalog/available fallbacks.

Rows retain `catId`, `displayName`, `defaultModel`, `supported` and optional public nickname/variant/role/avatar. The facade validates and returns detached frozen rows. `supported` is provider enforcement capability, not availability or an invocation admission receipt; `false` stays false. Older carriers keep the port absent, supplied partial ports are rejected, and stopped feature sessions reject calls and late results. No provider policy, private avatar path or new capability is exposed.

### Exact source facts and native context

`context.sourceFacts?.read({ messageRef: 'message:<id>' })` and `context.nativeContext?.current()` are separate optional Host ports. Both require the existing `thread.readContent` feature grant. Source facts include only `id`, `userId`, `threadId`, nullable `catId`, `content`, `source.connector`/optional JSON `meta`, and `extra.pluginMessage.instanceId`. Native context adds authenticated `userId`, `threadId`, `catId`, `invocationId` and the exact `originTriggerMessageId` with its source fact; it accepts no body identity. Returned data is detached and deeply frozen.

Host permits an authenticated same-owner webhook to read same-instance plugin sources in owner-created threads; native reads are confined to the current exact origin. Deletion, recall, invalid sources and currentness drift are refused. The Host queued-source fix permits only the authenticated exact child to read its own processing same-instance source; owner, foreign and terminal queued reads remain refused. The SDK propagates refusals, performs no retry or generic-thread fallback, and rejects calls and late results after stop. Older carriers keep each missing port absent. The default source reader provides no Task/receipt/ancestor access, background/list operation or public invocation authority. Task native context is a separate explicit opt-in described below. Package-owned participation and Service rules still require their own validation.


A feature activation may supply an own data-function `publicInvocationVerifier`. The SDK preserves this optional private slot through the builtin module activation, detached from public actions. Its exact Host input is `{authority:{ref,revision},source:{messageRef},targetCatId,native:{contributionId,methods}}`; the revision is an opaque string. The context contains only `signal` and `assertCurrent()`, and a successful business check must return exactly `{current:true}`. Host instance, declaration, grant and source admission remain authoritative. SDK stop/abort/late-response guards add no owner/native context, retry, source-read fallback or launch permission. Older activations remain absent; malformed or duplicate feature slots refuse startup. This preserves the private ABI; it does not supply Collective verifier business logic or installed execution acceptance.
### Public source admission

`FeatureContext.publicInvocations` is optional on older Host carriers. When present,
`enqueue({ messageRef, targetCatId, native: { contributionId, methods }, authority: { ref, revision } })`
admits an already persisted same-instance Message to the Host's existing single-target Queue.
Use `context.messaging.send(threadId, draft)` without wake first, save the original business
source/authority mapping in plugin-owned durable storage, then call enqueue with its Message ref.
The authority revision is an opaque string. The native contribution and methods must be declared
and active; Host owns their admission, installation, source, owner and grant checks.

The feature needs existing `messaging.send` and `thread.readContent` grants. SDK checks these
and its lifecycle before and after the call, freezes a detached input snapshot, preserves Host
refusal, and never retries. The result contains only `messageRef`, `entryId` and
`status: 'queued' | 'processing' | 'terminal'`. A terminal receipt is Queue custody truth,
not business reply success; use the plugin's original reply path. A rejected late response
does not roll back Host effects already committed.

The private `publicInvocationVerifier` must check the plugin's actual persistent business mapping
and current Service authority in its isolated `signal/assertCurrent` context. Neither this port
nor a source fact supplies purpose-winner proof, invocation-bound opaque signatures or private
Task/Work receipt authority. Enqueue is refused by Host inside verifier/browser purpose. This SDK
mirror does not register Collective's staged native callers or establish installed functionality.


### Task read projection

The existing `get`, `listByThread`, `listByKind` and `getBySubject` methods return `PluginTaskReadItem`.
It retains the minimal Task fields and explicitly includes `userId` (`null` for an unowned legacy Task).
An optional `entrustedWork` summary includes only `revision`, `closure.state` and `admission.sourceRefs`.
SDK reads return detached immutable projections and reject a missing owner field or malformed summary;
they do not silently turn an incompatible Host response into an empty owner view.
The summary is read-only data, not a grant, receipt, Task admission or execution authority.
`pluginWait` is also projected to its declared neutral fields, including the nested `await` and
`waitOutcome.ownerFence`. Host-only identity, registration/source and invalidation fields are excluded;
malformed declared wait fields fail the read. Task mutation method signatures and required Host write
permissions are unchanged.


### Owner Queue progress

`sourceFacts.readProgress({messageRef})` is an optional existing-Host read surface requiring
`thread.readContent` and an authenticated owner request. It returns source identity and optional
Queue display facts without content, invocation witnesses, receipts or execution authority. SDK
validation rejects body/extra authority fields, malformed projections and mismatched message IDs;
outputs are detached and frozen. Older Host carriers keep this method absent. There is no fallback
body read, retry or native identity substitution. Host authorization and currentness still govern
queued and delivered terminal progress; the package keeps its original per-target display checks.


### Entrusted Task preparation and dispatch

When the Host supplies them, `context.tasks.prepareEntrusted` and `dispatchEntrusted` require
`task.admitEntrusted`, an L2 capability separate from `task.read` and ordinary `task.write`.
Older carriers keep missing methods absent. The SDK validates detached immutable inputs and outputs,
checks capability/lifecycle before and after each call, and never retries or dispatches automatically.
Late refusal does not undo an effect already committed by the Host.

`prepareEntrusted({sourceMessageId,targetCatId,destination,subject})` accepts source/target selectors,
`destination: {kind:'derived_from_source'}` or an authenticated owner's `{kind:'existing_thread',threadId}`,
and `subject: {kind:'new',title,intendedOutcome,closure?,time?}` or
`{kind:'continue',taskRef,expectedRevision}`. Closure and typed time facts retain the existing Lifecycle
contract. Results are `needs_clarification` with a reason, or `admitted|resumed` with
`taskRef/taskRevision/threadId/admissionRef/executionRef`. Preparation does not run a provider.
`dispatchEntrusted({taskRef,taskRevision,executionRef})` returns only `messageRef/entryId/status`,
where `status` is `queued|processing|terminal` Queue custody truth, not a completed business result.
Host rereads source, Task, protected receipts, ownership, installation and current grants;
request bodies cannot supply owner identities, grants or execution bindings.

`nativeContext.current({includeTask:true})` additionally requires `task.read` and returns the existing
native context plus `task:{taskRef,taskRevision,admissionRef,executionRef,sourceRevision}`. The original
plugin source and Host dispatch trigger have different roles; their IDs and threads may differ.
Host authenticates both threads and the current Registry binding. `current()` retains its original
strict default shape and exact-origin behavior. No bearer or caller-supplied binding is accepted.
The plugin must still validate its own current Work, source, result and execution scope before use.
