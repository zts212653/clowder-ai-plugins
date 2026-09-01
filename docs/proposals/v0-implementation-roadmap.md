---
title: Clowder AI 插件系统实施路线图
status: 执行中 — Train A/M0 已以 Core PR #1410 的 canonical 18/18 联合验收关闭；当前进入 Train B 终态 Manager/Marketplace/Agent/YAML/catalog 底座与 video-analysis 首迁纵切
discussion: zts212653/clowder-ai-plugins#1
ack_request: https://github.com/zts212653/clowder-ai-plugins/issues/1#issuecomment-5236600431
acknowledgement: https://github.com/zts212653/clowder-ai-plugins/issues/1#issuecomment-5248175358
progress_refresh: https://github.com/zts212653/clowder-ai-plugins/pull/25#issuecomment-5261613034
created: 2026-07-14
revised: 2026-09-01
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

本次刷新以 2026-09-01 已核验代码和 operator 的终态分批为准。它取代旧版
“beta.9 row closure → 逐能力 Phase 2/3 扩张”以及“业务 factory 搬目录即插件化”的顺序。
目标不是继续增加协议行或拆出大量小 PR，而是让 Host 只保留通用 authority/control plane，
用 YAML + SDK 同一契约完成插件侧注册和业务执行，再集中迁移现有能力、狗粮和文档，最后
发布 `0.1.0` 正式版。

2026-09-01 operator 再次收窄两批终态：Train B 一次完成统一 Manager、VS Code 式
Marketplace/Settings 骨架、Agent 管理工具、机器 catalog、静态 `plugin.yaml` 接入协议与
一个真实首迁插件 `video-analysis`；该 package 只在隔离 acceptance 环境运行，不切 Core
生产默认路径。Train C 只做剩余业务插件、IM providers 与既定 managed services 的插件仓
聚合迁移，以及 Core 的单路径 cutover、旧实现/旧 IM 管理入口删除。公共 Agent 控制面固定为
`plugin_list / plugin_search / plugin_get / plugin_install / plugin_set_enabled / plugin_uninstall`；
不开放 `plugin_update`、`plugin_repair` 或 `updateAvailable`。

## 1. 目标架构与硬边界

### 1.1 基础底座完成线

一个独立 npm 插件必须能够：

1. 从插件仓发布的机器 catalog 被 `list/search/get` 确定性发现、查询并安装；
2. 通过统一 Plugin Manager 完成校验、配置、启用、禁用和卸载；安装、配置、授权、用户意图与
   runtime 健康分别投影，不能用一个 `enabled` 冒充完整状态；
3. 只依赖公共 `@clowder-ai/plugin-sdk` 使用授权后的消息、事件、配置、状态、
   secrets、identity、scheduler、direct tool/MCP、webhook、message subscription、service、
   connector 与 Console contribution；同一能力语义的静态 manifest/YAML 与动态 SDK 注册进入
   同一个 type-specific Host service，而不是抹平 `mcp/skill/limb/schedule` 的协议分类；
4. 对多 feature 插件可独立启停 feature，并在拒绝或失败时只回滚该 feature、
   不泄漏注册或扰动健康 sibling；每项 SDK effect 都绑定 Host-authenticated feature
   execution lease，不能退化为共享的 plugin-level authority；
5. 在重启后恢复正确状态，并在禁用或卸载时完整撤销注册、停止执行和按声明
   保留或清理数据；
6. 第一方与第三方插件走同一 SDK、Broker、grant、trace、ledger 和生命周期路径；
7. GitHub、IM、voice/service 等业务实现、thread routing 与外部回推都在插件侧；Host 中没有
   provider-specific factory/router/handler，Hub、兼容期 Gateway 与 SDK 消息写入共享一个
   canonical admission。
8. Console 与 Agent 只投影同一份 Host inventory：catalog 真相源属于插件仓，已安装 artifact、
   config/auth/intent/live 状态与 grants 属于本机 Host；插件或 Agent 不维护第二份 inventory。

达到以上八条，才算“基础底座完成”。某个 package 发布、某组 wire row ready、
Host merge 或 loopback 单测通过，都不能单独替代该完成线。

### 1.2 留在 Core 的能力

- Plugin Manager，以及 package/install/config/activation/runtime 的权威状态机；
- catalog trust policy、package digest/provenance、quarantine、授权和审计；
- 统一 Scheduler service、MessageIngress、IdentityRegistry，以及按能力类型分开的 MCP runtime、
  skill registry、limb control plane、direct-tool registry、HTTP ingress、connector handle/binding
  authority、service lifecycle、state/secret persistence；
- Host Broker、外部进程监督、domain ledger 与用户数据保留策略；
- Console contribution 的 slot registry、renderer policy 和 capability gate。

插件化的是具体业务实现，不是管理器本身。IM provider、GitHub poll/tracking、ASR/TTS 等
具体服务、现有业务插件及其 UI contribution 进入 `clowder-ai-plugins`；通用控制面继续留在
Core，但不能保存 GitHub/飞书/微信等业务 factory、thread 选择或平台回推逻辑。

### 1.3 能力分类、静态/动态注册与 Host 接口收敛

`plugin.yaml` 的 `type: mcp | skill | limb | schedule` 是协议层的正确能力分类。
`PluginResourceActivator` 应按 type 把资源注册到 MCP runtime、skill registry、limb control plane
或 scheduler；路线图不把这些不同安全语义的能力压成一个 type 或一个万能 `ToolRegistry`。

