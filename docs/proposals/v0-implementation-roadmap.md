---
title: Clowder AI 插件系统实施路线图
status: 执行中 — M0 Core PR #1380 exact HEAD 的 5 项 CI 已全绿且 MERGEABLE，等待 maintainer exact-HEAD 复审；下一阶段冻结为联合验收、完整基础底座与存量迁移
discussion: zts212653/clowder-ai-plugins#1
ack_request: https://github.com/zts212653/clowder-ai-plugins/issues/1#issuecomment-5236600431
acknowledgement: https://github.com/zts212653/clowder-ai-plugins/issues/1#issuecomment-5248175358
progress_refresh: https://github.com/zts212653/clowder-ai-plugins/pull/25#issuecomment-5261613034
created: 2026-07-14
revised: 2026-08-23
feature_ids: [clowder-ai-plugins-init, P-1, F202, F288, F292]
topics: [roadmap, plugin-contract, plugin-sdk, host-broker, plugin-manager, contribution-plane, migration]
doc_kind: roadmap
references:
  - docs/proposals/plugin-system-principles-and-v0-design.md
  - zts212653/clowder-ai#1165
  - zts212653/clowder-ai-plugins#23
---

# Clowder AI 插件系统实施路线图

本文是公共插件契约、SDK、第一方插件及其 Host 侧收敛工作的跨仓执行真相源。
Core feature 文档继续拥有各自的 Host acceptance criteria；本文件拥有跨仓顺序、
版本坐标、交付列车与基础底座完成线，避免两仓维护两套相互漂移的阶段表。

本次刷新以 2026-08-23 已核验代码为准。它取代旧版“beta.9 row closure →
逐能力 Phase 2/3 扩张”的顺序。目标不是继续增加协议行或拆出大量小 PR，
而是尽快且可验证地完成完整插件底座，再集中迁移现有能力形成产品闭环。

## 1. 目标架构与硬边界

### 1.1 基础底座完成线

一个独立 npm 插件必须能够：

1. 从 Host 配置的 catalog provider 被发现、查询和安装；
2. 通过统一 Plugin Manager 完成校验、配置、启用、禁用、更新、修复和卸载；
3. 只依赖公共 `@clowder-ai/plugin-sdk` 使用授权后的消息、事件、配置、状态、
   secrets、scheduler、MCP、service、connector 与 Console contribution；
4. 对多 feature 插件可独立启停 feature，并在拒绝或失败时只回滚该 feature、
   不泄漏注册或扰动健康 sibling；每项 SDK effect 都绑定 Host-authenticated feature
   execution lease，不能退化为共享的 plugin-level authority；
5. 在重启后恢复正确状态，并在禁用或卸载时完整撤销注册、停止执行和按声明
   保留或清理数据；
6. 第一方与第三方插件走同一 SDK、Broker、grant、trace、ledger 和生命周期路径。

达到以上六条，才算“基础底座完成”。某个 package 发布、某组 wire row ready、
Host merge 或 loopback 单测通过，都不能单独替代该完成线。

### 1.2 留在 Core 的能力

- Plugin Manager，以及 package/install/config/activation/runtime 的权威状态机；
- catalog trust policy、package digest/provenance、quarantine、授权和审计；
- 通用 scheduler、MCP、connector binding、service lifecycle、state/secret persistence；
- Host Broker、外部进程监督、domain ledger 与用户数据保留策略；
- Console contribution 的 slot registry、renderer policy 和 capability gate。

插件化的是具体业务实现，不是管理器本身。IM provider、ASR/TTS 等具体服务、
现有业务插件及其 UI contribution 进入 `clowder-ai-plugins`；通用控制面继续留在 Core。

### 1.3 Cordis 参考边界

吸收 Cordis / DeepSeek Harness 的 `Context` 注入、effect/disposer、统一生命周期、
runtime inventory、UI slot 和真实 composition test；不采用“everything is an
in-process plugin”、把 `node:vm` 当安全边界、插件持有另一插件实例或运行时状态
代替持久真相。Clowder AI 保留 Host Broker、grant、digest、外部进程隔离和 durable
ledger 这些更严格的边界。

## 2. 2026-08-23 已核验现状

### 2.1 精确坐标

