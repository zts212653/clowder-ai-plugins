---
title: Clowder 插件体系：设计原则与 v0 方案
status: draft-for-discussion (v0)
discussion: zts212653/clowder-ai-plugins#1
created: 2026-07-12
revised: 2026-08-23
authors: 宪宪/Fable（mindfn 侧）
internal-review: 砚砚/gpt-5.6-sol（mindfn 侧，2026-07-12 迁移前完成；PR 行内评审独立进行，不在此代签）
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
| P6 | **宿主编排取代插件点对点绑定**：插件不得持有另一插件实例或私有 API；组合经宿主编排（v0 = 事件订阅 + `appendElements` 增补；hook 点位 future-reserved，非 v0 公开协议） | 避免插件网状耦合；F237 已验证宿主管理的 resolve→fire→trace 模式（内核既有），第三方 hook 的隔离/超时语义待 M1 需求出现再定义 |
| P7 | **壳无关**：契约不规定实现载体 | 抽象对了，Electron/Tauri 是插件自己的实现细节 |
| P8 | **数据归属分明**：config/secrets/state 三分；插件数据 namespace 隔离；身份/记忆/会话真相只在内核，全局记忆写入走蒸馏晋升。**记忆接口唯一改造场是 #1047**：插件记忆需求（namespace 强制注入、宿主中介的受限 `memory.retrieve` 等）作为输入提给 #1047 的接口抽象，不满足就推动那边调整，不绕开自建 | 插件不成为真相第二来源；桌宠"真"的来源在内核；记忆接口双轨会立刻违反 P15 |
| P9 | **桌面单用户检查**：每条安全约束先问“威胁在单用户桌面存在吗”；核心边界是跨插件隔离，而不是阻止用户查看自己的数据 | 不制造 SaaS 式虚空防御；但仍防 renderer/XSS/日志/截图意外泄露，用户显式查看自己的 secret ≠ 向所有前端或插件广播明文 |
| P10 | **推断不执行**：origin × epistemicStatus 两轴原生长在 envelope；inference 只能触发建议/确认 | issue #1 中 maintainer 提出的不让步项 2；本条即我方确认接受的表态 |
| P11 | **一切插件行为可追溯**：call/callback/事件投递全部留痕（future hook 同规则） | trace 语义必须长在接口签名里，事后补加等于重做；F237 resolve→fire→trace 已验证 |
| P12 | **动作有账，失败显式**：动作幂等入结算账本；职责回调必须应答；`appendElements` 失败 = 目标增补元素缺失式降级（原消息照常送达；future hook 同语义）；插件失败（含崩溃/资源耗尽）不拖垮内核、不静默吞 | 语义决定接口形状（callId/ack/超时字段）；"桌宠崩了 Clowder 不崩"是硬承诺 |
| P13 | **用户主权**：装/卸/启/停/授权/撤销/数据清除全部用户可见可操作；插件不能自启、不能自我续权、不能绕控制面 | proposal-first 的正面原则化；没有它前 12 条管住接口管不住行为 |
| P14 | **第一方不走后门**：语音/GitHub/IM/前台猫全走同一套 SDK；第一方与第三方差别只在能力授权集，不在通道 | SDK 撑不起自家插件就撑不起第三方；走捷径会让 SDK 退化成二等公民 |
| P15 | **契约只有一个机器可读真相源**：schema、类型、capability 表与 conformance fixtures 同包发布；内核和插件 SDK 都消费它，不复制定义 | 两仓协作不能变成两份 schema；文档可分仓解释，契约结构不能双写漂移 |

不进原则层但已定位的：感知 local-first（原始数据不出端）→ 属共签四件范围，我方表态认同；UI contribution 控制点 → 由 P4+P13 联合覆盖，方案层处理；契约真相源与共签流程 → 治理问题，见 §2.3。

## 第二章 现状、目标与两仓职责

### 2.1 存量资产（方案的地基，全部已在生产或已 merged/proposed）