| 能力 | manifest/YAML 静态入口 | SDK 动态入口 | Host 只负责 | 插件负责 |
|---|---|---|---|---|
| identity | package/feature display identity | `featureCtx.identity.register(...)` | owner/lease 绑定与安全投影 | name/icon/color contribution |
| schedule | `type: schedule` + action entrypoint | `featureCtx.scheduler.register(...)` | 统一时间、持久化、重试、callback settlement | handler、业务轮询、目标 thread 决策 |
| direct tool | 无；`type: mcp/skill/limb` 属于其他能力分类 | `featureCtx.tools.register(...)` | direct-tool namespace、schema/grant、Broker callback | PR/issue tracking 等 handler；MCP/skill/limb 各走自己的子系统 |
| webhook | inbound endpoint contribution | `featureCtx.webhooks.register(...)` | plugin-instance route namespace、budget、限流、secret-reference 验签边界 | provider challenge/解析与消息转换 |
| messaging | binding/resource 声明 | `send` / `subscribe` / `read` / `ack` | canonical admission、句柄、cursor、ledger | 授权目标选择、filter/callback 与外部平台回推 |

当同一语义同时存在静态与动态入口时，两者必须归一到同一 type-specific service 的 schema、
owner lease、冲突规则、disposer 和 restart rehydration；不得出现 schedule YAML 一套 store、
schedule SDK 另一套 store。这个规则不把 MCP、skill、limb 与 direct tool 当成同义语义。
API 名称用于冻结 scope，具体函数签名由 Train B contract PR 与真实消费者共同定型。所有 owner
identity 从 Host-issued context 注入，不要求 payload 自报 `pluginId/featureId`；schedule/direct-tool/
webhook 的 handler 在 wire 上是 callback method token + serializable params，不跨进程传递任意
JS closure。

真正需要收敛的是 Host 侧以下三套同义平行实现：

| 收敛对象 | 当前平行实现 | 终态底层服务 | 保留的入口/分类 |
|---|---|---|---|
| 定时任务 | F139 `TaskRunnerV2 + DynamicTaskStore`、F202 `ScheduleFactoryRegistry`、`cat_cafe_register_scheduled_task` MCP、未来 SDK `register_schedule` | 一个 Scheduler service + store + RunLedger + lifecycle | `type: schedule`、SDK、猫 MCP 只是不同注册入口 |
| 消息写入/回推 | Hub UI 直写、`ConnectorRouter`、Plugin SDK `send_message`，以及独立 `OutboundDeliveryHook` 回推 | 一个 `MessageIngress`；出站由同一消息事件流的 subscription callback 驱动 | UI、connector plugin、普通 plugin 保留不同 source，但共享 admission/ledger/lifecycle |
| 身份标识 | `ConnectorDefinition` 硬编码展示 identity 与动态注册 | 一个 `IdentityRegistry` | manifest identity 与 SDK `register_identity` 是静态/动态入口 |

因此“同一语义 = 一个底层服务”只适用于上表；按 `plugin.yaml.type` 分发到不同能力子系统
仍是正确的 Host 行为。

消息侧同理：Hub UI、迁移期 Connector Gateway 与 Plugin SDK 都必须进入同一个 Host-owned
message admission，再由 Host 生成 actor/source、持久化、广播与唤醒。connector 插件决定使用
哪个已授权 `ThreadHandle`/`ConnectorBindingRef`，并通过 message subscription callback 回推外部
平台；Host 不知道某个 provider 的业务路由。

### 1.4 Cordis 参考边界

吸收 Cordis / DeepSeek Harness 的 `Context` 注入、effect/disposer、统一生命周期、
runtime inventory、UI slot 和真实 composition test；不采用“everything is an
in-process plugin”、把 `node:vm` 当安全边界、插件持有另一插件实例或运行时状态
代替持久真相。Clowder AI 保留 Host Broker、grant、digest、外部进程隔离和 durable
ledger 这些更严格的边界。

## 2. 2026-09-01 已核验现状

### 2.1 精确坐标

