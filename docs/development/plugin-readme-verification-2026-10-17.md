---
feature_ids: [F202]
topics: [plugins, documentation, migration-evidence]
doc_kind: verification
created: 2026-10-17
---

# 插件说明的历史开发与核验记录

以下内容从 `6fd31800e7ab7559a1f9b2a43b35ea448cec7235` 的包 README 移出。它们是当时的实现与核验记录，不是安装步骤，也不代表当前发行或验收状态。安装者说明见各包的中文 README.md 和英文 README.en.md。语言文件不引入另一份声明或自动语言选择。

## connector-weixin

## 迁移已知差异

- **配置与启用独立**：保留原扫码配置流程，不增加权限初始化、旧权限导入或手动配置 JSON 的步骤；Host 侧配置/扫码可用性与启用意图分别验收。
- **语音三项 lost runtime env override**：`voiceItemMode`（保持无默认值——未设置本身有独立语义）、`enableUnsafeVoiceModes`、`captureInboundVoiceMedia` 现在全部 hidden，只能通过包配置 A/B 调整，不再有运行时环境变量覆盖入口。
- **`apiBaseUrl` 已删除**：出站媒体只接受 Host 授权的 `hmr_*` 引用，并在 outbound action 返回前通过 `media.read` 读完；旧的相对 URL、绝对路径与裸引用不再读取，改为向用户显示媒体不可用提示。
- **凭据只经由 operation target 写入**：Bot Token 仅通过 `weixin_qr_login` 的 `targetValues` 由 Host 持久化，包内不写 `context.storage`、不打印凭据。
- **「已连接」展示依赖 Host W2-2c**：判断依据是 operation target 是否有值，而不是旧 Hub 的实时连接状态；实时状态请使用 `weixin.test`（有 token 且轮询活跃才返回 ok）。

## connector-feishu

## 迁移已知差异

- **配置与启用独立**：App ID / App Secret 保留原必填约束；扫码可在停用时完成，challenge 由 Host operation state 保存，轮询不依赖运行实例。成功后 Host 保存凭据，保持原启用意图；启用时才运行消息连接。
- **`groupBotMentionsJson` 没有 owner 入口**：群 @bot 别名映射只能通过包配置调整，配置面板不暴露该项。
- **扫码的 target 去掉了 `verificationToken`**：QR 登录回写的 targetValues 不再包含 verificationToken（webhook 校验 token 走普通配置项）。
- **「已连接」展示依赖 Host W2-2c**：判断依据是 operation target 是否有值，而不是旧 Hub 的实时连接状态；实时状态请使用 `feishu.test`。

## connector-wecom-bot

## 迁移已知差异

- **面板里填好即可直接「测试并连接」**：未保存的输入优先；验证成功后凭据由 Host 持久化。操作不改变启用意图，停用时不建立消息连接，已启用时由 Host 重载新配置。
- **validate 失败不再回滚已存凭据**：旧版 stream 起不来会自动清空已写入的凭据；新版验证失败只是不连接，已保存的配置值保留，需 owner 自行修改。
- **凭据只经由 operation target 写入**：`wecom_validate` 的 `targetValues` 回写 botId/botSecret（disconnect 置空），包内不写 `context.storage`、不打印凭据。
- **「已连接」展示依赖 Host W2-2c**：判断依据是 operation target 是否有值（配置级）；实时连接状态请使用 `wecom-bot.test`（WebSocket connected 才返回 ok）。

## enterprise-workflow

## Development artifact

Dev-wave self-contained artifacts are produced with the repository script:

```sh
node scripts/pack-self-contained-artifact.mjs packages/enterprise-workflow /absolute/path/to/f202-w1-tarballs
```

The script takes SDK and contract bytes from the current checkout, verifies the actual
`runtime.entrypoint` after relocation, and publishes an immutable content-addressed filename.
Handoffs identify the artifact by full SHA-256, never by path alone.

## companion

## What the plugin declares