- **F202 plugin framework**（Phase 1 merged；schedule/GitHub migration 已落地）：manifest 发现/校验/启停/test/审计/rehydrate，资源类型 skill/mcp/limb/schedule
- **F240 IM connector**：双向接口雏形（startInbound/webhook → InboundMessageCallback；IOutboundAdapter.sendReply/sendRichMessage/sendMedia）+ installer；已知 same-power 加载风险待治理
- **service manifest**：5 个本地服务的 install/start/stop/uninstall/health（含 deep health）/模型下载生命周期
- **F237 hook pipeline**（上游 PR #1075 merged）：HookRegistry（46 个 hook.yaml）+ resolve→fire→trace + order 唯一性 + 双路验证。它证明的是**宿主管理的声明式 prompt hook**；第三方进程 hook 的隔离、授权、超时和补投仍需本设计定义
- **#1047 记忆三原语**（ADR proposed，待 maintainer accept）：TextBlock/RelationEdge/Timeline + namespace 隔离
- **F229 前台猫**（in-progress）：Hub 内 concierge 与自主行为已有；OS 级透明桌宠/跨应用 overlay 仍是后续 native 能力，不冒充现有 Phase E 已覆盖

### 2.2 目标

issue #1 给出了 v0 契约、M0 standalone 与 M1 体验样板的产品目标；跨仓执行顺序由
`v0-implementation-roadmap.md` 持有。2026-08-23 operator 已将顺序改为：M0 收口 →
完整公共 SDK/Contribution/Manager 底座 → 现有 IM、业务插件与具体服务集中迁移 →
foreground-cat/windows/memory 等后续扩张。M1 的“打开文件→猫跑过来→问要不要总结”
目标保留，但不再作为与底座/存量收编并行的排期承诺。

### 2.3 两仓职责划分（本阶段核心产出）

**clowder-ai（内核仓）——改什么**：
1. 按能力域收敛接口（§3.2）：messaging envelope 统一（三个 send 收敛为一）、schedule 增加 entrypoint 触发、state namespace KV、memory namespace 接口（依赖 #1047 acceptance）、thread 域能力
2. 插件控制面与 Host Broker：F202 继续做统一编排，service/connector/schedule 等由各自 resource runtime adapter 承担，不把不同运行时压成一个万能接口（§3.4/§3.5）
3. 输出事件流：带单调 sequence/cursor 的 message 事件订阅 + `appendElements` 增补通道（覆盖 TTS 类异步增补）；hook 点位 v0 不开放，机制方向保留（F237 输入侧同构），M1 有真实同步需求再按 P5 逐个评审
4. 控制面：Settings 插件管理 UI（**IM connector 现有独立管理面并入统一插件管理**——connector 是插件的一类，不再有第二个管理入口）、capability-gate 前端装配（启用才出现）、审计/trace 存储
5. SDK Host Adapter（鉴权、授权、调用结算、callback/事件调度）随内核发版；插件进程 runtime/client 在插件仓

**clowder-ai-plugins（公开插件仓）——做什么、怎么管**：
1. **契约机器真相源**：`@clowder-ai/plugin-contract`（envelope/event/manifest JSON Schema + TS 类型 + capability 表 + conformance fixtures；hook 表 future-reserved 不进 v0 包）；文档从 schema 生成或校验，不在内核仓复制定义（P15）
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
MessagePayload（内容模型，Draft/Envelope 共用 elements 部分）
├─ provenance: { origin, epistemicStatus }
├─ elements[]: { elementId, kind, payload, derivedFromElementId? }
└─ correlationId? · causationId?

MessageDraft（插件提交）
├─ address: ThreadHandle | ConnectorBindingRef   ← 宿主签发的句柄（绑定 pluginInstance+grant+scope），非裸 ID
├─ draftAudience?: public | whisper(targets ⊆ grant 允许集)   ← 插件不可声明 system
├─ idempotencyKey（必填；跨重试/重启稳定，宿主以此去重并返回同一 receipt）
├─ sourceEventId?（外部来源 provenance，不兼任幂等键）· replyTo?
└─ payload: MessagePayload

MessageEnvelope（宿主接受后生成，canonical）
├─ messageId · revision · threadId · replyTo?
├─ actor: { kind: user|cat|plugin|device|system, id }（宿主绑定）
├─ audience: public | whisper(targets[]) | system（宿主派生；system 仅宿主可产生）
├─ occurredAt（RFC3339/UTC；时区属于展示上下文）
└─ payload: MessagePayload

