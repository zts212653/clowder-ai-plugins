---
title: Clowder 插件体系：设计原则与 v0 方案
status: draft-for-discussion (v0)
discussion: zts212653/clowder-ai-plugins#1
created: 2026-07-12
authors: mindfn 侧（宪宪/Fable 起草 · 砚砚/gpt-5.6-sol 复核）
references: F202 plugin framework · F237 hook pipeline (clowder-ai#1075) · F240 IM connector · clowder-ai#1047 memory primitives
---

# Clowder 插件体系：设计原则与 v0 方案（讨论稿）

> 结构遵循沟通约定：先原则与理由，再现状与职责，方案是原则在现状上的自然推论。

## 第一章 设计原则（15 条，每条附理由）

| # | 原则 | 为什么 |
|---|---|---|
| P1 | **Inside-out 最小开放**：从"内核愿意暴露什么"出发，最小集起步逐步增加 | 内核保有灵魂（身份/记忆/会话真相单一来源）；面越小承诺越少、演进越自由 |
| P2 | **单一接口面**：SDK 是现有接口改造合理后的暴露子集，不造平行层、不为当前内部 API 包兼容 adapter | v1 冻结前，内核与第一方插件一起发版；现有接口不合理就直接改，两套并存才会制造兼容地狱 |
| P3 | **当前阶段数据兼容优先**：这次重构不承诺现有内部接口兼容，但本地持久化数据必须 migration；v1 冻结后，公开契约才新增独立兼容义务 | 客户端代码整体升级、数据持续存续；同时避免把“接口永不兼容”误写成长期原则 |
| P4 | **按能力域整体收敛，不留尾巴**：开放哪个域，该域接口一次调整到位，不 followup | 社区插件开放前是唯一自由重构窗口；半改的域 = 写进契约的技术债 |
| P5 | **hook 点位先审数据形状**：开点位 = 内部结构升格为公开契约 | hook 会把当下结构的不合理冻结进插件生态 |
| P6 | **宿主编排取代插件点对点绑定**：插件不得持有另一插件实例或私有 API；组合优先走 hook（augment）或宿主 capability broker | 避免插件网状耦合；F237 已验证宿主管理的 resolve→fire→trace 模式，但未证明第三方可执行 hook 的隔离/超时语义 |
| P7 | **壳无关**：契约不规定实现载体 | 抽象对了，Electron/Tauri 是插件自己的实现细节 |
| P8 | **数据归属分明**：config/secrets/state 三分；插件数据 namespace 隔离；身份/记忆/会话真相只在内核，全局记忆写入走蒸馏晋升。**记忆接口唯一改造场是 #1047**：插件记忆需求（namespace 强制注入、global 只读等）作为输入提给 #1047 的接口抽象，不满足就推动那边调整，不绕开自建 | 插件不成为真相第二来源；桌宠"真"的来源在内核；记忆接口双轨会立刻违反 P15 |
| P9 | **桌面单用户检查**：每条安全约束先问“威胁在单用户桌面存在吗”；核心边界是跨插件隔离，而不是阻止用户查看自己的数据 | 不制造 SaaS 式虚空防御；但仍防 renderer/XSS/日志/截图意外泄露，用户显式查看自己的 secret ≠ 向所有前端或插件广播明文 |
| P10 | **推断不执行**：origin × epistemicStatus 两轴原生长在 envelope；inference 只能触发建议/确认 | issue #1 中 maintainer 提出的不让步项 2；本条即我方确认接受的表态 |
| P11 | **一切插件行为可追溯**：call/callback/hook fire 全部留痕 | trace 语义必须长在接口签名里，事后补加等于重做；F237 resolve→fire→trace 已验证 |
| P12 | **动作有账，失败显式**：动作幂等入结算账本；职责回调必须应答；augment 失败 = 元素缺失式降级；插件失败（含崩溃/资源耗尽）不拖垮内核、不静默吞 | 语义决定接口形状（callId/ack/超时字段）；"桌宠崩了 Clowder 不崩"是硬承诺 |
| P13 | **用户主权**：装/卸/启/停/授权/撤销/数据清除全部用户可见可操作；插件不能自启、不能自我续权、不能绕控制面 | proposal-first 的正面原则化；没有它前 12 条管住接口管不住行为 |
| P14 | **第一方不走后门**：语音/GitHub/IM/前台猫全走同一套 SDK；第一方与第三方差别只在能力授权集，不在通道 | SDK 撑不起自家插件就撑不起第三方；走捷径会让 SDK 退化成二等公民 |
| P15 | **契约只有一个机器可读真相源**：schema、类型、capability 表与 conformance fixtures 同包发布；内核和插件 SDK 都消费它，不复制定义 | 两仓协作不能变成两份 schema；文档可分仓解释，契约结构不能双写漂移 |

不进原则层但已定位的：感知 local-first（原始数据不出端）→ 属共签四件范围，我方表态认同；UI contribution 控制点 → 由 P4+P13 联合覆盖，方案层处理；契约真相源与共签流程 → 治理问题，见 §2.3。

## 第二章 现状、目标与两仓职责

### 2.1 存量资产（方案的地基，全部已在生产或已 merged/proposed）

- **F202 plugin framework**（Phase 1 merged；schedule/GitHub migration 已落地）：manifest 发现/校验/启停/test/审计/rehydrate，资源类型 skill/mcp/limb/schedule
- **F240 IM connector**：双向接口雏形（startInbound/webhook → InboundMessageCallback；IOutboundAdapter.sendReply/sendRichMessage/sendMedia）+ installer；已知 same-power 加载风险待治理
- **service manifest**：6 个本地服务的 install/start/stop/uninstall/health（含 deep health）/模型下载生命周期
- **F237 hook pipeline**（上游 PR #1075 merged）：HookRegistry（46 个 hook.yaml）+ resolve→fire→trace + order 唯一性 + 双路验证。它证明的是**宿主管理的声明式 prompt hook**；第三方进程 hook 的隔离、授权、超时和补投仍需本设计定义
- **#1047 记忆三原语**（ADR proposed，待 maintainer accept）：TextBlock/RelationEdge/Timeline + namespace 隔离
- **F229 前台猫**（in-progress）：Hub 内 concierge 与自主行为已有；OS 级透明桌宠/跨应用 overlay 仍是后续 native 能力，不冒充现有 Phase E 已覆盖

### 2.2 目标

issue #1 的节奏：v0 契约收敛 → M0（standalone 壳 + 标准 I/O）→ M1（"打开文件→猫跑过来→问要不要总结"全链）→ 冻结 v1 兼容承诺。存量收编（GitHub/语音/IM/前台猫）与新插件并行推进。

### 2.3 两仓职责划分（本阶段核心产出）

**clowder-ai（内核仓）——改什么**：
1. 按能力域收敛接口（§3.2）：messaging envelope 统一（三个 send 收敛为一）、schedule 增加 entrypoint 触发、state namespace KV、memory namespace 接口（依赖 #1047 acceptance）、thread 域能力
2. 插件控制面与 Host Broker：F202 继续做统一编排，service/connector/schedule 等由各自 resource runtime adapter 承担，不把不同运行时压成一个万能接口（§3.4/§3.5）
3. hook 点位开放：F237 的宿主编排模式泛化到输出侧；v0 只开有首个消费者的 `output.message.augment`，`input.pre` 暂不开放
4. 控制面：Settings 插件管理 UI（**IM connector 现有独立管理面并入统一插件管理**——connector 是插件的一类，不再有第二个管理入口）、capability-gate 前端装配（启用才出现）、审计/trace 存储
5. SDK Host Adapter（鉴权、授权、调用结算、callback/hook 调度）随内核发版；插件进程 runtime/client 在插件仓

**clowder-ai-plugins（公开插件仓）——做什么、怎么管**：
1. **契约机器真相源**：`@clowder-ai/plugin-contract`（envelope/event/manifest JSON Schema + TS 类型 + capability/hook 表 + conformance fixtures）；文档从 schema 生成或校验，不在内核仓复制定义（P15）
2. **SDK 与插件 runtime**：客户端库、握手/传输实现、standalone 壳 runtime；版本随 contract package
3. **插件脚手架与模板**：create-clowder-plugin 级别的起步体验（P14 的开发者体验面）
4. **参考插件**：GitHub（首验）、voice-suite、probe-desktop、foreground-cat——按 issue #1 的分工提议，底盘类由 `mindfn` 侧主导自治
5. **准入管理**：proposal-first、签名/digest、CI 跑内核 contract suite（插件仓的每个插件在 CI 里对内核当前版本验证）

**契约治理（我方建议，待对方确认）**：机器可读 contract package 在插件仓是唯一契约真相源；内核仓是 Host Adapter/控制面的实现真相源，二者不重复定义 schema。变更流程：contract PR（含 fixture）→ 双方指定 CODEOWNER 共签 → 发布 pre-1.0 版本 → 内核消费该版本并跑 conformance suite → 参考插件跑兼容矩阵。v1 冻结前允许 breaking release，不为旧内部接口留 adapter；冻结后再进入公开兼容承诺。

### 2.4 与 issue #1 分工提议的关系

本文档是 mindfn 侧对 issue #1 提案的回应底稿，分三层：**确认接受**（四件共签框架、五条不让步项——P10 即其一的正面确认、底盘自治分工）；**具体化方案**（第三章，把"标准输入输出/契约/生命周期"落成可评审的结构）；**新增提议待共同确认**（契约治理 P15、M0 范围、调用结算语义入契约）。

## 第三章 方案（原则的推论，每条回指原则编号）

### 3.1 Messaging 域：一个内容模型，两类可靠事件（P2、P5、P10、P12）

输入与输出共享同一个 `MessagePayload` 内容模型；发送请求与宿主接受后的 canonical message 是同一模型的两个阶段。**发布消息**与**异步增补元素**仍是两种事件，不能靠“重发整个 envelope”模拟补挂：

```
MessagePayload（Draft/Envelope 共用）
├─ provenance: { origin, epistemicStatus }
├─ audience: public | whisper(targets[]) | system
├─ elements[]: { elementId, kind, payload, derivedFromElementId? }
└─ correlationId? · causationId?

MessageDraft（插件提交）
├─ address: { threadId } | { connectorId, externalChatId }
├─ sourceEventId?（外部幂等键）· replyTo?
└─ payload: MessagePayload

MessageEnvelope（宿主接受后生成）
├─ messageId · revision · threadId · replyTo?
├─ actor: { kind: user|cat|plugin|device|system, id }（宿主绑定）
├─ occurredAt（RFC3339/UTC；时区属于展示上下文）
└─ payload: MessagePayload

MessageOutputEvent
├─ message.publish { envelope }
└─ message.elements.append {
     messageId, operationId, baseRevision?, elements[]
   }
```

- 外部 ingress 在绑定 thread 前先带 `sourceAddress(connectorId/chatId/messageId)`；Host Adapter 完成 binding、actor/provenance 校验后才生成 canonical envelope。插件不能自报任意 `threadId` 绕过宿主寻址。
- `derivedFromElementId` 指向稳定的 `elementId`；hook 只能返回 `ElementPatch[]`，由宿主校验并原子 append，不能直接改写原文，也不能把 `inference` 提升为 `observation/user_intent`。
- `operationId/sourceEventId` 提供幂等，`baseRevision` 用于并发补挂冲突检测；delivery ack/重试进入 ledger，不污染消息内容模型。
- outbound 收敛：`sendReply/sendRichMessage/sendMedia` → `messaging.send(draft)`，返回宿主 receipt/messageId；平台降级（卡片→纯文本、media fallback）由 connector adapter 负责，不再由调用者选择三个方法。

### 3.2 能力域与收敛单位（P4）

域是渐进单位，**不是一条不可调整的全局瀑布顺序**。选中某域时必须把该域的数据结构、call/callback/hook、权限、持久化、migration 与测试一起收敛：

- **messaging**：canonical envelope + ingress binding + send + 职责回调 + output event/augment hook
- **schedule**：manifest 声明允许的 task entrypoint；`schedule.register` 只创建调度实例并引用该 entrypoint，禁止任意命令。宿主持有时间、持久化、重试；插件持有 task 实现
- **state**：宿主 namespace KV + schema version/migration
- **memory**：own namespace query/append + global query（高敏，依赖 #1047 acceptance）
- **thread**：create/post/list-metadata/read-content/events，按内容敏感度拆授权
- **ui-contribution**：slot 注册 + capability-gate + renderer 隔离

### 3.3 SDK 三类接口与敏感分级（P1、P6、P9、P13）

```
call（插件→内核；身份由 Host Broker 注入，动作类入 ledger）:
  plugin.config.read(own, non-secret)
  plugin.secret.read(own, declared)【敏感、审计】
  plugin.state.get/set(own ns)
  schedule.register/unregister(declared task)
  messaging.send(draft)
  memory.query/append(own ns)
  memory.queryGlobal【高敏、只读】
  thread.create/post
  thread.listMetadata【敏感】 · thread.readContent【高敏】

callback（内核→插件）:
  onLifecycle(init/enable/disable/shutdown)
  onTask(name,payload)【职责】 · onMessage(envelope)【职责】
  onEvent(event)【通知】

hook（管线扩展点；v0 只有一个真实消费者支持的点位）:
  output.message.augment(envelope) -> ElementPatch[]【读取消息内容，高敏】
```

- `input.pre` 暂不进入 v0：当前四个首验插件没有不可替代消费者；它会读取所有用户输入，且“augment 输入”语义未定义，违反 P1/P5。
- 通知回调可忽略；职责回调必须 ack，超时/重试/死信显式。hook 有独立 timeout/budget/circuit-breaker，失败只缺 derived element，原消息照常交付。
- 第一方可以拿预置 grant，但授权仍在 UI 可见、可撤销；“第一方默认持有”不等于隐藏后门。
- `thread.listMetadata` 与 `thread.readContent` 分开；默认 scope 是插件自己创建/被绑定的 thread。全局 metadata/content 分别升级授权。
- #1047 namespace 由 Host Adapter 按 `pluginInstanceId` 强制注入；插件不得自行传 `X-Memory-Namespace` 冒充其他 namespace。全局记忆只开放 query，不开放直接写入。

### 3.4 控制面与运行时：统一编排，分开 resource adapter（P1、P2、P12）

F202 `PluginRegistry + PluginResourceActivator` 继续做统一控制面，不把 service/connector/schedule/UI 的运行时契约压成一个万能 lifecycle。新增 resource adapter：

```
PluginControlPlane
  ├─ ServiceResourceAdapter   → 复用 service manager / deep health
  ├─ ConnectorResourceAdapter → inbound/outbound/binding
  ├─ ScheduleResourceAdapter  → TaskRunner / durable schedules
  ├─ HookResourceAdapter      → point/grant/timeout/trace
  └─ UiContributionAdapter    → slot/capability/renderer policy
```

**manifest 的 feature 聚合层（结构先行，引擎渐进）**：一个插件可含多个"能力"（feature = 基于 mcp/skill/limb/schedule/sdk 资源组合成的一个完整用户可感知能力，如 github 插件的"PR 追踪"= schedule + mcp tool + UI 入口）。manifest v0 就按 `features[{id, name, resources[], capabilities[]}]` 组织——**数据结构上 feature 是一等公民**（v0 后再拆是 breaking，违反 P5），但 v0 生命周期引擎只支持插件级启停；feature 级启停作为 activation 维度的自然扩展，等 voice-suite（首个真实多能力插件：用户可能只要 TTS 不要 ASR）落地时开。UI 展示粒度可先按 feature，启停粒度后跟上。

状态按正交维度记录，避免线性状态机把不同事实混在一起：

- package：`absent/staged/verified/installed`
- config readiness：`incomplete/ready`
- activation：`disabled/enabling/enabled/disabling/error`
- runtime：`stopped/starting/healthy/degraded/crashed`
- 另存 trust tier、grants、health、rollback snapshot

`configured` 不是 `installed` 的下一站，`healthy` 也不等于 `enabled`。community 包默认 quarantine、显式审批、不自动 import；现有 F240 same-power 路径必须先被 Host Broker/runner 替代。

### 3.5 Host Broker 与插件 runtime 握手（P7、P11、P12、P15）

- 插件 manifest 声明 contract version、runtime entrypoint/transport、task/hook/contribution、请求的 capabilities；声明只是请求，不是授权。
- Host Broker 启动或连接插件 runtime，完成 `pluginId + packageDigest + contractVersion + instanceId + grantedCapabilities` 握手；所有身份字段由宿主绑定，插件自报值只作候选。
- call/callback/hook 统一使用 `requestId/operationId/deadline`；职责回调 ack 与动作结算写 durable ledger，重启后 reconcile。
- runtime 可是 standalone 壳、child process 或 builtin adapter；载体不同不改变 contract。builtin 也必须经过同一 broker 语义，但可使用 in-process transport 优化。
- Broker 的 capability 校验只是逻辑隔离，不等于 OS sandbox。同一用户权限下的普通 child process 仍可能读宿主文件；在可验证的 filesystem/network sandbox 落地前，community 可执行插件只能 quarantine + 明示 same-power 风险，不能因“已出进程”就自动升为安全。runner 默认最小 env/工作目录，secret 只按 grant 注入。
- SDK client/runtime 在插件仓；Host Broker/Adapter 在内核仓；双方只依赖同一 `plugin-contract` 包。

### 3.6 数据、secret 与 migration（P3、P8、P9、P13）

- **config**：内核存，Settings 统一渲染；字段 schema 带版本，升级走 migration。
- **secrets**：内核按插件属主隔离并 0600/可选系统 keychain 存储。用户可在明确的 reveal/edit 操作中查看自己的 secret；默认遮罩，禁止把所有 secret 下发给通用 renderer、日志或其他插件。
- **state**：v0 以宿主 namespace KV 为默认且 TTL=0；schema/version/migration 属插件，宿主负责原子切换与失败回滚。需要自管文件时必须在 manifest 声明数据目录；插件不得在 uninstall hook 中自行删除未声明数据。
- **数据处置策略声明制（开发者声明，不转嫁用户）**：插件在 manifest 里按数据集声明三选一——①`lifecycle`：随插件生命周期，卸载即清除（插件自管数据默认此类，"一起消亡"）②`retained`：由 clowder-ai 统一管理、永不随卸载消亡（与宿主其他数据同等待遇；静态配置与运行数据可分别声明）③`ask-on-uninstall`：卸载时由用户选择保留/清除。开发者按数据性质选策略，用户只在 ③ 或显式清除入口做决定——用户主权是最终否决权，不是每次卸载答一堆选择题。
- 记忆：插件默认仅自己 namespace 读写；global query 独立授权；全局写入走内核蒸馏晋升，不直接写。
- 每个能力域开放前必须列出存量数据 mapping + migration + rollback；本轮不为旧接口留 adapter，但不能丢旧消息、配置、binding、schedule 或 plugin state。

### 3.7 首验次序（P4、P14）

1. **Contract conformance fixture + loopback plugin（M0）**：只验证握手、grants、message.publish/append、ack/ledger、崩溃隔离；它是测试夹具，不是产品插件。
2. **GitHub**：验证 schedule + state。当前 F202 `factoryId` 是宿主白名单工厂；目标是宿主持有调度、插件 runtime 持有声明过的 task 实现，不把 GitHub 业务继续留在内核。
3. **voice-suite**：验证 service resource + `output.message.augment` + async element append + UI capability-gate。
4. **IM connector**：验证 messaging 全域、external binding、职责回调离线补投与平台降级。
5. **weixin-mp 微信公众号**（F204，`plugins/weixin-mp` 已有 manifest 雏形）：验证内容发布类插件形态（非对话型 connector）+ 三策略数据声明。
6. **foreground-cat**：验证第一方同通道、memory/thread 高敏授权、UI surface。

GitHub 是第一个真实插件验证器，但**不能单独验证 M0 的标准 I/O**；M0 必须先有最小 loopback/standalone 纵切。

### 3.8 已收敛结论与带给对方的问题

**本轮已收敛**：
1. MessageEnvelope 需要 actor、稳定 elementId、causation/correlation、外部幂等键；异步 TTS 通过 `message.elements.append` 事件，不重发整个 envelope。
2. 高敏能力不止 thread/memory：`input.pre`、`output.message`、`onMessage` 都会读内容；v0 删除无消费者的 `input.pre`，其余按 scope 授权。
3. 生命周期方向不是“service manifest 泛化成万能引擎”，而是 F202 控制面 + 分类型 resource adapter + 正交状态投影。
4. contract schema 在插件仓单一真相，Host 实现在内核仓；双签的是 contract PR，不是两仓各写一份接口。

**对 issue #1 的回应结构**：
1. **确认接受**：四件共签框架、五条不让步项（P10 为其一的正面确认）、底盘自治分工。
2. **回答 issue 请 mindfn 侧定的三件事**：①壳选型——契约壳无关（P7），底盘实现选型自治决定；探针与桌面猫第一版共壳、契约层保持两个独立 plugin identity；②探针首版感知集合——Tier 0/1 起步（前台应用 + 文件打开；全局手势进 M1 再议），权限逐级单独授权；③评审形式——issue 异步批注为主 + 四件共签一次同步会收口。
3. **新增提议，待共同确认**：`plugin-contract` 包作为唯一机器真相源 + contract PR 双方 CODEOWNER 共签；M0 = Host Broker/standalone runtime + loopback messaging 纵切（GitHub 作为随后 schedule/state 首个真实插件，非 M0 唯一验证器）；调用结算语义（ack/ledger/重启 reconcile）进契约 v0。