- One feature, `companion`, contributing the `companion` desktop window
  (330×350, frameless, transparent, always-on-top, skip-taskbar, bridge version 1.0.0,
  with an integrity-bound entrypoint).
- `plugin.yaml` is the tracked declaration, available to repository discovery before
  running scripts. Build refreshes its package version and entrypoint integrity;
  `manifest.json` is a generated, identical package export. Commit the refreshed
  declaration whenever those derived coordinates change.

## companion

## Host integration

This surface requires the additive desktop bridge **1.6.0**. The Host computes
placement within the display work area, keeps the cat as its stable anchor, and
owns bounded drag gestures and transparent-area hit testing. Hosts below 1.6
reject this manifest before installation. Media admission and capture
remain in the trusted Host; this package receives neither streams nor provider
SDP. Hiding releases media; the existing Clowder **聊聊** entry restores the cat.
Bridge 1.4 adds one untrusted first-visible-subtitle observation containing only
an epoch-millisecond time, the current call fence and a Host-correlatable source
reference. It does not claim compositor paint, an unoccluded window or reading.
Message and native-item references use the same bounded, single-line opaque ID
contract as the transcript surfaces that supply them. A Host
`invalid_request` rejects and remembers that candidate for the current call so
another current reference may be observed without retrying the rejected one.
Other failures retry after 1 and 2 seconds, then leave the call's
first-visible result unknown; later text never backfills a manufactured success.
Bridge 1.5 adds Host-bound conversation pages and versioned body continuations.
The renderer can only return opaque cursors issued by the Host; it cannot select
an owner, thread, message, call or byte offset. History progress, response phase
and body completeness remain separate, so a processing draft or truncated body
cannot masquerade as a completed reply.

It also binds the one-line composer to the Host-owned durable draft. Versioned
text submission carries the Host-issued conversation `scopeRef`, draft revision
and caller message identity. An unknown settlement is read back but never
automatically resent; an explicit retry keeps the original text, identity,
revision and route. If the canonical thread changes, the old unconfirmed input
stays visible as invalidated local text and is never replayed into the new scope.
The legacy text and conversation methods remain unchanged for older pairs.

Bridge 1.6 separates passive call speech from the bounded nameplate and control
panel, and adds an optional application-assistance projection. Assistance is
off by default; settling a prompt only opens the ordinary menu and grants no
media, screen-selection or call authority.

Xianxian uses one layered sitting body or one VP9 clip at a time. Expiring Host
facts with task, result and event identities select tool work, workspace fetch,
screen reading and applied-result delivery. Native travel is independent: the
renderer observes the actual desktop window coordinates, so a running clip can
appear only after the Host window really moves. Dragging suppresses that
observer and freezes a visibly held candidate instead of renaming the running
clip. Pounce requires an explicit play gesture by default; optional automatic
play is bounded by idle and cooldown timers. Reduced motion keeps semantic
poses static; a compatible Host also revokes its native movement lease.
Other cats retain their own skins. The v3 living assets and their hashes are
pinned in `source-lock.json`; the installable renderer carries all 21 assets
itself, including the mid-edge `peek_fade` variant.

The Host keeps a small transparent margin left of the pet hit target so the
pounce's tail is visible without turning empty space into a click target.

## companion

## Verification