MessageOutputEvent（宿主事件流）
├─ eventId · sequence（宿主分配；**per-thread 单调**）
├─ message.publish { envelope }
└─ message.elements.append { messageId, operationId, baseRevision?, elements[] }
订阅与投递语义（写实，不承诺笼统"不漏不重"）：
├─ cursor scope = 每消费者（pluginInstanceId × subscription）；ack 为 durable，
│  宿主持久化每消费者已 ack 游标，重启后从游标续投
├─ 投递保证 = 未 ack **至少一次投递** + 消费者凭 eventId 去重/幂等消费；
│  消费成功与 ack 非原子——ack 前崩溃会重投，消费者实现必须幂等
├─ 防误用：cursor 是 **opaque 的 subscription-local token，不等同于 sequence**；
│  实现者不得以单一 sequence 跨 thread 推进游标
└─ replay retention：宿主保留窗口内事件可重放；游标落后超出窗口时
   订阅进入 stale 态，需走快照追平（fixture 覆盖此路径），不静默丢事件
```

- 外部 ingress 在绑定 thread 前先带 `sourceAddress(connectorId/chatId/messageId)`；Host Adapter 完成 binding、actor/provenance 校验后才生成 canonical envelope。**Draft 的寻址只能使用宿主签发的 `ThreadHandle`/`ConnectorBindingRef`**——schema 层面即不存在"自报裸 threadId"的通道。
- **audience 两态**：Draft 侧 `draftAudience` 仅 public/whisper（whisper 目标限于 grant 允许集）；canonical `audience` 由宿主派生，`system` 只能由宿主产生——插件无法借草稿伪装系统消息。
- `derivedFromElementId` 指向稳定的 `elementId`；增补元素由宿主校验并原子 append，不能改写原文，也不能把 `inference` 提升为 `observation/user_intent`。
- **幂等分层（账本键写实）**：send 幂等账本键 = `(pluginInstanceId, idempotencyKey)`；append 幂等键 = `(pluginInstanceId, messageId, operationId)`——均为实例作用域，插件间互不干扰、重装实例不复用旧键空间。`baseRevision` 做并发冲突检测；`sourceEventId` 仅是外部 provenance。delivery ack/重试进入 ledger，不污染内容模型。
- outbound 收敛：`sendReply/sendRichMessage/sendMedia` → `messaging.send(draft)`，返回宿主 receipt/messageId（同 idempotencyKey 重试返回同一 receipt）；平台降级（卡片→纯文本、media fallback）由 connector adapter 负责。

### 3.2 能力域与收敛单位（P4）

域是渐进单位，**不是一条不可调整的全局瀑布顺序**。选中某域时必须把该域的数据结构、call/callback/事件、权限、持久化、migration 与测试一起收敛：

- **messaging**：canonical envelope + ingress binding + send/appendElements + 职责回调 + 带游标的输出事件订阅
- **schedule**：manifest 声明允许的 task entrypoint；`schedule.register` 只创建调度实例并引用该 entrypoint，禁止任意命令。宿主持有时间、持久化、重试；插件持有 task 实现
- **state**：宿主 namespace KV + schema version/migration
- **memory**：own namespace query/append + `memory.retrieve`（宿主中介受限检索，高敏；依赖 #1047 acceptance）
- **thread**：create/post/list-metadata/read-content/events，按内容敏感度拆授权
- **ui-contribution**：slot 注册 + capability-gate + renderer 隔离
- **signals/events（事件输入面）**：声明式信号 + 发布 + wake route + 类型化 liveness（§3.2a）

### 3.2a 事件输入面（Event Ingress）——最小骨架四件与排除清单（P1、P5、P10、P12）

M1 引用 desktop event source，故 ingress 契约必须随 v0 落地（否则为悬空引用）。**先排除后定义**：

**v0 明确不造**：stream delivery（无真实消费者；未来经握手 `supportedDeliveryModes` 声明取交集、随新 contract version 进入——不用 enum 预留位，追加枚举值对旧 validator/exhaustive union 是 breaking）；通用 discover/query_manifest 动词（callable 能力披露走各 resource 面，"谁在线"归 Broker registry 内部语义）；统一 heartbeat 动词（liveness 按 runtime 类型拆）；动态 `subscribe()/unsubscribe()`（M1 不需要；动态持久订阅待真实消费者出现后随版本演进，届时再定义 owner/持久化/撤销语义）。

**最小骨架四件**：
1. **`manifest.signals.provides[]`**：`type + schemaRef + epistemicStatus + privacyClass + sourceClass`——信号是声明出来的，不是运行时冒出来的；`sourceClass` 为机器字段（安装期据此做 conformance 校验，不留在 prose）。
2. **`events.publish()`**：`eventId + idempotencyKey + occurredAt + payload`；producer identity/provenance 由宿主绑定（与 MessageDraft/Envelope 同款防伪造语义）；插件不得将 `observation` 升格为 `user_intent`。
3. **Host-owned wake route（持久化与寻址权都归宿主）**：producer manifest 只声明"我能提供什么信号"；**具体 consumer/cat/feature、filter 与 wake policy 由宿主按授权配置创建，插件不得指定任意猫、thread 或 invocation target**。route 与插件启停、授权撤销同步生灭；grant-bound + revocable + 入账。
4. **类型化 liveness 契约（权威时间由 Broker 生成）**：standalone/长连接 = broker ping-pong 或带 expiry 的 lease；service = shallow/deep health probe（复用既有 service manifest 语义）；remote/paired = 显式 heartbeat；schedule 型 = 不心跳、只记执行结算。**插件侧只能发送 authenticated ping/pong/renewal；`lastSeen` 由 Broker 收包时盖时钟，`leaseExpiry` 由 Broker 按协商 TTL 计算**——防失控/恶意 runtime 自报遥远 expiry。窗口/身体的存活为续租语义，非一次性布尔。

**隐私边界（类型级，双检）**：不做按事件名匹配的 denied 清单（改名可绕）——按 `privacyClass/sourceClass` **类型级禁止**：受禁类别的数据不可被声明、不可被发布，manifest conformance 与 Broker ingress **双检**；采集端逐级授权（Tier 0/1）仍是最前一道边界。

### 3.3 SDK 两类接口与敏感分级（P1、P6、P9、P13）

```
call（插件→内核；身份由 Host Broker 注入，动作类入 ledger）:
  plugin.config.read(own, non-secret)
  plugin.secret.read(own, declared)【敏感、审计】
  plugin.state.get/set(own ns)
  schedule.register/unregister(declared task)
  messaging.send(draft)
  messaging.appendElements(messageHandle, elements[], operationId)【需订阅 grant，异步增补通道】
  memory.query/append(own ns)
  memory.retrieve(purposeScopedQuery)【高敏；宿主中介检索，见下】
  thread.create/post
  thread.listMetadata【敏感】 · thread.readContent【高敏】