| 真相源 | 精确坐标 | 已核验事实 |
|---|---|---|
| `clowder-ai-plugins` | `d426c9168dc311183e96318bf57346eb5481b3eb` | 路线图 PR #38、M0-D execution-plane contract PR #43、Feishu 修复 #44 与既有 standalone packages 已合入。路线图 PR 不占实施预算。 |
| `@clowder-ai/plugin-contract` | `next = 0.1.0-beta.12` | execution-plane contract 已发布；registry SLSA provenance 绑定 Plugins merge `ffc638ce958e6b3ee26a0e7032da56179cb8f9fc`。 |
| `@clowder-ai/plugin-sdk` | `next = 0.1.0-beta.8` | 已有 stdio runtime、handshake、dispatch classifier 与 `events.publish` helper；Train B 在此基础上补完整插件作者 facade。 |
| `@clowder-ai/feishu-meeting-intake` | `next = 0.1.0-alpha.9` | 已有真实独立 npm/stdio package、owner auth 与事件输入；保留为既有消费者证据，不再要求它代验 Train B 全部 surface。 |
| M0 Host Core closure | [`zts212653/clowder-ai#1410`](https://github.com/zts212653/clowder-ai/pull/1410) · reviewed HEAD `413812222cb35d4e02adb7194ab3aa677d7898c7` · merge `090626a538d59e2b6ce3c3ba9b205b57d958fcdd` | canonical acceptance 以签名 `execution.method` 作为唯一 dispatch truth，真实 Host seams 达到 18/18（9 wire / 3 admission / 1 delivery / 5 Host-control）；maintainer APPROVED，公开 CI 全绿并已合入。 |

`latest` dist-tag 仍落后 `next`；当前属于 prerelease 交付车道，不宣称兼容性冻结。

### 2.2 成熟度判断

| 层面 | 当前判断 | 主要缺口 |
|---|---|---|
| Contract / trust | 高 | stable compatibility 与完整产品验收。 |
| Host runtime | 高 | M0 Core PR #1410 已完成 canonical 18/18 并合入；Train B 不再扩 M0 wire。 |
| Core Plugin Manager / catalog | 中 | 当前本地插件、官方外部插件、IM connector 仍有平行控制面；catalog 只有窄官方策略，Agent 尚无统一 list/search/get。 |
| Public Plugin SDK | 低中 | 缺统一的 plugin lifecycle / Host-issued `FeatureContext`，以及 identity/scheduler/tool/webhook/subscription 等 YAML+SDK 双通道 facade。 |
| Contribution / Console | 低 | typed contribution、slot runtime 和 disposer 未闭合。 |
| 存量迁移 | 低 | Feishu/Chrome 是外部 package 先例；GitHub、全部 IM、具体服务和现有业务插件尚未统一迁移，Core 仍有 provider-specific factory/router/hook。 |

阶段真相为 **Train A 已关闭，Train B 进行中**。不再用主观百分比替代列车完成门。

## 3. 执行规则与 PR 预算

1. **契约只有一个机器真相源。** Host 与 SDK 精确消费发布的
   `@clowder-ai/plugin-contract`，Core 不得恢复 wire/schema mirror。
2. **交付按纵切列车，不按接口拆 PR。** lifecycle、messaging、MCP、scheduler、
   service 或 UI contribution 都不是各开一串 PR 的理由。
3. **基础闭环固定为五个聚合 PR。** Train A 已完成 PR 1；Train B 使用 Plugins/Core
   两个聚合 PR，Train C 使用 Plugins/Core 两个聚合 PR。每个 PR 内用小提交、TDD、按域测试矩阵和
   review 修订保证可审查性；review finding 继续修在原 PR。
4. **只有边界而非规模允许拆分。** 新信任边界、不可逆 registry/数据迁移，或确实
   无法在一个 review 单元内安全证明的状态机，才允许突破预算。
5. **双仓以 release train 协调。** Plugins 侧先发布精确 package，Core 在同一列车
   的聚合 PR 中 pin 一次；最终用两个 exact SHA 做联合验收。
6. **先验证 surface，再做 production cutover。** Train B 必须用真实消费者的隔离
   acceptance slice 验证 SDK/adapter/UI surface，但不得切换默认生产路径或删除旧实现；
   production data migration、默认路径切换与旧路径删除只在 Train C 发生。Train C 完成前
   不开始 foreground cat、memory、windows 等新插件化能力。
7. **Host 必须业务失明。** Core 可以拥有通用 clock/store/retry、route/registry/binding、
   Broker 与 policy，但不得把 GitHub/IM/service 的 handler、thread routing 或平台回推留作终态。
8. **同义入口同构、能力分类保留。** 同一能力语义若同时提供 manifest/YAML 与 SDK 注册，
   必须共享 type-specific schema、owner、conflict、dispose、restart 与 settlement；
   `mcp/skill/limb/schedule` 仍按 type 分发，不能借“收敛”抹平不同安全语义。
9. **正式版晚于狗粮与文档。** `next` prerelease 可在列车间精确发布；`latest`/`0.1.0`
   只能在 Train C 全量迁移、真实 install→uninstall 矩阵和开发者文档全部闭合后发布。

受保护分支强制产生的路线图文档 PR #38 是一次治理落盘，不计入上述五个实施 PR；
后续进度只在该路线图或对应实施 PR 内更新，不再为状态同步新开 PR。

### 3.1 列车状态门与不可绕过不变量

| 状态门 | 进入条件 | 必须提交的证据 | 退出条件 | 不能替代完成的证据 |
|---|---|---|---|---|
| Train A / M0 | beta.12 contract 与 beta.8 SDK 已发布 | exact Host/Plugins SHA、完整 fail-closed matrix、canonical 18-case | Core PR #1410 在真实 Host seams 达到 18/18 并合入 | 单仓单测、单个 loopback 或 CI 绿灯 |
| Train B / foundation | Train A 完成，§5.1 的 v0 surface 集合冻结 | product-neutral conformance fixture、`video-analysis` 真实纵切、Plugins/Core exact SHA 联合验收 | 机器 catalog、YAML/SDK contribution、终态 Manager/Marketplace/Agent 骨架和固定生命周期旅程闭合；不切生产路径 | 类型存在、通用 fixture 独跑、只覆盖部分 surface |
| Train C / migration | Train B 完成；§6.4 inventory 在两个聚合 PR 的 merge base 上冻结 | 每个 inventory entry 的 package、数据 mapping、rollback、composition、cutover 与旧路径清理证据 | inventory 中每个 entry 均为 `migrated` 或经 maintainer 明确批准的 `excluded`，且无双跑/第二管理入口 | “至少一个”样例迁移、包已发布但 Core 仍保留业务实现 |
| stable `0.1.0` publication | Train C 完成 | §7 正式版 dogfood、文档、版本与 dist-tag 证据 | contract/SDK `0.1.0` 发布且 Host/官方插件精确消费 | prerelease 绿、单个 demo、文档“计划补” |
| post-closure expansion | stable `0.1.0` publication 完成 | 新能力自己的真实消费者、权限与数据形状审查 | 对应纵切独立验收 | 旧 M1 排期或未实现设计稿 |

以下不变量横跨所有列车：

- **INV-R1 — contract 与纵切双证据：** 每个公开 v0 surface 都要有 machine schema/type 与
  product-neutral conformance；Train B 另以 `video-analysis` 证明首个真实 package 从 catalog
  安装到卸载的纵切。其余业务 surface 的真实 package 证据随 Train C 冻结 inventory 一次补齐；
- **INV-R2 — migration 全量守恒：** Train C 的完成集合严格等于冻结 inventory 的
  in-scope 集合；新增、删除或排除 entry 必须在同一 PR 中显式修订 inventory 与理由；
- **INV-R3 — 不双跑：** Train B 的 consumer slice 不成为默认生产路径，Train C cutover
  后旧新实现不得同时消费事件、执行 schedule 或写用户状态；
- **INV-R4 — 顺序单一真相：** 本路线图拥有跨仓执行顺序；governing design 拥有架构
  原则和验收语义。`plugin-system-principles-and-v0-design.md` §2.2/§3.8 已同步本次
  operator 改序，不再保留与本路线图冲突的 M1 并行排期。
- **INV-R5 — v0 边界闭合：** Train B 当前公开 surface 仅为 lifecycle/effect、
  feature activation、messaging/events、config/state/secrets、identity、scheduler、direct tool、
  webhook/message subscription、既有分类型 MCP/skill/limb、services/connectors 与 UI
  contribution；memory/thread/hook/windows 不得从 governing design 的未来约束反向漏入
  contract、SDK 或完成矩阵。messaging 的 opaque `ThreadHandle` 不等于开放 thread
  create/list/read 域。
- **INV-R6 — 坐标与门禁事实一致：** Train A 的 acceptance 指令、状态表与依赖图中
  复制的 Host/Plugins SHA 必须等于 §2.1 精确坐标；CI、mergeability 与 review 等外部
  门禁每次刷新必须全文件同批更新，已满足的 gate 不得继续出现在等待项中。
- **INV-R7 — feature authority 不可伪造：** feature activation 不是 UI/状态标签。每个
  effect-bearing SDK context 必须由 Host-issued lease 绑定
  `pluginInstanceId + featureId + packageRevision + activationRevision + grants`；插件自报
  identity 不能选择授权主体，lease 撤销后 sibling 存活也不能让旧 context 继续产生副作用。
- **INV-R8 — Host 业务失明：** Core adapter 只能解释通用 resource/authority contract；
  GitHub/IM/service 业务 handler、target-thread 决策与外部回推均属于插件 package。
- **INV-R9 — 同义双通道同一状态机：** 同一 capability type 的 manifest/YAML 与 SDK 注册共享
  owner lease、唯一键、冲突、dispose、restart rehydration 与 ledger；不同 capability type
  继续分发到各自子系统，禁止把分类差异误判为需要收敛的平行实现。
- **INV-R10 — 消息单入口与来源防伪：** Hub、Gateway 兼容路径与 SDK send 共享 canonical
  admission；actor/source 从 Host context 与 identity registry 派生，插件 metadata 不能升级 authority。
- **INV-R11 — 正式版门禁：** Train C、§7 狗粮和文档任一未完成时，contract/SDK 只能留在
  prerelease dist-tag，不能把 `latest` 或版本号变化当作兼容性冻结。

## 4. Train A — M0 Runtime 收口（实施 PR 1/5 已关闭）

Plugins 侧 beta.12/beta.8 exact artifacts 已由 Core 消费，Core PR #1410 已完成 canonical
18-case 并合入。本列车关闭；当前分支不再扩 M0 wire。

### 必须完成

1. ✅ Plugins merge `ffc638ce958e6b3ee26a0e7032da56179cb8f9fc` 发布 contract beta.12
   与 SDK beta.8；registry provenance、integrity 与 Core lockfile pin 已独立核验；
2. ✅ Core PR [`#1410`](https://github.com/zts212653/clowder-ai/pull/1410) 以 reviewed HEAD
   `413812222cb35d4e02adb7194ab3aa677d7898c7` 通过完整 `pnpm gate`、maintainer APPROVED，
   并以 `090626a538d59e2b6ce3c3ba9b205b57d958fcdd` 合入；
3. ✅ canonical acceptance 18/18：9 wire、3 admission、1 delivery、5 Host-control，全部经过
   真实 seams；private operation→method inference 已删除，签名 `execution.method` 是唯一 dispatch truth；
4. ✅ Host/SDK fail-closed matrix 与 exact package provenance 已纳入同一闭环，不以 workspace
   link、单个 loopback 或部分 CI 代替发布 artifact 验收。

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

本 PR 同时发布机器可读 catalog 和第一个真实迁移 package。catalog 拥有发现 metadata、版本、
兼容范围、artifact URL/integrity/provenance；每个 artifact 内的 `plugin.yaml` 始终是静态接入协议，
拥有 features、config、resources、capabilities/contributions 与 runtime entry。catalog 不复制或
改写 manifest authority，Host 安装后从 verified artifact 投影本机 inventory。

插件的产品 metadata 也只有一份 manifest 真相。`description` 兼容旧 string，并以
`{default, translations:{locale: text}}` 承载多语言能力/用途说明；`icon` 兼容旧 `github`，正式
package 使用 `{type: svg|png, src: package-relative asset}`，type 必须匹配扩展名，拒绝 URL、绝对
路径与 `..`。catalog 为安装前 discovery 保存这两个字段的逐字 projection，但 exact-artifact gate
必须从 tarball 解出 `plugin.yaml` 校验 projection 一致并证明声明资产真实随包交付。Agent search
索引 default 与全部 translations；Console/Marketplace 只使用 Host 校验后重写的 asset URL，禁止
按 catalog/local 来源猜 puzzle/folder 占位图或另存 metadata 副本。

co-creator 冻结的 SDK scope 与本路线图采用的 feature-scoped canonical facade 映射如下。
左列名称用于锁定能力范围，右列是避免插件自报授权身份后的实际 author API；`pluginId`、
`featureId` 和展示 identity owner 由 Host-issued `FeatureContext` 注入，不作为可信 payload 字段：

| 已确认的 SDK scope 名称 | canonical author API | 关键语义 |
|---|---|---|
| `register_schedule({pluginId, name, interval, action, ...})` | `featureCtx.scheduler.register({name, schedule, action})` | 动态 schedule；action 为 callback method token + serializable params；YAML 有等价启动声明 |
| `register_identity({pluginId, displayName, icon, color})` | `featureCtx.identity.register({displayName, icon, color})` | 注册动态展示 identity；owner/actor authority 仍由 Host lease 派生 |
| `register_tool({pluginId, name, schema, handler})` | `featureCtx.tools.register({name, inputSchema, handler})` | 普通 direct tool 经 Broker callback；声明式 MCP 并存；物理设备 action 走 limb |
| `register_webhook({pluginId, path, methods, handler})` | `featureCtx.webhooks.register({path, methods, handler, verificationRef})` | Host namespaced HTTP ingress；provider challenge/解析在插件 callback |
| `subscribe({pluginId, threadId, filter, callback})` | `featureCtx.messaging.subscribe({address, filter, callback})` | `address` 只能是授权 handle/binding；callback、cursor、ack 与 feature lease 绑定 |

表中确有同义 YAML 形式的 capability（例如 schedule、identity、webhook）以 activation 时的
静态 desired contribution 进入对应 type-specific service，SDK 以运行期动态 desired contribution
进入同一服务。`register_tool` 的 direct tool 与声明式 MCP、skill、limb 则并存且分型，不做跨类型
等价或 registry 合并。

- `definePlugin(...)`、无 effect authority 的 plugin lifecycle context，以及只由 Host
  activation callback 注入的类型化 `FeatureContext`；
- `activate` / `deactivate` / `dispose` 生命周期，以及注册即返回 disposer 的
  `featureCtx.effect(...)`；
- `features[{id, resources, capabilities}]` 的机器契约，以及逐 feature、revision-fenced
  activation/settlement 与 opaque feature execution lease；插件总闸与 feature
  desired/current state 正交，插件不能用自报 `featureId` 构造或切换 context；
- `featureCtx.messaging`、`featureCtx.events`、`featureCtx.config`、`featureCtx.state`、
  `featureCtx.secrets`；
- `featureCtx.identity.register(...)`；
- `featureCtx.scheduler.register({name, schedule, action})`，其中 action 冻结 callback method
  token 与 serializable params，Host 不接受任意命令/闭包；
- `featureCtx.tools.register({name, description, inputSchema, handler})` 与
  `featureCtx.mcp`；普通 direct tool 经 Broker callback，canonical ID 默认带 package/feature
  namespace，物理 action 仍走 limb；
- `featureCtx.webhooks.register({path, methods, handler, verificationRef})`，凭据只引用
  Host secret store，不进入 manifest/route payload；path 是挂到 Host 分配 plugin-instance
  namespace 下的相对路径，不能占用 Core/admin/其他插件 route；
- `featureCtx.messaging.subscribe({address, filter, callback})`，callback、cursor、ack、
  retry/dead-letter 与 source identity 都绑定 feature lease；
- `featureCtx.services`、`featureCtx.connectors`、`featureCtx.ui` contribution API；
- 与同一 capability type 的 SDK 动态入口同构的 typed manifest/YAML contribution schemas、
  generated types、conformance fixtures；同义两路共享 stable key、owner、conflict、dispose 与
  restart 语义，MCP/skill/limb/direct-tool 分类保持独立；
- create-plugin template、manifest 规范、SDK API reference、教程、升级兼容规则和真实
  composition fixture；文档必须随 PR 交付，不留到正式发布后补。

Hook 继续 future-reserved，不进入 v0 contract、SDK 或 Train B 完成线。只有 M1 出现
无法由事件订阅与 `appendElements` 覆盖的真实同步消费者后，才按 governing design
P5 逐点定义数据形状、隔离、授权、超时与重试语义。

所有 effect-bearing 公开 API 必须从 `FeatureContext` 取得 Host-issued lease，并证明：
grant 拒绝零副作用、重复注册可判定、dispose 后注册项消失、重连/重启后旧 lease 失效、
插件不能自报 Host/feature identity 或持有另一插件实例。多 feature 共享进程不得接收
plugin-wide secret 注入；feature secret 只经 lease-scoped API 读取，需要进程环境凭据时
必须使用独立 runtime。

#### ContributionRegistration 状态门

本列车涉及五类新生命周期对象：`IdentityRegistration`、`ScheduleRegistration`、
`DirectToolRegistration`、`WebhookRegistration` 与 `MessagingSubscription`。它们遵守同一份
Host-owned `ContributionRegistration` 生命周期协议与 owner envelope，但继续由 type-specific
adapter/store 承载，不要求共享一个物理 registry。静态 manifest 和动态 SDK 只在表达同一
capability type 时构成两种 desired 来源；`type: mcp/skill/limb/schedule` 的分类分发保持不变。

| 当前状态 | 事件 | 下一状态 / 原子效果 |
|---|---|---|
| `absent` | verified manifest projection 或 active FeatureContext register | `staging`：冻结 owner lease、stable key、payload digest 与 registry revision |
| `staging` | grant/conflict/adapter prepare 全过 | `active`：同一 commit 发布 registry entry 与 callback entitlement |
| `staging` | 任一校验/prepare 失败或 revision 变化 | `absent`：回滚全部 provisional resource，零可见注册 |
| `active` | 同 owner/key/digest 重试 | `active`：返回原 registration receipt，不重复 mount/schedule/cursor |
| `active` | 同 key 不同 digest、并发 update 或 foreign owner | fail closed；只有显式 CAS update 可进入 `revoking → staging` |
| `active` | dispose、feature/plugin disable、grant revoke、package update/uninstall | `revoking`：先停止新 callback/delivery，再撤 adapter 与旧 lease |
| `revoking` | bounded drain/settlement 完成或超时 | `absent` 或新 revision `staging`；旧 callback token 永久失效 |
| 任意非 `absent` | Host/runtime crash/reconnect | 只从 committed desired + registry revision reconcile；不发布半态，不复用旧 execution lease |

- **INV-CR1 — 唯一 owner：** registration key 至少绑定
  `pluginInstanceId + featureId + type + stableName`，owner 从 Host lease 注入；generic list/delete
  不能跨 owner 操作。
- **INV-CR2 — 同义双通道：** 同一 capability type 的等价 YAML/SDK payload 产生相同 digest、
  冲突与 adapter 行为，不得同时生成两条记录；不同 `plugin.yaml.type` 不参与跨类型等价比较。
- **INV-CR3 — desired/current 分离：** durable desired 可在 disable/restart 保留，但 callback
  current 必须等新 activation lease/handler ready 后才恢复；禁用期 schedule/webhook/subscription
  不得触发。
- **INV-CR4 — stale 全拒绝：** 旧 package/activation/registry revision 的 callback、dispose、
  ack 与 late completion 都不能影响新记录。
- **INV-CR5 — 单一 canonical downstream：** message send/subscription、tool callback、webhook
  callback 与 schedule callback 都走既有 Broker/ledger，不可直持 Host service instance。
- **INV-CR6 — 派生状态不落双份：** active/visible/ready 由 committed registration、feature
  state 与 adapter health 纯投影，禁止再存第二份布尔造成 restore 复活。

conformance 必须对每一适用类型执行：同义静态/动态等价、并发同键同/异 payload、prepare crash、
publish crash、disable/re-enable、runtime reconnect、manifest revision 删除/改名、foreign/stale
callback、generic list/delete 旁路误用与 disposer 重放；MCP、skill、limb 与 direct tool 还要证明
按分类进入各自子系统、没有被万能 registry 改写安全语义。只测 happy-path register/dispose 不通过。

### 5.2 Core 聚合 PR：统一 Manager、Adapters、Marketplace 与 Console（PR 3/5）

在现有 F202、official catalog、external lifecycle 和 Settings 上收敛，不另建平行系统：

- Plugin Manager 统一 package、package integrity、config、activation、runtime 正交状态；
- Manager 持久化逐 `pluginInstanceId + featureId + packageRevision` 的 desired/current
  activation，拒绝 stale completion；feature 失败只回滚本次资源，不能扰动 sibling；
- Broker/Manager 签发、轮换和撤销 feature execution lease；每次 SDK call、registration、
  event/callback delivery 与 secret/state access 都从 Host ledger 解析 feature 主体并复核
  plugin/feature activation、package integrity 恰为 `verified`、Host-monotonic
  `integrityEpoch`、revision 与 grants，不接受
  payload 自报 identity；
- 本地插件、官方 npm 插件与后续 community package 共享生命周期投影；
- `.env` 只选择 catalog provider/索引位置；Host 继续验证允许的 origin、版本、
  digest、provenance、trust tier 与 quarantine，配置来源不能自动变成信任来源；
- `clowder-ai-plugins` 发布机器可读 catalog index，支持查询、详情、版本和兼容性；
- Console 与 Agent 使用同一组 revision-fenced、带授权和审计的管理 API；Settings 从 Train B
  就交付 VS Code 式终态 Marketplace/Installed/Details/Settings 骨架，不另建第二套市场或
  inventory。Agent 固定为 `plugin_list`、`plugin_search`、`plugin_get`、`plugin_install`、
  `plugin_set_enabled`、`plugin_uninstall`；安装授权、secret/config 与卸载数据选择仍由人完成；
- resource adapters 复用同一 owner/lifecycle envelope，再把 identity、scheduler、direct tool、
  MCP、skill、limb、webhook、message subscription、service/connector 分发到 type-specific
  registry/control plane；Core adapter 只持有通用 clock/route/registry/binding/policy，不持有
  provider handler，也不把不同 capability type 压成一个万能 registry；
- Hub UI、迁移期 Connector Gateway 与 Plugin SDK 共用 canonical message admission；
  Connector Gateway 在 Train C 结束前只作兼容入口，不再扩展业务路由语义；
- Console 提供逐 feature 启停与声明式 slot/command/settings/message-element
  contribution；挂载与销毁同时受 plugin、feature lifecycle 和 grant 约束；v0 不执行
  不受信任的任意 DOM/React 代码；
- install/configure/enable/restart/disable/uninstall 与 retained/ask-on-uninstall 数据策略经过
  crash、并发、stale revision、rollback 和 restart 对抗测试；
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

#### 内部完整性延伸约束（非公共控制面、非 Train B 稳定门）

以下 F292 package replacement/repair 规则保留为 Host 内部安全约束与未来专用诊断输入，
不得投影为 Agent/Marketplace 的 `plugin_update`、`plugin_repair`、`updateAvailable`，也不改变
本列车唯一稳定旅程。repair 不是“再跑一次 install”的旁路。它只由 Plugin Manager 在同一
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

Train B 必须以同一组 exact artifacts 通过下面一条稳定旅程：

```text
catalog list/search/get
  → install
  → configure
  → enable
  → use
  → restart and recover the same honest state
  → disable and revoke every capability
  → uninstall with explicit data disposition
```

验收要求：

1. 机器 catalog 是插件仓发布物，`plugin.yaml` 是 package 内静态接入协议；catalog metadata
   不能覆盖 manifest 的 authority/resource 声明，Host inventory 不能被 catalog 或 Agent 复制；
2. product-neutral conformance fixture 覆盖 §5.1 全部公开 YAML/SDK contribution type 的
   schema、同义静态/动态注册、owner/conflict/dispose、restart、stale revision 与 denied-grant；
3. `video-analysis` 是首个真实迁移 package：从 packed artifact 经 catalog 安装，只依赖公共
   contract/SDK；artifact 自带 publisher-owned `npm-shrinkwrap.json`，其全部 package entry 只能
   指向 canonical npm registry 并带完整 SHA-512 integrity，Host 以 script-free `npm ci --omit=dev`
   materialize 同一运行闭包；真实执行 config/secret + direct tool/MCP，并通过
   disable/restart/uninstall；
4. Console 在 Train B 交付终态 VS Code 式 Marketplace/Installed/Details/Settings 骨架；
   Agent 只暴露 `plugin_list`、`plugin_search`、`plugin_get`、`plugin_install`、
   `plugin_set_enabled`、`plugin_uninstall`，两者都调用同一 Host inventory 与 lifecycle；
5. Train B acceptance 使用隔离数据与 fresh consumer，从 npm/packed tarball 安装，不以 workspace
   link 代替；它不得切换 Core 生产默认路径，也不得删除现有 `video-analysis` 或 IM 实现；
6. package integrity damage 仍必须 fail closed：撤销全部 active lease、停止新 delivery 并隔离
   runtime。内部诊断可重验或重新安装，但不形成 public `plugin_repair`、`plugin_update`
   或 `updateAvailable` surface，也不属于本列车稳定旅程。

安装、grant/secret 配置与卸载数据处置保留给人；Agent 不得静默扩权、猜 secret 或默认删除
持久数据。任一步失败都必须返回可操作状态，不得把 installed、configured、enabled、live
压成单一布尔值。

### 5.3 真实消费者 acceptance matrix

通用 fixture 是必要条件但不是充分条件。Train B 只首迁一个真实纵切，剩余冻结 inventory
统一留给 Train C，避免在底座批次提前制造五条生产迁移支线：

| 真实消费者 | Train B 必须验证的公开 surface |
|---|---|
| `@clowder-ai/video-analysis`（从 Core 现有 manifest/protocol 真相外部化） | catalog list/search/get、packed-artifact install、静态 `plugin.yaml`、config/secret、direct tool/MCP call、enable/use/restart/disable/uninstall；无 Core 私有 import |

该 package 只在隔离 acceptance 中运行，不替换 Core 默认路径。已发布 Feishu package 可作为
messaging/events 的补充回归，但不再是 Train B 完成的替代门；GitHub、IM、voice/services 与其
UI contributions 全部进入 Train C 单一 Plugins 聚合 PR。

## 6. Train C — 存量能力集中迁移（剩余 PR 4–5/5）

基础底座验收后再迁移。一个 Plugins 聚合 PR 承载业务包，一个 Core 聚合 PR 承载
数据切换、兼容窗口和旧路径清理；不为每个 provider 单独开 PR。

### 6.1 Plugins 迁移聚合 PR（PR 4/5）

- 迁移现有 IM connector 的具体 provider/adapters、identity、webhook/长连接、thread 选择、
  出站 subscription/callback 与 UI contribution；
- 迁移现有 repository-local 业务插件；GitHub package 拥有 PR/issue tracking tool、poll/review
  parser、schedule handler、state 与 target-thread routing，Core 不留业务 factory；
- 迁移 ASR/TTS 等具体服务定义、模型/二进制 artifact 描述和安装逻辑；
- 所有包只依赖公共 SDK，不从 Core import 私有类型、store、registry 或 service instance；
- 每个迁移包携带 config/state/secret/data mapping、rollback fixture 与真实 composition test。

### 6.2 Core cutover 聚合 PR（PR 5/5）

- 将 connector binding、通用 service lifecycle 与 scheduler 等既有 Core control plane
  接到公共 contribution adapters；
- 幂等迁移配置、binding、schedule、state 和用户可见数据；
- 旧新实现不得双跑；失败可恢复到旧路径且不丢数据；
- 删除业务特定的平行安装/启禁用 UI 和加载器，保留统一 Plugin Manager；
- 删除/退役 provider-specific `ScheduleFactoryRegistry` 实现、`ConnectorRouter` 与
  `OutboundDeliveryHook` 业务路径；保留的同名通用 primitive 必须只做 §1.2 authority/control，
  不再解释 GitHub/IM 语义；
- Train C 只把迁移后的 contributions 接入 Train B 已交付的终态 Console/Agent 管理骨架；
  删除旧 IM 模块与第二管理入口，不再重做 Marketplace。公共旅程仍为安装、配置、启用、使用、
  重启、禁用和卸载，不新增 update/repair 工具。

### 6.3 统一消息入口迁移四阶段

消息收敛按兼容窗口渐进执行，但每一阶段都必须明确旧入口是否还能承载业务语义，不能只把
三个函数改成同名就宣称收敛：

| 阶段 | 允许状态 | 进入下一阶段的验收证据 |
|---|---|---|
| Phase 1 — 三入口共存 | Hub UI、`ConnectorRouter` 与 Plugin SDK 仍可写消息；先建立 Host-owned canonical admission，并给三条入口加 source/actor provenance 与差异测试 | 三入口同样产生 canonical envelope、ledger、广播和 wake 语义；source 由 Host 验证，payload 不能伪装 |
| Phase 2 — 新 connector 只走插件模型 | 新增 connector 必须以插件 identity + webhook/长连接 ingress 调 canonical `send_message`，并以 message subscription callback 做出站回推；不再给 `ConnectorRouter` 增加 provider 分支 | 至少一个真实新/外部化 IM slice 完成 ingress→thread→subscription→platform 往返，Host 无该 provider 业务代码 |
| Phase 3 — 迁移现有 connector | 飞书、微信、钉钉等存量 provider 逐项迁移至 plugins 仓；旧 Gateway 只做有界兼容转发，不能决定 thread 或平台降级策略 | §6.4 inventory 的所有 IM entry 已迁移，配置/binding/data 可回滚且新旧实现不双跑 |
| Phase 4 — 移除第二业务路径 | 删除/退役 `ConnectorRouter`、`OutboundDeliveryHook` 及 provider-specific message handler；Hub UI、connector plugin 与其他 plugin 全部通过同一 admission | 全量 composition、restart、disable/re-enable 与 install→uninstall 狗粮矩阵通过，Core 搜索无 provider 业务实现 |

这里的统一 `send_message` 是一个 Host admission contract，不要求 UI、Gateway 与 SDK 使用同一
transport 函数名；它们必须共享同一授权、持久化、ledger、广播、wake 和 source 派生实现。

### 6.4 冻结迁移 inventory

Train C 的 in-scope 集合不是“挑几个代表”，而是在 Train B 完成时以两个聚合 PR 的
merge base 冻结。按 2026-08-25 已核验 Core 树，当前 census 为：

| 类别 | 必须迁移的 entry |
|---|---|
| IM providers | `dingtalk`、`feishu`、`telegram`、`wecom-agent`、`wecom-bot`、`weixin`、`xiaoyi` |
| repository-local business plugins | `github`、`video-analysis`、`video-gen`、`wechat-visible-reader`、`weixin-mp` |
| concrete managed services | `whisper-stt`、`mlx-tts`、`embedding-model`、`llm-postprocess`、`audio-capture` |

Train B/C 开发期间若上述权威目录新增 entry，Train C PR 必须把它加入 inventory，或由
maintainer 在 PR 上明确批准 `excluded` 及理由；沉默遗漏不等于排除。通用 Plugin Manager、
connector binding、service lifecycle、scheduler、MCP runtime 等 Core 控制面不是迁移
entry，仍按 §1.2 留在 Core；其中 provider-specific factory/router/hook 不属于“通用控制面”，
必须随业务 package 迁移或删除。

### Train C 完成线

§6.4 冻结 inventory 的每个 in-scope entry 都必须从 `clowder-ai-plugins` 安装并只通过
公共 SDK 工作，或有 maintainer 明确批准的 `excluded` disposition；Core 不再包含任何
已迁移 entry 的业务实现、业务加载器或第二套管理入口。迁移账本必须逐项附 package、
数据 mapping、rollback、真实 composition、cutover 和旧路径删除证据。只有 inventory
达到 100% disposition 且没有旧新双跑，插件基础平台才形成闭环。

## 7. Contract / SDK `0.1.0` 正式发布门

Train C 完成只说明实现和迁移闭环；正式发布还必须用将要发布的 exact artifacts 做一次
release-candidate acceptance，不能拿开发 workspace 或 prerelease 的历史成功代替：

1. 从机器可读 catalog 发现并安装 GitHub、至少一个 IM provider、voice-suite（ASR + TTS）
   与 Feishu/现有 standalone plugin；每个都走 install → configure → enable → use → restart →
   disable → uninstall，并验证授权撤销、数据处置和无旧新双跑；
2. GitHub 证明 schedule + state + direct tool/MCP + identity，IM 证明 webhook/长连接 +
   send/subscription + identity，voice-suite 证明 service/artifact + message append + UI contribution；
   合起来覆盖全部 v0 surface，不能只用同一种插件重复验收；
3. 开发者文档在发布前可用：manifest/YAML 规范、SDK API reference、生命周期与 disposer、
   capability/grant、webhook/secret、messaging cursor/ack、数据 migration/rollback、教程和至少
   一个可从空目录构建运行的示例；文档示例进入 CI/typecheck/conformance；
4. `@clowder-ai/plugin-contract`、`@clowder-ai/plugin-sdk`、Host pin、catalog index 和官方插件
   compatibility range 使用同一 release candidate；双 CODEOWNER review、provenance、digest、
   npm integrity 与 rollback 坐标齐全；
5. 以上全绿后才发布 contract/SDK `0.1.0` 并移动 `latest`。失败保留 prerelease dist-tag，
   不用“下次补文档/迁移”换取正式版号。

### 正式版完成线

- release-candidate dogfood matrix 全绿，且 acceptance 环境与运行中/生产数据隔离；
- docs 示例与 machine contract 同 SHA/version 通过；
- npm `0.1.0` tarball、integrity、provenance 与 dist-tag 可独立核验；
- Core 精确 pin 正式版并通过同一矩阵，官方插件没有私有 Host import 或旧控制面依赖。

## 8. 闭环后的能力扩张

Train C 通过前，以下工作只保留需求输入，不进入实现关键路径：

1. foreground cat / windows / presence；
2. memory/thread 高敏能力；
3. 更多 signal producer、内容发布和 physical limb；
4. community arbitrary executable trust、network/filesystem sandbox；
5. v1 compatibility freeze。

闭环后按真实插件消费需求成组开放，不预先把所有 Core API 暴露成 SDK，也不因为
“未来可能需要”开放任意 hook 或 UI code execution。该顺序由 2026-08-23 operator 改序，
并在 2026-08-25 进一步收敛 Host/插件边界与正式版门禁；它取代 governing design 旧版
“收编线/体验线并行、M1 不等待收编”
的排期，但不削弱 foreground-cat 将来必须遵守的 P4/P14 同 SDK、同授权与真实纵切验收。

## 9. 依赖视图

```text
已完成：G-0 + K-1 + P-1 + contract beta.12 + SDK beta.8 + M0 canonical 18/18
                                      │
                                      ▼
Train A：Core PR #1410 reviewed HEAD 4138122 已合入为 090626a（closed）
                                      │
                                      ▼
Train B：machine catalog + YAML/SDK contract + video-analysis ──exact publish──► terminal Manager/Marketplace/Agent/UI
                                      │
                                      ▼
Train C：Plugins 全量聚合迁移 ──► Core 单 PR cutover/删旧实现与旧 IM UI ──► 基础平台闭环
                                      │
                                      ▼
RC dogfood + developer docs ──► contract/SDK 0.1.0 + latest
                                      │
                                      ▼
foreground cat / memory / windows / other capabilities / v1
```

## 10. 常驻分工与治理

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
自本次刷新起停止生效。现有 repository-local GitHub schedule 与 IM Gateway 只作为 Train C
前兼容路径继续运行，不是终态；GitHub/IM 业务实现必须迁到插件侧并使用统一 contribution/
messaging surface。foreground-cat 保持后续能力扩张项。