Run the repository's contract and SDK builds, then `pnpm --filter
@clowder-ai/companion test` and `pnpm --filter @clowder-ai/companion lint`.
`node packages/companion/scripts/preview.mjs` serves the accepted interaction
spike at `/spike/` and the actual built renderer with an explicitly simulated
bridge at `/previous`. The latter covers visual states and text controls; it
does not prove native movement, real capture or model delivery.

## personal-chrome-companion

## Helper entrypoint

```sh
clowder-personal-chrome-host --help
```

The executable is POSIX-only. It requires either a Cat Café-created
`--pairing-record /absolute/path.json` or all three Host-supplied variables:

```text
CAT_CAFE_PERSONAL_CHROME_SOCKET
CAT_CAFE_PERSONAL_CHROME_LEDGER
CAT_CAFE_PERSONAL_CHROME_PAIRING_SECRET
```

## feishu-meeting-intake

## Verification

`pnpm --filter @clowder-ai/feishu-meeting-intake test` includes the retained source/cursor/catch-up
regressions plus the actual module/credential/process fixtures. `node --test
packages/feishu-meeting-intake/test/installed-directory.test.mjs` uses the repository's canonical
packer and an empty consumer, then starts the actual MCP and packaged runner's local version
probe. Provider I/O and Host identity in the module journey are controlled fixtures, not dogfood.

## xiangqi

## Host boundary

The Host selects the companion, conversation, display names, retained storage mount, and game before constructing an adapter. It verifies package identity, grants, caller, and lifecycle state on every action. The browser receives only a scoped board view and a local confirmation token; it cannot choose a target or a data path. The package validates Xiangqi moves, journal revision, FEN, and analysis freshness before committing a move. Search workers only prepare candidates. A companion must read the current candidates, choose a legal move, and explicitly commit it through an authorized Host call.

`createHostedBoard({ host })` requires a Host adapter with `openSession()`, `authorizeHumanAction(session, action)`, `notifyConfirmedMove(session, event)`, `deliveryStatus(session)`, and `retryPending(session)`. `createHostedGame(host)` requires `openSession()`, `authorizeCandidateRead(session)`, and `authorizeCompanionMove(session)`. The current executable Host does **not** implement this adapter. The synthetic adapter in `test/hosted-journey.test.mjs` proves package behavior only.

The Host's notification implementation needs an idempotent, durable delivery ledger tied to a confirmed game revision. A process may stop after the journal commit and before the callback settles, so a production Host must reconcile committed journal events on restart. No browser or worker may perform private messaging directly. The package does not claim this delivery seam is implemented.

## xiangqi

## Verify this package

From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm --filter @clowder-ai/plugin-contract build
pnpm --filter @clowder-ai/xiangqi test
pnpm --filter @clowder-ai/xiangqi build
pnpm --filter @clowder-ai/xiangqi lint
pnpm --filter @clowder-ai/xiangqi test:browser
```

The browser test uses synthetic names and a mock Host at 1120 px and 480 px. It covers preselection, cancellation, confirmation, companion candidate selection and commit, refresh, undo, restart, and stale draft rejection. The independent tarball and empty-consumer check runs in repository CI. No game data is needed to run the MCP tools.

## github-operations

## 开发与验收

在仓根安装依赖后，可按包运行 `typecheck`、`test` 和 `build`。本候选的生产依赖保留 Contract `0.1.0-beta.35`、SDK `0.2.0-beta.19` 和固定 Fastify 闭包；源码里的新 SDK 不能冒充这些旧版本。保留版本通过仓内目录准备获取其实际归档，不修改旧归档源码。

当前默认文档 `README.md` 为中文，英文版并列放在 `README.en.md`。两份文档在仓库中互链；相对英文链接不代表 Host 已支持语言切换。Host 当前只读取默认 README，没有自动语言选择机制；两份文档不创建另一份 manifest 或另一个插件。

发行与验证备注：当前源码仍是未公开发布的 C1 本地候选。包内测试或归档完整性不代表真实账号、Host 页面、通知续接和完整用户旅程全部通过；安装验收、公开发行及长期使用验证分别记录。

## collective-connector

此包原 README 主要是源码迁移、旧消费者和各次验收账本，全文保留于下方，供开发核验；其中旧的 Task-bound 路径不代表当前运行路径。当前安装者说明重新按配对、参与、Work、材料和恢复组织。


This private C1 migration candidate owns the existing Collective service and connector business code.
Source is pinned to `ca5b831b48c165ea10c7389fe3eb4ba03d3e01e7`; the separate byte-preserving move is
`4952f27c9306d34cae35cd44b672803f11ed4f48`. The local migration record names every source blob.