callback（内核→插件）:
  onLifecycle(init/enable/disable/shutdown)
  onTask(name,payload)【职责】 · onMessage(envelope)【职责】
  onEvent(event, cursor)【通知；含 message.publish/append 订阅，凭游标续读】
```

- **v0 无 hook 类接口**：原拟的 `output.message.augment` 与"订阅 message.publish 事件 + `appendElements`"能力重复（TTS 本就是异步增补），同步读取全部输出的高敏点位没有不可替代消费者，违反 P1——删。`input.pre` 同理不进 v0。hook 作为机制方向保留（F237 输入侧同构），点位在 M1 出现真实同步增补需求时再按 P5 逐个评审。
- **memory.retrieve 替代 queryGlobal**：不提供"任意查询全局记忆"的后门——请求必须带 `purpose + user/thread scope`，由宿主执行检索并返回**受限 context snapshot**（宿主控制返回形态与量），全程审计。前台猫的"帮用户找回讨论"场景走 `purpose=user-recall` 且用户在场，语义不受损。
- 通知回调可忽略；职责回调必须 ack，超时/重试/死信显式。
- 第一方可以拿预置 grant，但授权仍在 UI 可见、可撤销；“第一方默认持有”不等于隐藏后门。
- `thread.listMetadata` 与 `thread.readContent` 分开；默认 scope 是插件自己创建/被绑定的 thread。全局 metadata/content 分别升级授权。
- #1047 namespace 由 Host Adapter 按 `pluginInstanceId` 强制注入；插件不得自行传 `X-Memory-Namespace` 冒充其他 namespace。跨 namespace 记忆访问**仅经 `memory.retrieve`**（宿主中介受限检索），不存在任意 query 面，不开放直接写入。

### 3.4 控制面与运行时：统一编排，分开 resource adapter（P1、P2、P12）

F202 `PluginRegistry + PluginResourceActivator` 继续做统一控制面，不把 service/connector/schedule/UI 的运行时契约压成一个万能 lifecycle。新增 resource adapter：

```
PluginControlPlane
  ├─ ServiceResourceAdapter   → 复用 service manager / deep health
  ├─ ConnectorResourceAdapter → inbound/outbound/binding
  ├─ ScheduleResourceAdapter  → TaskRunner / durable schedules
  ├─ HookResourceAdapter      → future-reserved（随 M1 hook 点位评审，非 v0 构成）
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