| 真相源 | 精确坐标 | 已核验事实 |
|---|---|---|
| `clowder-ai-plugins` | `e60e6560fb19bc290a9c08bc4f5f1026cb085ffd` | beta.10 lifecycle、beta.11 messaging 与 Feishu Minutes/Notes 选择修复 #40 已合入。路线图 PR #38 不占实施预算；开放的 Personal Chrome candidate #39 是既有独立候选，不属于 Train B/C 基础闭环关键路径。 |
| `@clowder-ai/plugin-contract` | `next = 0.1.0-beta.11` | 13 条 handshake、messaging、lifecycle、events wire row 全部 `ready:true`。 |
| `@clowder-ai/plugin-sdk` | `next = 0.1.0-beta.7` | 已有 stdio runtime、handshake、dispatch classifier 与 `events.publish` helper；尚不是完整插件作者 SDK。 |
| `@clowder-ai/feishu-meeting-intake` | `next = 0.1.0-alpha.7` | exact coordinate 的 package 与 manifest 均为 alpha.7；已有真实独立 npm/stdio 插件、owner auth、事件输入与 Feishu Minutes/Notes 选择修复 #40，仍需作为基础底座的真实 dogfood。 |
| Clowder AI upstream | `bc9ff2d395a8522a4e5cc93fd317b65cdd9ea1bc` | F202 local manager、K-2 Host runtime、官方 catalog/install/update/lifecycle API 与 Settings UI 已存在；M0 分支已 rebase 到该当前目标基线。 |
| M0 Host Core PR | [`zts212653/clowder-ai#1380`](https://github.com/zts212653/clowder-ai/pull/1380) · HEAD `7bac631569f9607f248f5ff01ad3b79b00ffcd0d` | beta.11 Host messaging、durable snapshot paging 与 stdio delivery 已实现。跨家族 review 已 APPROVE；maintainer 对旧 HEAD `81d32be5...` 提出的 bounded snapshot capture、historical scalar admission 和 `Refs #1165` 三项 finding 均保留在 rebased HEAD。11 个 M0 commit 全部 1:1 映射；focused 307/307、isolated Redis 44/44，真实 upstream/main + Python 3.11 的完整 public gate（build、tsc、tests、lint、check）通过。exact HEAD 的 5 项远端 CI 已全绿且 PR 为 MERGEABLE；旧 HEAD 的 CHANGES_REQUESTED 尚无 current-head verdict，maintainer review 已重新请求。canonical 18-case 与 Feishu 联合验收尚未运行。 |

`latest` dist-tag 仍落后 `next`；当前属于 prerelease 交付车道，不宣称兼容性冻结。

### 2.2 成熟度判断

| 层面 | 当前判断 | 主要缺口 |
|---|---|---|
| Contract / trust | 高 | stable compatibility 与完整产品验收。 |
| Host runtime | 中高 | M0 Core PR #1380 已完成当前 upstream rebase、review finding continuity 与完整门禁；exact HEAD 的 5 项 CI 已全绿且 PR 为 MERGEABLE，当前只等待 maintainer exact-HEAD 复审，随后完成生命周期/消息联合验收。 |
| Core Plugin Manager / catalog | 中 | 当前本地插件、官方外部插件、IM connector 仍有平行控制面；catalog 只有窄官方策略。 |
| Public Plugin SDK | 低中 | 缺统一的 plugin lifecycle / Host-issued `FeatureContext` 分层与绝大多数领域 facade。 |
| Contribution / Console | 低 | typed contribution、slot runtime 和 disposer 未闭合。 |
| 存量迁移 | 低 | Feishu 是真实先例；IM、具体服务和现有插件尚未统一迁移。 |

按用户可完成的端到端旅程而不是代码量估算，整体约为 **45%–50%**。
该比例只用于解释路线，不作为关闭 feature 的指标。

## 3. 执行规则与 PR 预算

1. **契约只有一个机器真相源。** Host 与 SDK 精确消费发布的
   `@clowder-ai/plugin-contract`，Core 不得恢复 wire/schema mirror。
2. **交付按纵切列车，不按接口拆 PR。** lifecycle、messaging、MCP、scheduler、
   service 或 UI contribution 都不是各开一串 PR 的理由。
3. **剩余基础闭环默认五个聚合 PR。** 每个 PR 内用小提交、TDD、按域测试矩阵和
   review 修订保证可审查性；review finding 继续修在原 PR。
4. **只有边界而非规模允许拆分。** 新信任边界、不可逆 registry/数据迁移，或确实
   无法在一个 review 单元内安全证明的状态机，才允许突破预算。
5. **双仓以 release train 协调。** Plugins 侧先发布精确 package，Core 在同一列车
   的聚合 PR 中 pin 一次；最终用两个 exact SHA 做联合验收。
6. **先验证 surface，再做 production cutover。** Train B 必须用真实消费者的隔离
   acceptance slice 验证 SDK/adapter/UI surface，但不得切换默认生产路径或删除旧实现；
   production data migration、默认路径切换与旧路径删除只在 Train C 发生。Train C 完成前
   不开始 foreground cat、memory、windows 等新插件化能力。

受保护分支强制产生的路线图文档 PR #38 是一次治理落盘，不计入上述五个实施 PR；
后续进度只在该路线图或对应实施 PR 内更新，不再为状态同步新开 PR。

### 3.1 列车状态门与不可绕过不变量

| 状态门 | 进入条件 | 必须提交的证据 | 退出条件 | 不能替代完成的证据 |
|---|---|---|---|---|
| Train A / M0 | beta.11 contract 与 Plugins runtime 已发布 | exact Host/Plugins SHA、完整 fail-closed matrix、18-case、真实 Feishu dogfood | Host runtime 与公开 SDK 消息入口在同一授权路径闭合 | 单仓单测、单个 loopback 或 CI 绿灯 |
| Train B / foundation | Train A 完成，§5.1 的 v0 surface 集合冻结 | product-neutral conformance fixture **加** §5.3 真实消费者矩阵；Plugins/Core exact SHA 联合验收 | 每个公开 surface 同时有通用机制证据和至少一个真实消费者证据，完整生命周期旅程通过 | 类型存在、通用 fixture 独跑、只覆盖部分 surface |
| Train C / migration | Train B 完成；§6.3 inventory 在两个聚合 PR 的 merge base 上冻结 | 每个 inventory entry 的 package、数据 mapping、rollback、composition、cutover 与旧路径清理证据 | inventory 中每个 entry 均为 `migrated` 或经 maintainer 明确批准的 `excluded`，且无双跑/第二管理入口 | “至少一个”样例迁移、包已发布但 Core 仍保留业务实现 |
| post-closure expansion | Train C 完成 | 新能力自己的真实消费者、权限与数据形状审查 | 对应纵切独立验收 | 旧 M1 排期或未实现设计稿 |

以下不变量横跨所有列车：

- **INV-R1 — surface 双证据：** 任何公开 v0 surface 都不能只靠 schema/type 或
  product-neutral fixture 冻结，必须另有真实第一方消费者在隔离 acceptance 环境通过；
- **INV-R2 — migration 全量守恒：** Train C 的完成集合严格等于冻结 inventory 的
  in-scope 集合；新增、删除或排除 entry 必须在同一 PR 中显式修订 inventory 与理由；
- **INV-R3 — 不双跑：** Train B 的 consumer slice 不成为默认生产路径，Train C cutover
  后旧新实现不得同时消费事件、执行 schedule 或写用户状态；
- **INV-R4 — 顺序单一真相：** 本路线图拥有跨仓执行顺序；governing design 拥有架构
  原则和验收语义。`plugin-system-principles-and-v0-design.md` §2.2/§3.8 已同步本次
  operator 改序，不再保留与本路线图冲突的 M1 并行排期。
- **INV-R5 — v0 边界闭合：** Train B 当前公开 surface 仅为 lifecycle/effect、
  feature activation、messaging/events、config/state/secrets、scheduler/MCP、
  services/connectors 与 UI contribution；memory/thread/hook/windows 不得从 governing
  design 的未来约束反向漏入 contract、SDK 或完成矩阵。messaging 的 opaque
  `ThreadHandle` 不等于开放 thread create/list/read 域。
- **INV-R6 — 坐标与门禁事实一致：** Train A 的 acceptance 指令、状态表与依赖图中
  复制的 Host/Plugins SHA 必须等于 §2.1 精确坐标；CI、mergeability 与 review 等外部
  门禁每次刷新必须全文件同批更新，已满足的 gate 不得继续出现在等待项中。
- **INV-R7 — feature authority 不可伪造：** feature activation 不是 UI/状态标签。每个
  effect-bearing SDK context 必须由 Host-issued lease 绑定
  `pluginInstanceId + featureId + packageRevision + activationRevision + grants`；插件自报
  identity 不能选择授权主体，lease 撤销后 sibling 存活也不能让旧 context 继续产生副作用。

## 4. Train A — M0 Runtime 收口（剩余 PR 1/5）

Plugins 侧 beta.11 已合入，本列车只剩一个 Core Host PR。当前分支不再扩 SDK、
marketplace 或 Console scope。

### 必须完成

1. ✅ M0 Host candidate 已 rebase 到 upstream `bc9ff2d3...`；review finding continuity
   核验后的 PR HEAD 为 `7bac631569f9607f248f5ff01ad3b79b00ffcd0d`；
2. ✅ 分支 build、TypeScript、focused 307/307、isolated Redis 44/44、完整 public tests、
   Web lint 与真实 upstream 基线 check 已闭合；完整门禁使用仓库支持的 Python 3.11
   通过。exact HEAD 的 5 项远端 CI 已全绿且 PR 为 MERGEABLE；
3. ✅ 非作者跨家族 reviewer 已覆盖授权、durable cursor、Redis 原子性、stdio
   correlation、deadline、crash/recovery 与默认安全 composition；4 个 P2 已修复并复审通过；
   maintainer 的 2 个 P1 与 1 个 P2 也已在原 PR 修复并跨 rebase 保留，等待 maintainer
   对 exact HEAD `7bac631569f9607f248f5ff01ad3b79b00ffcd0d` 复审；
4. ✅ 单一 upstream Core PR
   [`#1380`](https://github.com/zts212653/clowder-ai/pull/1380) 已创建并登记
   CI、conflict 与 maintainer review 跟踪；
5. 冻结 reviewed Host SHA 与 §2.1 当前 Plugins exact SHA
   `e60e6560fb19bc290a9c08bc4f5f1026cb085ffd`，运行 canonical 18-case
   Host ↔ compiled standalone plugin 联合验收；
6. 用真实 Feishu plugin 证明 install/enable/start/publish/disable/restart 不绕过
   Broker、inventory 与 domain settlement。

### 完成线

- 全部 18 个 canonical vector 通过；
- `plugin-system-principles-and-v0-design.md` §3.8 的 Host+SDK fail-closed
  对抗矩阵必须逐项完整通过；18 个 canonical vector 或下列摘要都不能替代该全集；
- 全集必须覆盖 actor/system audience/whisper target 伪造、裸或越权 thread 寻址、
  namespace escape、provenance 升级、denied grant、重复
  idempotencyKey/operationId、deadline expiry、callback retry/dead-letter、断线后
  cursor 续投与 ack 前崩溃重投、retention 越界 stale 追平、卸载后
  retained/ask-on-uninstall durable state 保留，以及 plugin crash isolation；
- 事件输入面四项断言必须全部通过：拒绝 undeclared/forbidden-class signal，拒绝
  producer 伪造与 observation→user_intent 认识论升级，拒绝插件自报 wake route
  target，并在 lease 过期后正确判定 offline；
- malformed、unauthorized、oversize、stale、cross-instance/subscription、deadline、
  crash、drain 和 restart/reconcile 均 fail closed；
- P14 成立：第一方与第三方走同一公开 SDK 入口和同一授权流；仅共享下游
  runtime/grant 路径不足以通过该门禁；
- M0 关闭不附带新的 SDK/UI/迁移欠账声明。

## 5. Train B — 完整基础底座（剩余 PR 2–3/5）

Train B 是 M0 后唯一关键路径，由一个 Plugins 聚合 PR 和一个 Core 聚合 PR 组成。
实现可以按领域提交，但不得把每个 facade、adapter 或 contribution point 拆成 PR。

### 5.1 Plugins 聚合 PR：公共 SDK 与 Contribution Contract（PR 2/5）

- `definePlugin(...)`、无 effect authority 的 plugin lifecycle context，以及只由 Host
  activation callback 注入的类型化 `FeatureContext`；
- `activate` / `deactivate` / `dispose` 生命周期，以及注册即返回 disposer 的
  `featureCtx.effect(...)`；
- `features[{id, resources, capabilities}]` 的机器契约，以及逐 feature、revision-fenced
  activation/settlement 与 opaque feature execution lease；插件总闸与 feature
  desired/current state 正交，插件不能用自报 `featureId` 构造或切换 context；
- `featureCtx.messaging`、`featureCtx.events`、`featureCtx.config`、`featureCtx.state`、
  `featureCtx.secrets`；
- `featureCtx.scheduler.register(...)`、`featureCtx.mcp.register(...)`；
- `featureCtx.services`、`featureCtx.connectors`、`featureCtx.ui` contribution API；
- typed manifest contribution schemas、generated types、conformance fixtures；
- create-plugin template、API reference、升级兼容规则和真实 composition fixture。

Hook 继续 future-reserved，不进入 v0 contract、SDK 或 Train B 完成线。只有 M1 出现
无法由事件订阅与 `appendElements` 覆盖的真实同步消费者后，才按 governing design
P5 逐点定义数据形状、隔离、授权、超时与重试语义。

所有 effect-bearing 公开 API 必须从 `FeatureContext` 取得 Host-issued lease，并证明：
grant 拒绝零副作用、重复注册可判定、dispose 后注册项消失、重连/重启后旧 lease 失效、
插件不能自报 Host/feature identity 或持有另一插件实例。多 feature 共享进程不得接收
plugin-wide secret 注入；feature secret 只经 lease-scoped API 读取，需要进程环境凭据时
必须使用独立 runtime。

### 5.2 Core 聚合 PR：统一 Manager、Adapters、Marketplace 与 Console（PR 3/5）

在现有 F202、official catalog、external lifecycle 和 Settings 上收敛，不另建平行系统：

- Plugin Manager 统一 package、package integrity、config、activation、runtime 正交状态；
- Manager 持久化逐 `pluginInstanceId + featureId + packageRevision` 的 desired/current
  activation，拒绝 stale completion；feature 失败只回滚本次资源，不能扰动 sibling；
- package update 保留 plugin 总闸 desired，并只将新旧 manifest 中**存续 feature ID** 的
  desired activation 投影到新 package revision；plugin/feature current 必须按新 grants/config
  重算。新增 ID 默认 disabled，删除 ID 不产生新 revision state/lease，改 ID 视为删除+新增；
  显示名变化必须保留稳定 ID。失败发生在切换边界前且旧 lease/runtime 从未撤销时，保留
  原 v1 desired/current 与 activation revision；切换边界后只恢复完整 v1 desired 投影，
  并由全新的 rollback activation revision 重新 reconcile current。不得恢复或复用已撤销的
  current/revision，也不得从部分 v2 reconcile 反推用户选择；
- Broker/Manager 签发、轮换和撤销 feature execution lease；每次 SDK call、registration、
  event/callback delivery 与 secret/state access 都从 Host ledger 解析 feature 主体并复核
  plugin/feature activation、package integrity 恰为 `verified`、Host-monotonic
  `integrityEpoch`、revision 与 grants，不接受
  payload 自报 identity；
- 本地插件、官方 npm 插件与后续 community package 共享生命周期投影；
- `.env` 只选择 catalog provider/索引位置；Host 继续验证允许的 origin、版本、
  digest、provenance、trust tier 与 quarantine，配置来源不能自动变成信任来源；
- `clowder-ai-plugins` 发布机器可读 catalog index，支持查询、详情、版本和兼容性；
- Console 与 Agent 使用同一组 revision-fenced、带授权和审计的管理 API；
- resource adapters 将 SDK contribution 接入现有 scheduler/MCP/service/connector；
- Console 提供逐 feature 启停与声明式 slot/command/settings/message-element
  contribution；挂载与销毁同时受 plugin、feature lifecycle 和 grant 约束；v0 不执行
  不受信任的任意 DOM/React 代码；
- install/update/repair/uninstall 与 retained/ask-on-uninstall 数据策略经过 crash、并发、
  stale revision、rollback 和 restart 对抗测试。
- config、secrets 与 namespaced state 作为 Host 内建 store 单独持有 disposition：uninstall
  先撤销 authority 并移除 package/runtime，config/state 默认进入不可被 runtime 访问、TTL=0
  且 Settings 可见的 detached Host-owned record；secrets 必须由用户明确选择保留或清除，
  非交互调用缺少选择时 fail closed。fresh install 为空；disable/restart/reconnect 保全全部
  store 并只轮换 authority；删除不是 dataset policy 的隐式副作用；
- reinstall 创建 fresh pluginInstanceId 与全新 lease/cursor/ledger。仅相同
  `pluginId + publisher identity + origin` 且用户显式恢复时，旧内建 store 与 detached
  datasets 才经新 schema migration 原子绑定；失败保留 detached snapshot 并让新实例保持
  未配置、disabled；只有至少一项 durable store record 或 dataset inventory entry 实际绑定的
  positive-yield restore 才能提交 fresh instance。成功但只接纳部分 entry 时，source snapshot
  的非空 residual root 必须在同一 commit 以 Host-issued
  `restoreCarryOwnerPluginInstanceId` 独占绑定 fresh instance，不再作为独立 top-level
  generation 可选且仍不可被 runtime 读取。若 built-in stores 已清且所有剩余 dataset 都不兼容
  或未选择，zero-yield 必须以 `no_compatible_restore_input` 在 instance/package activation 与
  carry commit 前终止，package 保持 absent、source snapshot 保持 top-level selectable；
- 每个 manifest dataset 使用 stable datasetId。Host 为每个 durable detach generation 签发
  `detachedBundleId`；bundle 标注 `bundleKind: update-holding | uninstall-snapshot`，entry 保留首次
  `sourceOperation: uninstall | update` 及原始 dataClass/policy/schemaVersion/contentDigest。update
  不执行卸载策略，而把 v2 移除、改 ID 或无法兼容接纳的旧 dataset 原子放入 update-holding。
  later uninstall 必须枚举同 pluginInstanceId 的全部 standalone update-holding entries，以及该
  instance 至多一个 **carried source snapshot A**。按原 policy 处置本代 attached/U 后，将非空 U 与
  carried A 作为 immutable children link 到唯一新 uninstall snapshot B，并原子写去重的
  `absorbedDetachedBundleIds` / `absorbedByDetachedBundleId`、清除 A carry owner；不得吸收其他
  unrelated instance 的历史 uninstall generation。A 的既有 descendants 原样递归可达，entry 保留首次
  bundle 的 exact key，Settings 在 B 下递归展示/精确 clear。重装只接纳用户显式选择的单一
  top-level recursive logical closure 中同 ID、声明兼容且 migration 成功的 dataset；同一 closure
  有多个同 ID entry 时，候选全集必须覆盖 root direct 与任意深度 descendants，并以
  `(entry.detachedBundleId, datasetId)` 为 exact candidate key。用户显式选至多一个 eligible candidate，
  未选则该 ID 不恢复，Host 不得偏向 direct/child 或猜“最新”。candidate list 只从 committed
  inventory/lineage 与 verified manifest/migration plan 投影；restore journal 冻结 A、inventory revision、
  verified package revision 与 exact keys，和 clear 串行；stale/foreign/ineligible/duplicate selection 或
  package revision 漂移在消费任何 entry 前 fail closed；graph 必须无环、child 单父，Host 以
  inventory 大小为界迭代遍历，不能靠递归调用栈；
- Host 控制面提供 config/secrets/state 的逐 store explicit clear。已安装实例 clear 前撤销
  相关 lease，journal 原子删除后用新 activation revision reconcile；detached record 也能从
  Settings 清除，插件 callback 无权触发，crash/failure 回滚且审计 ledger 保留。

repair 不是“再跑一次 install”的旁路。它只由 Plugin Manager 在同一
`pluginInstanceId` operation revision 下推进，并与 install/update/uninstall/第二个 repair
串行化；generic restore、catalog refresh 或 plugin callback 不得直接把 integrity 标成
`verified`，也不得复活旧 feature lease：

| 当前 package / integrity / operation | 事件 | 成功终态 | 失败或 crash 终态 |
|---|---|---|---|
| `installed / verified / idle\|updating\|repairing`，零个或多个 current runtime/lease | verifier 以 `treeRole=active` 报告已安装 active tree 的 digest、provenance 或 trust mismatch | 抢占并中止当前 operation、丢弃未提交 staging；同一 durable transaction 写 `damaged`、撤销整包 lease、停止新 delivery、使 current fail closed，并 quarantine active `integrityEpoch` 的全部未结算 settlement token，再停止或 quarantine runtime；desired 与用户数据不变 | containment 没有 permissive rollback：即使 operation/disposer/stop 失败也保持 authority、delivery 与 settlement trust revoked，journal 重试停止/隔离并收敛到 `installed / damaged / idle` |
| `installed / verified / uninstalling` | active tree mismatch；uninstall 已先撤销 authority | 将 damage evidence 与 integrityEpoch/token quarantine 合入 uninstall journal并继续用户请求的删除 | uninstall 失败或 rollback 只能回到 `installed / damaged / idle` 且无 authority，不能恢复旧 runtime |
| `installed / verified / updating\|repairing`，active tree evidence 仍 verified | verifier 以 `treeRole=staging candidate` 报告候选 mismatch | 只拒绝候选并中止所属 staging transaction；不得误标 damaged 或 quarantine active integrityEpoch，按既有 cutover boundary 保留 runtime 或用同一可信 active tree 的新 revision reconcile | 不得让失败候选获得 lease/settlement authority，也不得把 candidate failure 伪装成 active-tree incident |
| `staged / unknown / installing`，没有 active tree | staging candidate mismatch | 拒绝安装、丢弃 staging，回到 `absent / unknown / idle` | 保持零 runtime/lease/settlement authority，不留下半安装 inventory |
| `installed / damaged / idle`，已无 runtime authority | 用户或诊断请求 repair；catalog、版本、digest 与 trust policy 仍有效 | staging 中重取同一选定版本，验证后原子替换 package tree；`installed / verified / idle`，保留 config/secrets/state 与每个声明数据集（`lifecycle`、`retained`、`ask-on-uninstall`），不执行任何 uninstall 处置，并按 desired state 用新 activation revision reconcile | 丢弃 staging 并保持 `installed / damaged / idle`、全部旧 lease/context revoked、delivery stopped、current fail closed；不得恢复损坏 tree 的 runtime，也不删除或改写任何声明数据集 |
| `installed / verified / idle` | 显式 repair | 幂等复验；内容相同则 inventory、config/secrets/state 与全部声明数据集零变化，需重建 runtime 时仍撤销旧 lease 后用新 revision reconcile | 仍保持最后一个 verified tree；失败不得降级或改写用户数据，也不得按卸载策略处置数据集 |
| 任意 `/ repairing` | restart/crash recovery | Manager 根据 durable transaction journal 收敛到一次完整 atomic swap 与一次 reconcile | 回滚 staging 并回到上述可判定失败态；若 journal 记录 integrity damage，必须先重放 revoke/delivery stop/runtime quarantine containment，始终不得暴露 old/new tree 或旧 authority |
| 任意非 `idle` | 并发 install/update/uninstall/repair | 拒绝或排队到当前 operation 终态，不改变 revision；**active-tree integrity evidence 不走此队列，必须按首行抢占** | 不允许双写 inventory、重复注册或交错删除数据 |

update 也必须是同一 Manager 拥有的版本化事务，而不是“覆盖 package 后再尝试迁移”。
Train B fixture 必须提供 v1/v2 两个真实 package artifact：v1 预先写入 versioned config/state、
secrets 与三种处置策略的数据集，v2 声明 config/state migration。Host 先 staging 新 tree、
migration output 与 v1/v2 dataset binding disposition；成功时 package/inventory、迁移数据、
attached binding、完整 update-sourced detached bundle 和新 activation revision 原子切换，
旧 runtime 先退出且永不与新 runtime 双跑。切换边界前的 migration/crash 失败若尚未撤销旧
lease，必须丢弃 staging 并保持原 v1 runtime/revision；切换边界后旧 lease 已撤销或 runtime
已退出的失败，则恢复 v1 tree/data/desired projection，但必须签发全新的 rollback activation
revision 重新 reconcile，不能把已 revoked 的 v1 current/revision 改回 active。后一分支中旧
v1 context 与失败 v2 attempt context 均继续 fail closed；secrets 与所有旧 dataset 字节守恒，
update 不得执行 `lifecycle`、`retained` 或 `ask-on-uninstall` 的卸载处置。相同 stable datasetId
且声明兼容、migration 成功的内容绑定到 v2；removed datasetId、stable ID 变更或不兼容声明的
旧内容必须按原 metadata 建入 update-sourced inventory，v2 新/替代 dataset 从空开始。runtime
cannot read detached 内容，Settings lists the update-sourced bundle 并提供精确 clear；这些
update-holding 内容不能被 runtime、后续 package 或 reinstall 自动认领。任一失败恢复完整 v1 binding，且不得留下
orphan、partial or duplicate detached bundle；后续 uninstall 按原 policy 处置这些条目，把非空 U、
该 instance 的内建 stores/current datasets，以及上次部分恢复 carry 给该 instance 的 source root
原子 link 成一个新的 top-level uninstall snapshot recursive closure，不能留下 split lineage。
v1/v2 manifest 还必须覆盖 plugin 总闸 desired、enabled 与 disabled 的存续 ID、一个新增 ID、
一个删除 ID、稳定 ID 下的显示名变更，以及一次 ID 变更。只有存续 ID 继承 desired；新增与
改 ID 后的 feature 默认 disabled，删除 ID 不得残留 v2 current/lease/resource；current 只按
v2 grants/config reconcile，新增 grant 未获批时不能因旧 desired 自动扩权。任一 update
失败必须恢复完整 v1 plugin/feature desired 选择；current 只能保留未被撤销的切换前投影，
或在撤销发生后由新的 rollback activation revision reconcile 生成。

### Train B 完成线

一个不含产品特判的 fixture npm 插件必须能从 catalog 安装，并只使用公共 SDK
逐项执行 §5.1 承诺的全部 v0 surface：lifecycle/effect、feature activation、messaging/events、
config/state/secrets、scheduler/MCP、services/connectors 与 UI contribution。
验收既覆盖适用的 register/dispose，也覆盖 read/write/call/delivery 语义；类型存在或
只验证其中几类不能通过。插件经历配置、启用、重启、注入 package 损坏、修复、禁用、
更新、卸载后，Host
inventory、逐 feature desired/current state、注册表、UI 和 retained data 必须全部一致。
损坏注入本身必须在 repair 请求之前触发 governing design INV-FA4/FA5：同一 durable transition
将 integrity 置为 `damaged`、撤销整包全部 feature lease、停止新 event/callback delivery、
使 current fail closed、quarantine active integrityEpoch 的全部未结算 settlement token，并在
repair 开始前停止或 quarantine runtime。fixture 还必须分别在 update staging 与 verified
explicit repair staging 期间向 **active tree** 注入损坏，证明 evidence 抢占当前 operation、
丢弃 staging 且不能等 operation 完成；另向 **staging candidate** 单独注入 mismatch，证明只
中止候选、不误伤仍 verified 的 active tree/epoch。保存的每个 feature
旧 context 都要对 messaging/events、scheduler/MCP、service/connector、UI registration
以及 config/state/secret 访问逐类失败；repair 失败、stop 失败与 crash/restart 均不得重开 authority，只有 replacement
tree 完整验证并原子替换后才能用全新 activation revision 按 desired reconcile。
首次写入 config/secrets/state 后的 disable、restart 与 reconnect 必须逐字节保全三个 store，
同时证明旧 lease 已失效；fresh install 未显式恢复 detached record 时三个 store 必须为空。
repair 必须验证同版本内容重新 stage/verify/atomic swap，config/secrets/state 与
每个声明数据集（`lifecycle`、`retained`、`ask-on-uninstall`）不被覆盖或删除，desired state
保留，current runtime 只用新 activation revision 恢复且注册恰好一次；旧 context 继续
fail closed。fixture 必须分别声明并写入三种处置策略的数据集，在成功 repair、repair 中途
crash/restart 与无可用 rollback tree 的失败态逐一断言内容守恒；随后单独执行 uninstall，
验证只有该操作才会清除 `lifecycle`、保留 `retained`，并按用户选择处置
`ask-on-uninstall`。还必须覆盖 repair 与 update/uninstall 并发，证明不会出现半替换 package、
双份 runtime 或 repair 路径误触发数据处置。
fixture 还必须执行一条 **uninstall/reinstall/explicit-clear journey**：第一次卸载选择保留
secrets 与 `ask-on-uninstall` dataset，证明 config/state 默认进入 detached record、`retained`
和被选择保留的数据连同 Host-issued `detachedBundleId A`、stable datasetId/dataClass/policy/
schemaVersion/contentDigest 进入 detached dataset inventory、`lifecycle` 被删除，且这些内容
均不能再被旧 context 或任意 runtime 读取。随后不恢复 A 地重装，写入可区分的第二代 store/
dataset 内容并再次选择保留卸载，产生相同 plugin/publisher/origin 与 stable datasetId、但具有
`detachedBundleId B` 的第二代 detached snapshot；Settings 必须按 generation 列出并逐项管理
A/B。再次以相同 verified `pluginId + publisher identity + origin` 重装时，断言获得 fresh
pluginInstanceId、旧 lease/cursor/幂等与结算账本均不复用；用户必须显式选择恰好一个
`detachedBundleId`，Host 只能把选中 generation 的 config/secrets/state 与新 manifest 中同
stable datasetId 的 `retained`/保留的 `ask-on-uninstall` 经 migration 作为一个 bundle 原子
绑定，禁止把 A/B 跨代拼接或隐式选择“最新”。未选 generation 继续 top-level detached；选中
root 中未被新 manifest 接纳的条目仍留原 recursive closure，并在至少一项 durable record
已绑定的 positive-yield commit 原子 carry-bound 给 fresh instance，不得继续作为另一个
top-level generation 可选。fresh context 激活后必须验证 **post-reinstall readability**
与所选 generation 的迁移输出，旧 context 仍 fail closed；新增/`lifecycle` dataset 为空，
已删除 ID 继续 detached 且不可被 runtime 认领。
用不同 signer/origin、伪造 datasetId 或不兼容声明认领必须拒绝，任一 built-in store/dataset
migration 失败必须保留全部 detached snapshot 并让新实例保持未配置、disabled，不能部分恢复。
这条 **retained/ask-on-uninstall reattach journey** 还要分别覆盖卸载时选择清除 secrets/
`ask-on-uninstall`，以及已安装和 detached 状态下逐项 clear config/secrets/state 与 detached
dataset；detached clear 必须用 `detachedBundleId + store kind/datasetId` 命中指定 generation，
并证明同 stable datasetId 的另一代不受影响。还要断言 clear 前 authority 已撤销、readiness/
credential/namespace/inventory 投影正确、新 activation revision reconcile、crash 回滚且
audit/transaction ledger 不被数据清除连带抹除。

fixture 还必须执行一条 **zero-yield restore journey**：先显式清除 source snapshot A 的全部
built-in stores，使 A 只剩当版 verified manifest 不兼容或用户未选择的 datasets。提交恢复 A 时，
restore journal 可以完成候选枚举与 staging 检查，但在 commit gate 必须得到零条 durable record
binding，并返回 typed `no_compatible_restore_input`；不得提交 package/fresh instance、不得写
`restoreCarryOwnerPluginInstanceId`、不得消费 entry 或改变 A 的 lineage/inventory revision，终态仍是
`absent + top-level selectable A`。随后换用能兼容并迁移其中一项 dataset 的 verified package 重试，
必须直接从同一个 A 成功产生 positive-yield restore，无需先卸载任何空实例。在 yield 计算、instance
commit 与 carry commit 前后注入 crash/retry，均只能观察到完整 unchanged A，或至少绑定一项且 residual
原子 carry-bound 的完整 fresh instance；禁止 zero-yield instance、隐藏 A、空 carry 或重复消费。
fixture 还必须执行一条**两版本 update 旅程**：从已填充 config、secrets、state 与三类数据集
的 v1 更新到带 config/state schema migration 的 v2。v1/v2 dataset fixture 必须同时包含一个
同 stable ID 且 migration 成功的存续 dataset、一个 removed datasetId、一次 stable ID 变更、
一个 dataClass/policy/schema 不兼容且不能迁移的 dataset，以及一个新增 datasetId；断言存续内容
绑定到 v2、新增/替代内容为空，其余旧字节只进入同一完整的 update-sourced detached bundle，
runtime cannot read detached，Settings lists the update-sourced bundle 且能按
`detachedBundleId + datasetId` 精确 clear。还须证明没有用户显式选择就不能恢复/认领 detached
内容，后续 uninstall 按旧 metadata 的原 policy 处置 update-detached 条目。

成功 update 后继续执行 lineage journey：被移除的 dataset 先进入 **update-holding bundle U**，
Settings 可列出并精确 clear，但 runtime/reinstall 均不可读或选取 U。随后卸载同一 instance，保留
stores、`retained` 与用户选择保留的 `ask-on-uninstall`，生成唯一 **uninstall snapshot A**；断言
A 的 `absorbedDetachedBundleIds` 含 U、U 的 `absorbedByDetachedBundleId` 指向 A，U 不再 standalone
可选但 entry key/provenance 不变，而其他 pluginInstanceId 的历史 snapshots 不变。用相同 identity
重装并显式选择 A recursive logical closure，必须满足
**A restores both built-in stores and the update-detached dataset**（这是 positive-yield；后者仍须
stable ID/声明兼容且 migration 成功），不允许额外选择 U 或 arbitrary bundle-set；同一 closure 分别注入两个同 stable ID 的
descendant entries，以及一个同 ID 的 A direct entry 与 descendant entry。断言 Settings 用
`(entry.detachedBundleId, datasetId)` 展示完整候选集，未显式选择时该 ID 默认不恢复；分别选择 direct
与任意 depth descendant 时只把被选的可区分内容送入 migration staging，另一项保持原 key/lineage detached，不得隐式
偏向“当前”或“历史”内容。再提交属于另一个 top-level snapshot 的 foreign key、已被 concurrent clear
移除的 stale key、ineligible key 与同 ID 双选，并在选择后替换 verified package revision，断言 restore
在消费任何 entry 前 fail closed；clear/restore 按 inventory revision 串行，crash/retry 复用 journal 中
同一 package revision/选择且不产生第二份 selector state。分别在 policy census、link edge、
A commit 前后注入 crash/restart：只允许“installed + 完整 standalone U、无 A”或“absent + 完整 A
closure、无 standalone U”，重试复用同一 A 且无重复/多父/环；验收必须断言 **no split lineage**。
再分别通过 restore 与 explicit clear 排空一个 descendant leaf，断言 leaf metadata 与双向 parent edge 在
同一 commit 删除且其他 branch 不变；从 leaf 向 root 级联清理空节点，root direct records/children 全空后
才删除 root/carry owner，任一 crash 不得留下 dangling edge。

紧接着执行一条 **partial-restore continuity journey**：令 source snapshot A 同时包含可接纳的 built-in
stores/dataset X 与当版 manifest 不兼容的 dataset Y。恢复 A 到 fresh instance I2 时，只允许 stores/X
原子绑定；residual A 必须在同一 commit 写 `restoreCarryOwnerPluginInstanceId=I2`，从 top-level selectable
转成 installed-carried，Settings 仍可递归查看/精确 clear，I2 runtime 仍不可读取 Y。随后让 I2 产生可区分
的最新 stores/X 与一个 update-holding U2，再卸载 I2：Host 必须生成唯一 top-level snapshot B，把本代保留
内容写成 B direct，并把 U2 与 **carried source snapshot A** 原子 link 为 B children、清 A carry owner；
A 的既有 descendants、entry exact keys 与 provenance 原样保留。即使本代没有其他保留内容，只要 A residual
非空也必须生成 B，不能把 A 留成 sibling top-level。下一次 manifest 已能迁移 Y 时，用户只选择 B 就必须
同时枚举 B 的最新 stores/X、U2 与 A subtree 的 Y，禁止再单独选择 A 或临时拼 bundle-set。
在 restore 绑定 selected entries/carry owner、uninstall 创建 B/link A/clear carry owner 的各 commit 边界注入
crash/restart，只允许“absent + 完整 top-level A”“installed I2 + 完整 carried A、无 B”或“absent + 完整
top-level B（递归含 A）”三种终态，禁止 sibling A/B、双 carry、环、多父或 orphan entry。再重复一次
partial restore→uninstall 形成至少三层 closure，断言 Host 以 committed inventory 为界迭代遍历、每个 bundle
恰好访问一次，并从 leaf 向 root 级联清理空节点；测试不得通过限制 closure 为固定一层。该 journey 是
INV-DL10 的 multi-generation proof，不得用“选最新 snapshot”或跨 top-level 组合代替。

旅程同时断言 config/state migration 输出、未迁移数据守恒、旧 runtime 退出后才开放新 runtime。
先在 migration 中途和切换边界前注入 crash/failure，证明
未被撤销的 v1 runtime/revision 保持原样；再在旧 runtime 已退出且 lease 已 revoked、但 v2
尚未可见时注入失败，证明 package tree、inventory、全部数据 snapshot 与 desired 选择恢复为
v1，却由全新的 rollback activation revision reconcile，绝不复用旧 v1 或失败 v2 revision。
保存的旧 v1 context 与失败 v2 attempt context 必须全部 fail closed，restart reconcile 后也不
存在 old/new 双 runtime；每个 crash point 只能观察到完整 v1 binding，或完整 v2 binding 加完整
detached inventory，绝不能出现 orphan bytes、partial or duplicate detached bundle。只检查最终
版本号或 retained data 不能通过。
fixture 至少包含两个 feature，并证明独立启停、denied-grant 零副作用、单 feature
activation 失败隔离、plugin 总闸、restart 恢复与 stale revision 拒绝。撤销其中一个
feature 后，必须使用保存的旧 context 对 messaging/service call、registration、event
subscription/callback、state/secret access 逐类发起对抗调用并全部拒绝，同时证明健康
sibling 的 fresh context 仍可工作；仅检查资源列表消失不能通过。
同一 fixture 还必须让两个 enabled feature 分别以相同 `idempotencyKey` 发送消息与
`events.publish`、对同一 `messageId` 以相同 `operationId` append，证明 Host 从 lease 绑定
feature identity、三条路径都各自得到独立 receipt/ledger entry；两个 feature 的 subscription
cursor/ack ledger 也必须独立，任一 ack token 不得推进 sibling cursor。随后重试各自调用，
仍只能命中本 feature 原 receipt。撤权前已投递并开始执行的
职责 callback 则必须区分撤权原因：disable/grant revoke/update/reconnect 等普通撤权后，绑定
可信 `integrityEpoch` 的 Host-issued settlement token 可在 deadline 内成功落账一次，同结果
重放只返回原 settlement 且不重复落账；active-tree damage 的 durable transition 必须先
quarantine 该 epoch 的全部未结算 token，随后 success settlement 以 `integrity_untrusted`
拒绝、不得抑制 retry/dead-letter。篡改结果、跨 feature/operation 使用、过期结算与夹带新
effect 同样全部拒绝；staging candidate mismatch 不得 quarantine active-tree token。

fixture 的 activation callback 还必须实际读取声明内 config、secret 与自身 checkpoint，
并产生一笔 staged state write：同 revision 的合法 bootstrap 读取与 read-your-writes 成功，
未声明、跨 namespace 或 sibling 读取拒绝；在 lease 进入 `active` 前，普通 effect、事件和
callback delivery 全部拒绝。成功路径同时提交注册与 state write，失败/取消/revision 变化
路径同时回滚，逐项证明 INV-FA1～FA5。

### 5.3 真实消费者 acceptance matrix

通用 fixture 是必要条件但不是充分条件。Train B 还必须在隔离 acceptance 环境提交
下列真实消费者矩阵；这些 slice 可以复用/改造将于 Train C cutover 的真实包与实现，
但不得提前替换生产默认路径：

| 真实消费者 | Train B 必须验证的公开 surface |
|---|---|
| 已发布的 Feishu standalone npm plugin | catalog/install、lifecycle/effect、messaging/events、config/secrets 与重启恢复 |
| Core `github` repository-local plugin 的外部化 slice | scheduler + state，以及 schedule 的重复执行/重启恢复 |
| Core `video-analysis` 或 `video-gen` 的外部化 slice | MCP registration/call/dispose；两者最终仍都在 Train C inventory 内迁移 |
| 一个现有 IM provider 的外部化 slice | connector、messaging、binding/callback、config/secrets 与声明式 UI contribution |
| voice-suite（至少覆盖 ASR 与 TTS）外部化 slice | service、message event/cursor、`appendElements`、Console slot/message-element；分别验证“仅 ASR”“仅 TTS”“两者启用”，以及一方 denied/activation failure 不泄漏资源、不打断另一方；撤销后的旧 feature context 对调用、注册、事件、callback 与 secret 访问全部 fail closed |

矩阵中的每一行都要跑 register/use/dispose、disable/re-enable、restart 与 denied-grant；
多 feature 行还要逐 feature 跑 revision-fenced activate/deactivate、Host-issued lease
轮换/撤销、旧 context 对抗调用、失败回滚与 sibling 隔离；
§5.1 任一 surface 没有落入至少一行的真实消费者证据，Train B 不得完成。

## 6. Train C — 存量能力集中迁移（剩余 PR 4–5/5）

基础底座验收后再迁移。一个 Plugins 聚合 PR 承载业务包，一个 Core 聚合 PR 承载
数据切换、兼容窗口和旧路径清理；不为每个 provider 单独开 PR。

### 6.1 Plugins 迁移聚合 PR（PR 4/5）

- 迁移现有 IM connector 的具体 provider/adapters 与其 UI contribution；
- 迁移现有 repository-local 业务插件；
- 迁移 ASR/TTS 等具体服务定义、模型/二进制 artifact 描述和安装逻辑；
- 所有包只依赖公共 SDK，不从 Core import 私有类型、store、registry 或 service instance；
- 每个迁移包携带 config/state/secret/data mapping、rollback fixture 与真实 composition test。

### 6.2 Core cutover 聚合 PR（PR 5/5）

- 将 connector binding、通用 service lifecycle 与 scheduler 等既有 Core control plane
  接到公共 contribution adapters；
- 幂等迁移配置、binding、schedule、state 和用户可见数据；
- 旧新实现不得双跑；失败可恢复到旧路径且不丢数据；
- 删除业务特定的平行安装/启禁用 UI 和加载器，保留统一 Plugin Manager；
- Console 和 Agent 均能完成同一套安装、配置、启用、禁用、更新、修复和卸载旅程。

### 6.3 冻结迁移 inventory

Train C 的 in-scope 集合不是“挑几个代表”，而是在 Train B 完成时以两个聚合 PR 的
merge base 冻结。按 2026-08-23 已核验 Core 树，当前 census 为：

| 类别 | 必须迁移的 entry |
|---|---|
| IM providers | `dingtalk`、`feishu`、`telegram`、`wecom-agent`、`wecom-bot`、`weixin`、`xiaoyi` |
| repository-local business plugins | `github`、`video-analysis`、`video-gen`、`wechat-visible-reader`、`weixin-mp` |
| concrete managed services | `whisper-stt`、`mlx-tts`、`embedding-model`、`llm-postprocess`、`audio-capture` |

Train B/C 开发期间若上述权威目录新增 entry，Train C PR 必须把它加入 inventory，或由
maintainer 在 PR 上明确批准 `excluded` 及理由；沉默遗漏不等于排除。通用 Plugin Manager、
connector binding、service lifecycle、scheduler、MCP runtime 等 Core 控制面不是迁移
entry，仍按 §1.2 留在 Core。

### Train C 完成线

§6.3 冻结 inventory 的每个 in-scope entry 都必须从 `clowder-ai-plugins` 安装并只通过
公共 SDK 工作，或有 maintainer 明确批准的 `excluded` disposition；Core 不再包含任何
已迁移 entry 的业务实现、业务加载器或第二套管理入口。迁移账本必须逐项附 package、
数据 mapping、rollback、真实 composition、cutover 和旧路径删除证据。只有 inventory
达到 100% disposition 且没有旧新双跑，插件基础平台才形成闭环。

## 7. 闭环后的能力扩张

Train C 通过前，以下工作只保留需求输入，不进入实现关键路径：

1. foreground cat / windows / presence；
2. memory/thread 高敏能力；
3. 更多 signal producer、内容发布和 physical limb；
4. community arbitrary executable trust、network/filesystem sandbox；
5. v1 compatibility freeze。

闭环后按真实插件消费需求成组开放，不预先把所有 Core API 暴露成 SDK，也不因为
“未来可能需要”开放任意 hook 或 UI code execution。该顺序是 2026-08-23 operator
明确批准的执行改序；它取代 governing design 旧版“收编线/体验线并行、M1 不等待收编”
的排期，但不削弱 foreground-cat 将来必须遵守的 P4/P14 同 SDK、同授权与真实纵切验收。

## 8. 依赖视图

```text
已完成：G-0 + K-1 + P-1 + contract beta.11 + K-2A/B/D
                                      │
                                      ▼
Train A：M0 Host PR #1380（local reviewed，maintainer findings fixed，exact-HEAD CI green / MERGEABLE）+ maintainer exact-HEAD review + 18-case + Feishu alpha.7 dogfood
                                      │
                                      ▼
Train B：Public SDK/Contribution Contract ──exact publish──► Core Manager/Adapters/Console
                                      │
                                      ▼
Train C：IM + existing plugins + services ──► Core migration/cutover ──► 基础平台闭环
                                      │
                                      ▼
foreground cat / memory / windows / other capabilities / v1
```

## 9. 常驻分工与治理

`zts212653/clowder-ai-plugins#1` 中确认的常驻规则继续有效：

1. `mindfn` 可主导公共 contract、SDK、plugin、conformance、roadmap 及普通无人认领
   的可写 Host seam；
2. `zts212653` 保留 Host review/merge、runtime ownership、生产数据/凭据边界和
   最终跨仓验收；
3. 公共契约继续要求双 CODEOWNER，作者不得自审；
4. runtime activation、新公共语义、不可逆 registry/数据动作和开发碰撞必须回到
   maintainer review；
5. 私有源码不可访问时，公共 seam、fixture 和 executable package 先行，Core 只补
   狭窄 composition，不复制公共真相。

旧版 K-3b、GitHub、Service/UI、connector、memory 各自平行推进的 Phase 2/3 排期
自本次刷新起停止生效。GitHub repository-local schedule 实现可以继续运行，但其
外部公共 SDK 迁移不抢占 Train B/C；foreground-cat 保持后续能力扩张项。