The builtin module activates the backend business using a browser-service binding supplied by the Host
before start. The Host owns the stable loopback origin, listener, retained Client resources, grants and
lifecycle. The package opens no listener and has no network fallback for local dispatch. It preserves
business state across disable and resumes an interrupted unclaimed owner bootstrap from a private
credential file. Status contains metadata and the bound API URL, never credentials. Host
Task/custody/principal decisions remain in the Host.

Client assets remain in the Host/C2 boundary. Asset paths cannot enter the declared business transport;
`clientBuildId` is a retained protocol label distinct from the actual asset digest. The private bootstrap URL is a backend handshake coordinate;
it is not a working owner onboarding UI. Settings install/enable/status and the current owner-local Service binding have paired Host evidence.
The authenticated owner HTTP adapter now restores the retained launch/status and existing connector
controls below; remaining authority-dependent controls and native/Host installed use are still open in aggregate task1843. This package remains `private: true` while that
work continues; this checkpoint makes no catalog, installed Settings, publication, or whole-C1 claim.

## Owner control HTTP

The existing Host authenticated webhook lane calls `collective.control.http`; it is distinct from the
browser-service action and native MCP identity. Declarations use the actual `official.collective-connector`
ID. The old root GET becomes `/api/plugins/official.collective-connector/connections`; individual
connection resources use `connections/:connectionId/...`. No anonymous verification secret is declared.

The original eleven owner method/path pairs remain: connections GET; service/provision
POST; inbox/route GET; reconnect/revoke POST; listening GET/POST; and work-policy GET/adopt/revoke.
`POST connections/:connectionId/work/reconsider` retains the original public reclassification request
under an adopted Service rule. It stores the purpose/message relationship alongside the retained private
Connector document, linked to its original inbox receipt; historical packages can still read that document.
It sends without ordinary wake, and then admits through the existing Host Queue after releasing the
connection fence. Replays restore the same entry; terminal unhandled requests remain refused.
The verifier and native callbacks reread the original source and selected rule/class, including queued
original input. Recall or deletion still refuses before launch. The complete installed user journey
remains unverified. Queue admission never means Work completion.
They call the moved connector algorithms. Listening/policy/route preserve local owner checks and
original request schemas. Raw route PUT also retains strict paired-Human targets, scoped revision CAS,
owned participant threads and standing-work channel bounds before `setHostRoute` / publication.
It explicitly opts into the existing Host roster quota fact: `available` is independent of native
`supported`. Default roster consumers retain their original strict shape. Unregistered Cats cannot
be invented from request data. This configuration does not create Task admission or execution
authority; real installed owner use still requires the matching approved Host projection. Unknown local sync/revoke outcomes remain visible 409 recovery states;
ordinary reconnect does not replay or clear a hold. Provision returns the existing `{service,launchUrl}`
shape from the current Host binding and persistent metadata, without starting a second listener.
Only this authenticated launch response contains an unclaimed private bootstrap fragment; public
Service status and connections metadata never do. Claiming bootstrap alone is still setup-required.

The production module now registers seven ordinary native methods (`context.current`, `context.read`,
`participation.set-interest`, `reply.submit`, `work.propose`, `work.accept`, `work.continue`) under `collective-native` and its stdio MCP entrypoint.
It also registers the original `entry-roster`, `pair` and `participation/reconcile` owner webhooks.
Settings → Collective participation → Paired connections lists owner-bound routes; each row’s Sync
uses the authenticated owner operation to send each exact named request with `wake: {catId}`.
Host owns persistence and wake deduplication in that single operation. Native source reads may start
before its receipt returns; they bind the authenticated Host origin to the original inbox and Service.
The private activation verifier rereads the existing Connector inbox and Service permission; it is not
an ordinary action. Native Agent verification reads the actual Host native context, never tool-body
identity. A Work proposal uses the original Service operation. Acceptance and continuation require the
current owner-adopted Work grant and exact source/revision references; they return
`accepted_pending_host_admission`, not an active Host Task. Retained sources keep their original granted
methods after upgrades. Two other native methods and the private Work/purpose and remaining owner controls retain their original
separate consumers and are not advertised as complete.
Host owns authentication and those durable facts; the package parses its own participation/Work rules.
Actual retained page and installed use must be validated with a matching Host caller candidate.