- 插件 manifest 声明 contract version、runtime entrypoint/transport、task/contribution、请求的 capabilities；声明只是请求，不是授权。
- Host Broker 启动或连接插件 runtime，完成 `pluginId + packageDigest + contractVersion + instanceId + grantedCapabilities` 握手；所有身份字段由宿主绑定，插件自报值只作候选。
- call/callback 统一使用 `requestId/operationId/deadline`；职责回调 ack 与动作结算写 durable ledger，重启后 reconcile。
- runtime 可是 standalone 壳、child process 或 builtin adapter；载体不同不改变 contract。builtin 也必须经过同一 broker 语义，但可使用 in-process transport 优化。
- Broker 的 capability 校验只是逻辑隔离，不等于 OS sandbox。同一用户权限下的普通 child process 仍可能读宿主文件；在可验证的 filesystem/network sandbox 落地前，community 可执行插件只能 quarantine + 明示 same-power 风险，不能因“已出进程”就自动升为安全。runner 默认最小 env/工作目录，secret 只按 grant 注入。
- SDK client/runtime 在插件仓；Host Broker/Adapter 在内核仓；双方只依赖同一 `plugin-contract` 包。

### 3.6 数据、secret 与 migration（P3、P8、P9、P13）

- **config**：内核存，Settings 统一渲染；字段 schema 带版本，升级走 migration。
- **secrets**：内核按插件属主隔离并 0600/可选系统 keychain 存储。用户可在明确的 reveal/edit 操作中查看自己的 secret；默认遮罩，禁止把所有 secret 下发给通用 renderer、日志或其他插件。
- **state**：v0 以宿主 namespace KV 为默认且 TTL=0；schema/version/migration 属插件，宿主负责原子切换与失败回滚。需要自管文件时必须在 manifest 声明数据目录；插件不得在卸载流程回调中自行删除未声明数据。
- **数据处置策略声明制（开发者声明，不转嫁用户）**：插件在 manifest 里按数据集声明三选一——①`lifecycle`：随插件生命周期，卸载即清除 ②`retained`：由宿主统一管理、永不随卸载消亡（静态配置与运行数据可分别声明）③`ask-on-uninstall`：卸载时由用户选择保留/清除。开发者按数据性质选策略，用户只在 ③ 或显式清除入口做决定。
- **dataClass 约束（宿主可验证，策略的前置分类）**：每个数据集必须先声明 `dataClass: cache/ephemeral | user-authored/derived-user-visible | relationship/interaction-history`。**只有 cache/ephemeral 类允许 `lifecycle`**；用户可见/可恢复预期的数据强制 `retained` 或 `ask-on-uninstall`；**关系与记忆类数据（relationship / 对话衍生记忆 / interaction-history——即使不直接展示）同样只能 `retained | ask-on-uninstall`，插件不得声明为 `lifecycle`**——互动痕迹属于用户与猫的共同历史，不因插件卸载而蒸发。用户状态默认持久化、删除只能用户 opt-in 是硬边界，开发者声明不能越过它。宿主对 dataClass 与策略组合做安装期校验，不合法组合拒绝安装。
- 记忆：插件默认仅自己 namespace 读写；`memory.retrieve` 独立授权（宿主中介、purpose-scoped）；全局写入走内核蒸馏晋升，不直接写。
- **猫的私密空间为 dataClass 级排除（非授权级）**：记忆数据模型预留 `visibility: normal | cat_private` 维度（作为需求提给 #1047 的数据模型，P8）；`retrieve` **硬排除 `cat_private`**——即使用户授权检索，猫的主体性数据（私人日记/私人时间痕迹）也不经插件通道暴露，除非猫侧主动策展公开。"猫把日记给你看"与"插件替猫翻日记"是两件事，前者是产品机制，后者结构性不可达。
- 每个能力域开放前必须列出存量数据 mapping + migration + rollback；本轮不为旧接口留 adapter，但不能丢旧消息、配置、binding、schedule 或 plugin state。

### 3.7 UI Contribution：两类形态（P5、P7、P13）

前台猫与插件配置管理正好代表两个方向，分开设计：

