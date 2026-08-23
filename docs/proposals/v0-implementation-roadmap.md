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
   不泄漏注册或扰动健康 sibling；
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
| Public Plugin SDK | 低中 | 缺统一 `PluginContext` 与绝大多数领域 facade。 |
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

- `definePlugin(...)` 与类型化 `PluginContext`；
- `activate` / `deactivate` / `dispose` 生命周期，以及注册即返回 disposer 的
  `ctx.effect(...)`；
- `features[{id, resources, capabilities}]` 的机器契约，以及逐 feature、revision-fenced
  activation/settlement；插件总闸与 feature desired/current state 正交；
- `ctx.messaging`、`ctx.events`、`ctx.config`、`ctx.state`、`ctx.secrets`；
- `ctx.scheduler.register(...)`、`ctx.mcp.register(...)`；
- `ctx.services`、`ctx.connectors`、`ctx.ui` contribution API；
- typed manifest contribution schemas、generated types、conformance fixtures；
- create-plugin template、API reference、升级兼容规则和真实 composition fixture。

Hook 继续 future-reserved，不进入 v0 contract、SDK 或 Train B 完成线。只有 M1 出现
无法由事件订阅与 `appendElements` 覆盖的真实同步消费者后，才按 governing design
P5 逐点定义数据形状、隔离、授权、超时与重试语义。

所有公开注册 API 必须证明：grant 拒绝零副作用、重复注册可判定、dispose 后注册项
消失、重连/重启语义明确、插件不能自报 Host identity 或持有另一插件实例。

### 5.2 Core 聚合 PR：统一 Manager、Adapters、Marketplace 与 Console（PR 3/5）

在现有 F202、official catalog、external lifecycle 和 Settings 上收敛，不另建平行系统：

- Plugin Manager 统一 package/config/activation/runtime 正交状态；
- Manager 持久化逐 `pluginInstanceId + featureId + packageRevision` 的 desired/current
  activation，拒绝 stale completion；feature 失败只回滚本次资源，不能扰动 sibling；
- 本地插件、官方 npm 插件与后续 community package 共享生命周期投影；
- `.env` 只选择 catalog provider/索引位置；Host 继续验证允许的 origin、版本、
  digest、provenance、trust tier 与 quarantine，配置来源不能自动变成信任来源；
- `clowder-ai-plugins` 发布机器可读 catalog index，支持查询、详情、版本和兼容性；
- Console 与 Agent 使用同一组 revision-fenced、带授权和审计的管理 API；
- resource adapters 将 SDK contribution 接入现有 scheduler/MCP/service/connector；
- Console 提供逐 feature 启停与声明式 slot/command/settings/message-element
  contribution；挂载与销毁同时受 plugin、feature lifecycle 和 grant 约束；v0 不执行
  不受信任的任意 DOM/React 代码；
- install/update/uninstall 与 retained/ask-on-uninstall 数据策略经过 crash、并发、
  stale revision、rollback 和 restart 对抗测试。

### Train B 完成线

一个不含产品特判的 fixture npm 插件必须能从 catalog 安装，并只使用公共 SDK
逐项执行 §5.1 承诺的全部 v0 surface：lifecycle/effect、feature activation、messaging/events、
config/state/secrets、scheduler/MCP、services/connectors 与 UI contribution。
验收既覆盖适用的 register/dispose，也覆盖 read/write/call/delivery 语义；类型存在或
只验证其中几类不能通过。插件经历配置、启用、重启、禁用、更新、卸载后，Host
inventory、逐 feature desired/current state、注册表、UI 和 retained data 必须全部一致。
fixture 至少包含两个 feature，并证明独立启停、denied-grant 零副作用、单 feature
activation 失败隔离、plugin 总闸、restart 恢复与 stale revision 拒绝。

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
| voice-suite（至少覆盖 ASR 与 TTS）外部化 slice | service、message event/cursor、`appendElements`、Console slot/message-element；分别验证“仅 ASR”“仅 TTS”“两者启用”，以及一方 denied/activation failure 不泄漏资源、不打断另一方 |

矩阵中的每一行都要跑 register/use/dispose、disable/re-enable、restart 与 denied-grant；
多 feature 行还要逐 feature 跑 revision-fenced activate/deactivate、失败回滚与 sibling 隔离；
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
- Console 和 Agent 均能完成同一套安装、配置、启用、禁用和卸载旅程。

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