## Binding and recovery

The Host binding supplies the exact service origin, parent origin, protocol label, asset digest and
finite transport limits. There are no package port/origin/public-URL configuration overrides.
The manifest declares 59 literal routes, of which 19 permit local dispatch. Local pairing exchange
requires the exact parent origin; other local calls omit Origin and cookies. Browser mutations require
the service origin; the two declared provider callbacks retain their explicit Origin exception.

Four local effect families (outbox, ACK, participation and revoke) persist an attempt before entry.
Unsettled attempts survive restart as unknown holds. Ordinary sync/reconnect cannot clear them or
change the operation identity to bypass them. The existing Manager recovery operation lists bounded
rows and offers authenticated `reconcile` and, when proof permits, one `resume` of the same operation.
Owner identity/lifetime comes from the distinct Host owner-operation context, never from request data.
Unknown revoke keeps its credential and revoking state; a 401 or a message mentioning revocation
does not prove success. Confirmed recovery uses exact same-instance persisted evidence; event dedup
alone does not certify Work result/progress effects. Remote fetch/recovery retains the source behavior.

The module uses its authorized data directory and the Host browser-service binding; it does not read
SDK configuration. The declared Settings operations are actions, not configuration values. The former ambient CLI is
retired. Existing domain persistence and authentication transitions are retained. Unclaimed credential
expiry still follows the source service's 24-hour bootstrap policy. No old user state is imported.

The retired CLI's `COLLECTIVE_SERVICE_HOST` is not read: listener ownership belongs to the Host.
`COLLECTIVE_GITHUB_CLIENT_ID` and `COLLECTIVE_GITHUB_CLIENT_SECRET` are also not read; GitHub OAuth
configuration currently comes from the existing App Manifest setup flow. Settings secret configuration
remains a later composition decision.

The package root exports only the default module, `createCollectivePluginModule`, and its options type.
Connector/service internals and domain declarations remain private implementation details.

## Install permissions

- `plugin.state.get`: re-read the original first-source/Cat business receipt from the Host-private container.
- `plugin.state.set`: retain the immutable first choice and exact execution binding through the existing CAS container; it does not issue permission.
- `task.admitEntrusted`: the separate Work feature may prepare/dispatch the exact current authorized source; this does not grant `task.write` or Task CRUD.
- `message.event.subscribe` and `media.read`: capture original callback file bytes in subscribed private Work threads; reception does not select or authorize Work.
- `task.write`: the ordinary-send Work adapter maintains the existing UI Task record and marks it done only after the original Service result-acceptance checks. This record does not authenticate an execution.
- `thread.readContent`: read only the authenticated native origin and its current source through Host ports.
- `thread.listMetadata`: verify the owner-created route thread before admitting a named request.
- `thread.write`: create the original per-channel owner threads and materialize selected participants.
- `messaging.send`: send an exact request and wake its named member in one Host operation; replies return through the Collective business outbox.
- `data.directory`: persist Collective business state and private credentials in the Host-authorized
  package directory. Stop preserves that state; the package never falls back to another directory.

While active, this builtin runs inside the Host process. Explicit Host listener disclosure/consent and
measurements of state-write impact on the Host event loop remain release prerequisites. The transport
policy is bounded at 256 KiB request, 32 MiB response and 10 seconds, not a claim of arbitrary-state parity.
Timeout/abort can refuse a response after a business write has committed; it never implies rollback.

## Verification from this checkout