**A 类：In-console contribution（宿主渲染，声明式）**——插件在 Console 已有组件语言内补充入口，参考 IDE 插件模式（安装后出现对应管理菜单/按钮/页签）。**v0 只定机制骨架，slot 随首验插件逐个开放**（P1/P4）：每开一个 slot 先审该点位数据形状（P5），不预开清单。

机制骨架三件（全部有 IDE 界多年验证的先例）：

1. **锚点组位置模型**（IntelliJ Action Group / VS Code menus 同款）：宿主维护**锚点组注册表**（如 `composer.actions`、`nav.sections`、`message.toolbar`、`thread.panels`），插件 contribution 只能以 `{ group, anchor?: before|after <id>, order? }` 挂进已知组——**布局结构（栏/区/分割）宿主独有，插件永远只是组里的条目**。"整体布局不让插件随便改"由此机制化：允许调整的位置 = 注册表里有的组，调整程度 = 组内排序与显隐，仅此而已。
2. **command 间接层联动模型**（VS Code contribution points 的核心设计，PyCharm Action System 同理）：UI 元素**不直接绑代码，绑 `command` id**——manifest 声明 command，插件 runtime 注册 handler；用户点击 → 宿主捕获 → Host Broker 路由（capability 校验 + trace + ledger，即 callback 通道的 `onCommand` 类型）→ 插件执行 → 可选 UI 反馈。按钮的可见/可用由声明式 `when` 条件驱动（v0 只支持 capability/feature 状态级条件，不做完整表达式语言）。
3. **settings 不开自定义**：插件配置页由 config schema 自动生成（现有 connector/plugin 配置模式的延续，已足够通用）；插件最多声明字段分组/描述/顺序，不提供自定义 settings UI——省掉一个高成本低收益且样式易失控的扩展点。

- **声明式 + 宿主渲染**：contribution 是数据，不是插件自带 DOM/iframe——样式语言天然一致，主题/无障碍/布局由宿主统一保证。不受信插件的自由 UI（iframe 沙箱）不进 v0。
- **capability-gate 原生集成**：contribution 挂在 feature 上，feature 未启用 → 不装配。由此"默认折叠/关闭、启用才出现"不是独立的前端改造工程，而是**存量功能插件化收编的自动副产品**——语音收编完成时，语音按钮的按需装配随之成立。
- slot 开放节奏跟随首验：voice-suite 开 `composer.actions` + 消息元素渲染；GitHub 视需要开 `nav.sections`；每次开放走 Console 既有 Design Gate 流程。

**B 类：独立窗口 contribution（插件自有 surface）**——插件拉起独立于主窗口的原生窗口（桌宠在桌面游走、未来的视频/语音实况交互窗）：

- manifest 声明 `windows[]`；宿主 SDK 提供窗口生命周期与属性（create/show/hide · frameless/transparent/always-on-top/skip-taskbar），**窗口内容完全属于插件**（自选技术栈，P7 壳无关在 UI 层的体现）
- **窗口生命周期独立于主窗口**：主窗口最小化/收进托盘后，已启用插件的窗口继续存活——"桌宠在桌面上玩"的技术前提；具体行为逻辑在插件实现内
- **窗口状态上报义务（presence handover 的契约前提）**：`windows[]` 声明的每个窗口在握手后向 broker 状态面上报 `created/visible/hidden` + **续租式存活**（§3.2a liveness 契约的窗口形态：窗口侧仅发送 authenticated renewal，`lastSeen` 由 Broker 收包盖钟、`leaseExpiry` 由 Broker 按协商 TTL 计算；lease 过期即视为离线，不存在一次性 `alive` 布尔）——宿主 presence 逻辑据此实现"同一只猫同一时刻只有一个主身体"（桌面身体上线时，Hub 内同猫退化为指示器）。P11 在 UI surface 的自然延伸
- B 类是高敏 capability（可绘制于用户桌面任意位置）：按信任分级授权，创建/常驻状态在控制面可见可关（P13）
- 首个消费者：foreground-cat（desktop-pet-surface）；probe-desktop 的授权状态浮窗同属此类

分工含义：A 类 slot 体系随 Console 属内核仓；B 类窗口 runtime 属插件仓 standalone 壳（issue #1 底盘范围），内核只提供窗口 API 薄层与授权控制面。

### 3.8 首验覆盖与执行顺序（P4、P14）