```sh
pnpm --filter @clowder-ai/collective-connector typecheck
pnpm --filter @clowder-ai/collective-connector test
pnpm --filter @clowder-ai/collective-connector test:source
pnpm --filter @clowder-ai/collective-connector test:installed
```

`test:installed` builds the exact SDK/contract/module in this checkout and installs the module directory
into an empty physical npm consumer. It exercises bootstrap, create, disable, and re-enable using fresh
temporary data and a fixture Host binding; it asserts zero package listener attempts. Exact local
contract `0.1.0-beta.36` and SDK `0.2.0-beta.20` archives resolve unpublished versions. This proves
physical closure and module behavior, not actual Host or browser acceptance. Host `93fee434` predates
this transport and owner-operation surface; its old pairing probe is not a green acceptance target.
Matching Host retained Client launch/iframe and normal stop/restart journeys, the remaining owner/native
controls and authority mapping, and the original finite C1 installation/use acceptance remain open.
The existing maintainer local acceptance is the original combined testing/publication finish line; this
package does not add a second operator acceptance or soak gate. Publication is not admitted.

### Retained participation policy

The retained Host participation panel can send `PUT connections/:connectionId/participation/policy`
through the existing owner-authenticated webhook lane. Its strict body is
`{expectedRevision, channelIds, policy:{defaultMode:"include", excludedCatIds, channelOverrides}}`.
The original reconciler reads the current Host roster, keeps owner threads and initial exclusions,
checks the route revision, and publishes the resulting participation. This operation changes the
participation policy; it does not admit a Task or grant private execution. `POST .../participation/reconcile`
continues to accept only `{expectedRevision, channelIds}`.

Request/Task mutations and private Work callbacks remain migration work. This policy endpoint does
not make those missing journeys available; the independent owner send is described below.

### Owner Agent messages

The separate `collective-owner-native` MCP contribution exposes
`cat_cafe_collective_connector_send({connectionId,clientEventId,target,body,replyToEventId?})`.
It uses the authenticated second action context from Host `c3e78fd8cc5183ea48ad2f88f411e46a4fb11e0a`
and requires strict owner provenance with no limited tool policy, the owner's paired connection,
and the current Host Cat profile. Agent identity/session and display-name qualification come from
the Host context and roster; they are never tool arguments.

The original seven public methods remain in their own `collective-native` contribution. Public
participation and purpose/private Work returns cannot use unrestricted owner send. Owner send
only queues an original Agent message; the existing Connector Sync sends it to the Service.
Reuse the exact clientEventId, payload and invocation after response loss. A changed payload or
Agent session for the same clientEventId conflicts. Late authority loss may leave a queued effect;
a rejected response never claims rollback. This operation grants no Task or private execution.

The SDK declares the existing authenticated `ownerAuthProvenance`, optional policy and exact
`originTriggerMessageId` facts. It does not derive permission from userId, input or a held source.
Original private Task admission/execution remains migration work.

### Retained owner participation view

`GET connections/:connectionId/participation` preserves the original owner view: connection and route
revision, registered/removed Cat eligibility, desired policy and initial exclusions, bindings/channel
routes/interests, owner thread choices, routed requests/responses and the owner's admitted-source Work
Task summaries. It reads existing Host ports and requires `task.read`; it never writes/adopts a Task,
admits execution, creates a thread or borrows native identity. Accessible foreign threads and Tasks do
not become owner data. The Host thread list is traversed with its existing exclusive cursor, then every
row is checked through the strict owner thread port.

Request progress preserves the original owner, source event, connection, recipient Cat and target
binding checks. It consumes the existing Host `sourceFacts.readProgress` owner-only, content-free
projection. Current Queue `status` and per-target seen/exposure/failure/handled witnesses supply
queued/started/failed/ended; the deleted `executionScope` marker is not synthesized. Terminal custody
is retained by the actual Queue delivery transition. Queued body reads stay forbidden. Missing ports,
missing Queue facts or refused progress reads omit execution instead of inferring it from Task status
or content. These display facts never authorize private Work or Task execution. Complete retained
request/Task actions, private/progress returns and real owner browser journeys remain open.