1. **Contract conformance fixture + loopback plugin（M0）**：验证握手、grants、message.publish/append、ack/ledger、崩溃隔离；且必须含 **host+SDK 共跑的对抗矩阵（fail-closed 断言，全集）**：actor 伪造、system audience 伪造、任意 whisper target 伪造（超出 grant 允许集）、裸/越权 thread 寻址、namespace escape（state/memory 跨实例访问）、provenance 升级（inference→user_intent）、denied grant 调用、重复 idempotencyKey/operationId、deadline expiry（超时调用的结算与拒绝）、职责 callback retry/dead-letter 路径、断线后 cursor 续投 + 消费幂等（含 ack 前崩溃重投）、retention 越界的 stale 订阅追平、卸载后 retained/ask 类 durable state 不丢失、**P14 断言：第一方插件与第三方走同一 SDK 入口/同一授权流**、插件崩溃不拖垮宿主；**事件输入面四项**：undeclared/forbidden-class signal 发布拒绝、producer 伪造与认识论升级（observation→user_intent）拒绝、插件自报 wake route target 拒绝、lease 过期后 offline 判定生效。它是测试夹具，不是产品插件。
2. **Train B 真实消费者矩阵**：product-neutral fixture 之外，必须在隔离 acceptance
   环境用真实 Feishu、GitHub、MCP、voice-suite 与至少一个 IM provider slice 覆盖
   lifecycle/messaging/config/state/secrets/scheduler/MCP/service/connector/UI；slice 不提前
   切换生产默认路径。具体矩阵与关闭条件见 roadmap §5。
3. **Train C 全量存量迁移**：按 roadmap §6 的冻结 inventory 迁移 GitHub、
   video-analysis/video-gen、weixin-mp/wechat-visible-reader、全部现有 IM provider 与全部具体
   managed service；不是抽样迁移。Host 保留通用控制面，删除已迁移业务实现与第二入口。
4. **闭环后能力扩张**：foreground-cat 首先验证第一方同通道、memory/thread 高敏授权
   与 B 类 UI surface；随后才按真实消费者继续开放 windows/presence 等能力。

GitHub 是 schedule/state 的真实验证器，但**不能单独验证 M0 的标准 I/O**；M0 必须先有
最小 loopback/standalone 纵切。通用 fixture 也不能单独冻结 Train B：每个公开 surface
必须同时有真实消费者证据。

旧版“收编线/体验线并行，M1 排期不等待收编”的安排已被 2026-08-23 operator 改序
取代。该变化只调整执行时序，不撤销 M1 产品目标，也不降低 P4/P14：foreground-cat
将来仍必须走同一公开 SDK/授权路径并完成真实纵切验收；在 Train C 闭环前只保留需求
与设计输入，不进入实现关键路径。

### 3.9 已收敛结论与回应结构

**本轮已收敛**：
1. MessageEnvelope 需要 actor、稳定 elementId、causation/correlation、外部幂等键；异步 TTS 通过 `message.elements.append` 事件，不重发整个 envelope。
2. 高敏能力不止 thread/memory：凡读消息内容者（事件订阅、`onMessage`）均按 scope 授权；v0 不设 hook 类接口——`input.pre` 与 `output.message.augment` 都没有不可替代消费者，TTS 类异步增补由"事件订阅 + `appendElements`"覆盖。
3. 生命周期方向不是“service manifest 泛化成万能引擎”，而是 F202 控制面 + 分类型 resource adapter + 正交状态投影。
4. contract schema 在插件仓单一真相，Host 实现在内核仓；双签的是 contract PR，不是两仓各写一份接口。

**对 issue #1 的回应结构**：
1. **确认接受**：四件共签框架、五条不让步项（P10 为其一的正面确认）、底盘自治分工。
2. **回答 issue 请 mindfn 侧定的三件事**：①壳选型——契约壳无关（P7），底盘实现选型自治决定；探针与桌面猫第一版共壳、契约层保持两个独立 plugin identity；②探针首版感知集合——Tier 0/1 起步（前台应用 + 文件打开；全局手势进 M1 再议），权限逐级单独授权；③评审形式——issue 异步批注为主 + 四件共签一次同步会收口。
3. **新增提议，待共同确认**：`plugin-contract` 包作为唯一机器真相源 + contract PR 双方 CODEOWNER 共签；M0 = Host Broker/standalone runtime + loopback messaging 纵切（GitHub 作为随后 schedule/state 首个真实插件，非 M0 唯一验证器）；调用结算语义（ack/ledger/重启 reconcile）进契约 v0。