The retained participation GET consumes the SDK's declared `PluginTaskReadItem` through existing
`task.read` ports. Owner/source filtering uses explicit `userId` and the bounded entrusted Work
summary; a Host missing that projection fails the read visibly. It does not grant Task writes,
admission or execution, and unavailable Queue progress facts remain unavailable.


### Retained individual participation mutation

The existing owner `PUT connections/:connectionId/participation` retains the original strict per-Cat
schema, route revision CAS and connection mutation serialization. Enable stores the Cat's public
participation and optional owner standing-work scope; disable removes both while preserving the
same owner thread. The current Host roster decides eligibility and strict owner thread ports reject
deleted or foreign threads before mutation. The original Connector persists route/standing-work
revisions and publishes participation to the Service. This configuration does not create a Task,
admit execution or allow a public/native caller to act as the owner. Work admission and progress use
the separate Work feature below; resume and the complete retained browser journey remain open.

## Private Work production actions

The distinct `collective-work` feature owns `collective-work-native`. During the accepted migration
closeout, registered Agent Work uses ordinary `messaging.send(wake)` into the original private child
thread and default `nativeContext.current()`. Registry facts and the existing Service grant authenticate
the call; the same Task retains its original entrustedWork data and Schedule projection without a Host execution receipt.
Current/read/progress/result-return are connected on this path. The retained owner page associates
the same UI Task with its original inbox messages. `POST .../work/resume` rechecks the original Service
continuation predicate and sends into the same private thread; the same requestId deduplicates the
message and wake. The page's observed revision is the canonical Task contract revision, distinct from
Service execution authority and material-selection versions. `POST .../work/result/accepted` retains the original strict DTO and current Service acceptance
checks before closing that UI record; repeated reconciliation returns already_closed.
Committed Human manual and standing entry points now use the same ordinary send/read/result path.
Original document generation and callback publication now enter a declared Work-thread subscription.
The Host grants HMR reads only during delivery; bounded text is retained privately for later result reads.
Arrival does not select a result. The original explicit artifactRefs registration moves to
`collective.work.artifact.register`, using `artifactSelection.revision` from current context. This is
the same Task contract revision used by dates and closure; Service execution revision is independent. It does not intercept
the old global update-entrusted-work callback. Task creation preserves original source/outcome/closure/time
through the Host data lifecycle. Explicit selection writes that Task's original artifactRefs, without a
parallel private selection record; private storage retains only captured publication bytes and Service
association. Typed accepted-result closure uses the existing publication reader to seal completion,
so active and completed Schedule reads keep the original material coordinate.
Public participation and owner-send retain their own
grants. Progress preserves result/execution identity and
never completes Work. The inherited native reference key remains under the same authorized directory.

Settings → Private Collective Work → Paired Work connections offers an authenticated Sync operation.
Work syncs immediately at activation and every two seconds, without requiring the Settings operation.
Disable/stop cancels and drains that loop. The SDK uses the Host's actual installed instance id.
Human requests first retain their original participation-thread inbox message without waking private Work.
An existing Service commitment plus the original manual owner choice or current standing scope permits
private delivery. A request without Service Work remains unavailable, as in the original implementation.
`POST connections/:connectionId/work/admit` uses the original owner DTO and authenticated owner HTTP
context. An explicit business deadline is saved with its original source reference in canonical Task time;
missing or ambiguous time retains the original clarification outcome. Date storage and Schedule projection
are separate from ordinary wake, and do not require prepareEntrusted/dispatchEntrusted.
Manual and standing choices reuse the existing private first-choice container. Registry identity and
current Service/route checks authenticate the native consumer; the Task UI record is not a grant.
A later registered Agent execution uses its current Service grant even when the first assignment came
from a Human. If no Task exists, the original first assignment determines the private-thread site while
the current grant permits execution. Owner resume reuses the same Task/thread and original continuation
rules. Existing bare or legacy execution-bound records are not silently adopted into the new subject;
accepted closure uses the typed Task lifecycle, never generic status writes. Browser/Manager/provider and
the original Schedule material-button journey remain unverified by these module probes.
### Prior Task-bound adaptation evidence (not active runtime)

The current module no longer imports the legacy Task-execution reader/admission/artifact handlers or
declares publish-text. The following records prior adaptation evidence, not a second active Work path.

The following retained adapter is not required by ordinary Work execution.
In this legacy Task-bound path, a registered Agent continuation reads its immutable first receipt, preserves the original
Task/thread/admission, and captures a separate execution receipt before the fresh exact Service acknowledgement
and Host dispatch. It does not recapture the first basis. The native reader also requires both receipts.
The immutable first Task may have originated from a committed Human manual or standing choice. A later
registered Agent execution uses its own current Service grant and fresh acknowledgement; the old Human
request or route scope remains lineage, not permission for that execution. A missing first Task can also
bootstrap from a Human assignment under that same current registered permission.
When a registered Agent already has execution >1 but no first Task, owner Settings sync can bootstrap
using the immutable first assignment as the Host admission source. A separate private lineage record
carries no grant; the current execution receipt carries the freshly revalidated Service permission.
Both are retained before effects and bound to the exact same Task/execution before the current Service
acknowledgement and dispatch. Native consumers preserve the Host's first-source snapshot while reading
and rechecking the current source through that relation. Missing/conflicting bindings cannot dispatch,
and a surviving Task without its original lineage cannot be recaptured. The Host classifies this first
Task admission as `initial`; its existing first-admission replay is distinct from continuation recovery.

For that legacy path, the current Host classifies an owner-operation continuation as `owner_resume`: the same request can dispatch,
but another HTTP/Settings request cannot borrow that descriptor. Cross-request replay remains unavailable;
the package does not bypass this protection or infer success from a stored Queue receipt.

This is production declaration and consumer wiring, not a complete installed Work journey.
Deadline metadata, material/browser operations and the complete installed/provider journey still need
their original integration. The ordinary-send owner resume above does not relax the remaining legacy
Task execution descriptor. Old production data import is outside this fresh-data migration acceptance.
The declared skill uses current package text publication and accepted-history readers; actual Host skill mounts and agent/operator use still need full installed acceptance. The current private text publication and result-return path has composition evidence,
not a complete installed/operator/provider journey. The original `collective-participation` skill is now declared and packed with the backend feature. Its public and private Work instructions name only the installed MCP methods; loading it adds no Work authority or grants.
Text publication captures the authenticated native publisher and Task/result/execution scope in the
existing private CAS. Markdown/plain text is bounded to 65536 UTF8 bytes; binary/NUL and malformed
Unicode are refused. The thread gets one file reference, while bytes stay private and the artifact reader
rechecks the stored message and digest. Ordinary plugin messages remain ordinary messages: the package
captures their association with the native invocation instead of claiming a Host callback row.
A settled response loss reuses the original publication. Successful publication also binds its snapshot
to the existing prepared reply slot; missing private material cannot silently become a body-only result.
The same private result aggregate atomically selects text or no artifact before return; result return
stores the exact selected snapshot in the existing Service-accepted outbox. Returning a result does not approve it or close Host Task custody.
The original context-read action also reads the previous accepted package text result. Current Service
history must match exactly one accepted local outbox snapshot for the same Work, Task, owner and result;
the reader then verifies its old publisher capture, live owned trigger/publication, immutable seal and
private bytes, and rechecks that accepted witness. Historical text never revives the old execution.
Missing/ambiguous accepted witnesses are unavailable; missing bytes or withdrawn old publications fail
closed. Old production files and pre-subscription uploads explicitly remain unavailable and no arbitrary path or URL is opened.
No background source is emitted using a guessed instance id or Host provenance. Full C1 remains open.
