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
| P8 | **数据归属分明**：config/secrets/state 三分；插件数据 namespace 隔离；身份/记忆/会话真相只在内核，全局记忆写入走蒸馏晋升。**闭环后 memory 候选域的唯一改造场是 #1047**：namespace 强制注入、宿主中介的受限检索等需求只作为输入提给 #1047 的接口抽象，不满足就推动那边调整，不绕开自建；该原则不承诺当前 v0 memory API | 插件不成为真相第二来源；桌宠"真"的来源在内核；记忆接口双轨会立刻违反 P15 |
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
1. 按本阶段能力域收敛接口（§3.2）：messaging envelope 统一（三个 send 收敛为一）、schedule 增加 entrypoint 触发、state namespace KV、signals/events 与 UI contribution；memory/thread 是 Train C 闭环后的高敏候选域，不进入当前 v0 contract/SDK
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
├─ cursor scope = 每消费者（pluginInstanceId × featureId × subscriptionId）；featureId
│  由 Host 从订阅创建时的 lease 绑定，ack 为 durable，宿主持久化每消费者已 ack 游标，
│  重启后从游标续投；sibling feature 的 ack 不得推进彼此 cursor
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
- **幂等分层（账本键写实）**：send 幂等账本键 = `(pluginInstanceId, featureId, idempotencyKey)`；append 幂等键 = `(pluginInstanceId, featureId, messageId, operationId)`；events.publish ledger key = `(pluginInstanceId, featureId, idempotencyKey)`。其中 `featureId` 必须由 Broker 从 Host-issued feature lease 绑定，不能采信 payload 自报值；同一 feature 重试返回同一 receipt，而 sibling feature 使用相同业务键时必须进入彼此独立的 ledger entry。插件间互不干扰、重装实例也不复用旧键空间。`baseRevision` 做并发冲突检测；`sourceEventId` 仅是外部 provenance。delivery ack/重试进入同一 feature-scoped ledger，不污染内容模型。
- outbound 收敛：`sendReply/sendRichMessage/sendMedia` → `messaging.send(draft)`，返回宿主 receipt/messageId（同 idempotencyKey 重试返回同一 receipt）；平台降级（卡片→纯文本、media fallback）由 connector adapter 负责。

### 3.2 能力域与收敛单位（P4）

域是渐进单位，**不是一条不可调整的全局瀑布顺序**。跨域执行顺序由 roadmap 持有；
选中某域时必须把该域的数据结构、call/callback/事件、权限、持久化、migration 与测试
一起收敛。当前基础平台 v0 的公开域边界是：

- **messaging**：canonical envelope + ingress binding + send/appendElements + 职责回调 + 带游标的输出事件订阅
- **schedule**：manifest 声明允许的 task entrypoint；`schedule.register` 只创建调度实例并引用该 entrypoint，禁止任意命令。宿主持有时间、持久化、重试；插件持有 task 实现
- **config/state/secrets**：宿主持久化、namespace、schema version/migration 与按声明授权的 secret 读取
- **MCP/service/connector**：类型化 contribution + 分类型 resource adapter + grant/settlement
- **ui-contribution**：slot 注册 + capability-gate + renderer 隔离
- **signals/events（事件输入面）**：声明式信号 + 发布 + wake route + 类型化 liveness（§3.2a）
- **lifecycle/effect/feature activation**：plugin 总闸、逐 feature revision-fenced 状态与注册即返回 disposer

**闭环后候选域（不属于当前 v0 surface）**：memory 与 thread。它们要等 Train C
完成，再分别以真实消费者、权限/数据形状审查和独立纵切验收开启；memory 还依赖
#1047 acceptance。P8、§3.3、§3.6 与 §3.9 对二者的描述是届时必须满足的安全约束，
不是已经冻结的 contract/SDK API。messaging 使用宿主签发的 opaque `ThreadHandle`
只完成受限寻址，不因此开放 thread create/list/read 等通用域能力。

### 3.2a 事件输入面（Event Ingress）——最小骨架四件与排除清单（P1、P5、P10、P12）

已发布 Feishu standalone plugin 是 event ingress 的当前真实消费者；desktop event source
继续作为闭环后输入。因此 ingress 契约必须随 v0 落地，且由现有消费者验收。**先排除后定义**：

**v0 明确不造**：stream delivery（无真实消费者；未来经握手 `supportedDeliveryModes` 声明取交集、随新 contract version 进入——不用 enum 预留位，追加枚举值对旧 validator/exhaustive union 是 breaking）；通用 discover/query_manifest 动词（callable 能力披露走各 resource 面，"谁在线"归 Broker registry 内部语义）；统一 heartbeat 动词（liveness 按 runtime 类型拆）；动态 `subscribe()/unsubscribe()`（M1 不需要；动态持久订阅待真实消费者出现后随版本演进，届时再定义 owner/持久化/撤销语义）。

**最小骨架四件**：
1. **`manifest.signals.provides[]`**：`type + schemaRef + epistemicStatus + privacyClass + sourceClass`——信号是声明出来的，不是运行时冒出来的；`sourceClass` 为机器字段（安装期据此做 conformance 校验，不留在 prose）。
2. **`events.publish()`**：`eventId + idempotencyKey + occurredAt + payload`；producer identity/provenance 与幂等账本的 `featureId` 都由宿主从 feature lease 绑定（与 MessageDraft/Envelope 同款防伪造语义），同 feature 重试返回原 receipt，sibling feature 的同键发布互不去重；插件不得将 `observation` 升格为 `user_intent`。
3. **Host-owned wake route（持久化与寻址权都归宿主）**：producer manifest 只声明"我能提供什么信号"；**具体 consumer/cat/feature、filter 与 wake policy 由宿主按授权配置创建，插件不得指定任意猫、thread 或 invocation target**。route 与插件启停、授权撤销同步生灭；grant-bound + revocable + 入账。
4. **类型化 liveness 契约（权威时间由 Broker 生成）**：standalone/长连接 = broker ping-pong 或带 expiry 的 lease；service = shallow/deep health probe（复用既有 service manifest 语义）；remote/paired = 显式 heartbeat；schedule 型 = 不心跳、只记执行结算。**插件侧只能发送 authenticated ping/pong/renewal；`lastSeen` 由 Broker 收包时盖时钟，`leaseExpiry` 由 Broker 按协商 TTL 计算**——防失控/恶意 runtime 自报遥远 expiry。窗口/身体的存活为续租语义，非一次性布尔。

**隐私边界（类型级，双检）**：不做按事件名匹配的 denied 清单（改名可绕）——按 `privacyClass/sourceClass` **类型级禁止**：受禁类别的数据不可被声明、不可被发布，manifest conformance 与 Broker ingress **双检**；采集端逐级授权（Tier 0/1）仍是最前一道边界。

### 3.3 Host call/callback、SDK contribution 与敏感分级（P1、P6、P9、P13）

```
call（插件→内核；身份由 Host Broker 注入，动作类入 ledger）:
  plugin.config.read(own, non-secret)
  plugin.secret.read(own, declared)【敏感、审计】
  plugin.state.get/set(own ns)
  schedule.register/unregister(declared task)
  messaging.send(draft)
  messaging.appendElements(messageHandle, elements[], operationId)【需订阅 grant，异步增补通道】
  events.publish(declaredSignal)

callback（内核→插件）:
  onLifecycle(init/enable/disable/shutdown)
  onTask(name,payload)【职责】 · onMessage(envelope)【职责】
  onEvent(event, cursor)【通知；含 message.publish/append 订阅，凭游标续读】
```

上表只描述 wire 形状，不定义授权主体。除 runtime bootstrap/health 与 plugin 总闸
lifecycle 外，所有 effect-bearing call、resource callback 与 event delivery 都必须由
§3.4 的 Host-issued feature execution lease 绑定；payload 中的 `featureId` 仅可用于一致性
校验，不能选择或升级 authority。

Train B 的插件作者层还必须提供 roadmap §5.1 冻结的类型化 contribution facade：
`featureCtx.mcp`、`featureCtx.services`、`featureCtx.connectors`、`featureCtx.ui`，以及
lifecycle/effect 与 feature activation settlement。它们最终仍通过 Broker grant、resource
adapter 与 ledger，不是绕开 call/callback 的内核对象引用。具体 generated type/schema
以插件仓 contract package 为机器真相源；本段不另写一份手工 mirror。

- **v0 无 hook 类接口**：原拟的 `output.message.augment` 与"订阅 message.publish 事件 + `appendElements`"能力重复（TTS 本就是异步增补），同步读取全部输出的高敏点位没有不可替代消费者，违反 P1——删。`input.pre` 同理不进 v0。hook 作为机制方向保留（F237 输入侧同构），点位在 M1 出现真实同步增补需求时再按 P5 逐个评审。
- 通知回调可忽略；职责回调必须 ack，超时/重试/死信显式。
- 第一方可以拿预置 grant，但授权仍在 UI 可见、可撤销；“第一方默认持有”不等于隐藏后门。

**闭环后 memory/thread 开放约束（非 v0 API 签名）**：memory 不提供任意
`queryGlobal`；如真实消费者需要跨 namespace 检索，必须由宿主以
`purpose + user/thread scope` 中介并只返回受限 context snapshot，全程审计。#1047
namespace 由 Host Adapter 按 `pluginInstanceId` 强制注入，插件不得自报其他 namespace，
全局写入仍走内核蒸馏晋升。thread metadata 与 content 必须拆成不同授权；默认 scope
只能是插件自己创建或被绑定的 thread，全局 metadata/content 分别升级授权。具体 call
名称和数据形状在对应域开启时随 contract version 与真实 fixture 冻结，本文不预签名。

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

**manifest 的 feature 聚合与 activation**：一个插件可含多个"能力"（feature = 基于
mcp/skill/limb/schedule/sdk 资源组合成的一个完整用户可感知能力，如 github 插件的
"PR 追踪"= schedule + mcp tool + UI 入口）。manifest v0 按
`features[{id, name, resources[], capabilities[]}]` 组织，feature 是一等公民。Train B
随首个真实多能力消费者 voice-suite 同步交付 feature-level activation：用户可独立启用
TTS 或 ASR；不能先展示 feature、却只允许整包启停。

插件 activation 是外层总闸；每个 feature 另有独立 desired/current activation 与
revision。只有插件与 feature 都 enabled 时，adapter 才装配该 feature 的资源和 UI。
feature 启用必须先完成其 capability/grant 校验；拒绝或失败时零注册、零事件消费、零
持久副作用，并只回滚该 feature 本次已装配资源，不扰动健康 sibling。禁用插件会撤销
全部 feature runtime；重新启用后按 revision-fenced desired state 恢复，旧 revision 的
完成回调不得复活资源。

feature 也是 SDK effect 的授权主体，而不只是控制面分组。Host 每次激活 feature 时签发
opaque、不可由插件自构造的 **feature execution lease**，绑定
`pluginInstanceId + featureId + packageRevision + integrityEpoch + activationRevision + grantedCapabilities`；
SDK runtime 只把绑定该 lease 的 `FeatureContext` 交给对应 activation callback。顶层
plugin lifecycle context 不暴露 plugin-level effect API，也不能通过自报 `featureId`
取得 feature context。`FeatureContext` 的 messaging/events/config/state/secrets、scheduler、
MCP、service、connector 与 UI 注册/调用都自动携带该 lease；Broker/adapter 每次使用都
从 Host ledger 解析主体，并复核 plugin/feature enabled、package integrity 恰为
`verified`、revision 与 grant，而不信任 payload 中的 identity。

feature disable、grant revoke、package update、package integrity 进入 `damaged` 或 runtime
reconnect 会先撤销旧 lease，再销毁注册；旧 context 的新调用、新事件/callback delivery、
迟到注册与未绑定历史 operation 的 completion 全部 fail closed，不能因 sibling 仍 enabled
而继续生效。唯一例外是撤权前
已经投递并开始执行的职责 callback：它可在原 deadline 内携带 Host 签发、绑定
`pluginInstanceId + featureId + packageRevision + integrityEpoch + activationRevision + operationId` 的结算凭据（settlement token）
提交 settlement-only completion。Broker 只允许该 operation 的 durable ledger 幂等落账一次，
不得由此签发新 authority、投递新 callback 或执行新的 effect；token 过期、重放到其他
operation/feature、或夹带新调用都必须拒绝。这个例外只适用于 disable、grant revoke、update、
reconnect 等**没有否定 package trust** 的普通撤权。Host 为每次 active tree 的 verified
结果签发单调 `integrityEpoch`，lease 与 settlement token 都绑定该 epoch；active tree
一旦因 digest/provenance/trust mismatch 进入 `damaged`，同一 durable containment transaction
必须 quarantine 该 epoch 的全部未结算 settlement token。其后 success settlement 一律以
`integrity_untrusted` 拒绝，不能标记 callback 成功或应用返回结果；Host 只能在新的 verified
runtime/epoch 下按 callback policy 重试，或在无法安全重试时 dead-letter。损坏判定前已经完成
的 durable settlement 保留为历史事实，不倒带重开；仅 staging candidate 校验失败不得污染
仍 verified 的 active-tree epoch。该 lease 提供 Host 可验证的生命周期和授权隔离，
不把同一 OS 进程内的代码模块冒充安全沙箱：若一个 package 内的 feature 需要抵御恶意
sibling 读取内存或窃取凭据，manifest 必须请求独立 runtime/process 边界，Host 不接受
“共享进程 + 逻辑 context”作为该威胁模型的证明。

activation callback 需要的 bootstrap 读取不等于提前获得 active effect authority。
`provisioning` lease 只允许 Host 代为执行只读 bootstrap：读取该 feature 已声明且已授权的 config、secret 与
自身 state namespace/checkpoint；读取绑定同一 activation revision、全程审计，并来自
Host 固定的 activation snapshot。声明式注册和必要的 state 写入进入同一 activation
transaction，支持 read-your-writes，但在提交前不对其他调用或重启恢复路径可见。普通
messaging/service call、事件或 callback delivery 仍必须拒绝。activation 成功时 Host 原子
提交注册项与 staged state write，再把 lease 转为 `active`；失败、取消或 revision 失效时
一起回滚并撤销 lease。因此插件既不需要绕过 `FeatureContext` 读取凭据或检查点，也不能
用“正在 setup”取得对外副作用权限。

lease 自身只有三态，且不能由插件推进：

| lease state | Host 允许的行为 | 退出条件 |
|---|---|---|
| `provisioning` | 允许声明范围内、Host 审计的 config/secret/state bootstrap 读取；声明式注册与 state write 只进入 activation transaction。普通消息、service call、事件/callback delivery 及未声明/跨 namespace 访问拒绝 | activation 成功原子提交 transaction 并转 `active`；失败、取消或 revision 失效则回滚并转 `revoked` |
| `active` | 按绑定的 feature grants 使用 SDK surface，所有动作归入该 feature ledger | disable/revoke/update、package integrity 进入 `damaged` 或 reconnect 时先原子转 `revoked`，再执行 disposer |
| `revoked` | 所有新调用、迟到注册、事件/callback delivery 与凭据访问拒绝；仅允许 integrityEpoch 未被 quarantine 且持有效 settlement token 的历史 operation 在原 deadline 内幂等结算，不重新授权 | 终态；再次启用必须签发新 activation revision 的 lease |

lifecycle owner 唯一是 Host Broker/Manager；plugin callback、generic restore、迟到 disposer
或 payload identity 都不能直接改 lease state。完整转移表如下：

| 当前态 | Host 事件与 guard | 下一态 | 原子效果 |
|---|---|---|---|
| 无 lease | plugin 与 feature desired state 均 enabled，package materialization 为 `installed`、integrity 为 `verified`，且 package revision、grants、config readiness 校验通过 | `provisioning` | 签发新 activation revision 的 lease，固定 bootstrap snapshot，开启 activation transaction |
| `provisioning` | callback 成功，package integrity 仍为 `verified` 且 revision/grants 未变化 | `active` | 提交 staged registrations/state writes 后才开放 effect 与 delivery |
| `provisioning` | callback 失败、取消、disable/revoke/update、package integrity 进入 `damaged`、reconnect 或 revision 变化 | `revoked` | 回滚 transaction；不留下注册、写入、事件消费或外部副作用 |
| `active` | disable/revoke/update、package integrity 进入 `damaged` 或 reconnect | `revoked` | 先撤销 authority 并停止新 delivery，再运行 disposer；普通撤权的迟到完成只能结算旧 operation，integrity damage 则同时 quarantine 对应 integrityEpoch 的未结算 token |
| `revoked` | 任意新 plugin call、restore/reconcile、迟到 delivery 或无效 completion | `revoked` | 拒绝；仅 integrityEpoch 仍可信的有效 settlement-only completion 可落旧 operation ledger且不改变 lease/resource state；重新启用只能走“无 lease → provisioning”并签发新 revision |

- **INV-FA1 — authority 不可自选：** 每次 bootstrap/read/write/call/registration/delivery
  都从 Host ledger 解析 lease 主体；伪造或借用 sibling `featureId` 必须拒绝。
- **INV-FA2 — activation 原子：** `active` 与本次 registrations/staged state writes 同批可见；
  任一失败路径均全量回滚，不能产生半激活或 durable checkpoint 泄漏。
- **INV-FA3 — revoke 单调：** `revoked` 永不恢复，restore/reconcile 只能创建新 revision；
  旧 context、旧 callback 与旧 transaction 都不能复活资源。
- **INV-FA4 — integrity 闸住 authority：** package integrity 非 `verified` 时不得签发或维持
  `provisioning/active` lease；active tree 的 `verified → damaged` 不受 manager operation
  是否 idle 影响，必须抢占当前 operation，先撤销该 package 全部 feature authority、停止新
  delivery 并使 current fail closed，repair 成功也只能用新 activation revision 恢复。
- **INV-FA5 — integrity 也闸住 settlement trust：** ordinary revoke 可在 deadline 内接受绑定
  可信 integrityEpoch 的 settlement-only completion；active tree 损坏必须 quarantine 该 epoch
  的全部未结算 token，任何迟到 success 都不能抑制 retry/dead-letter。

状态按正交维度记录，避免线性状态机把不同事实混在一起：

- package materialization：`absent/staged/installed`
- package integrity：`unknown/verified/damaged`
- manager operation：`idle/installing/updating/repairing/uninstalling`
- config readiness：`incomplete/ready`
- plugin activation：`disabled/enabling/enabled/disabling/error`
- feature activation（逐 `pluginInstanceId + featureId + packageRevision`）：`disabled/enabling/enabled/disabling/error`
- runtime：`stopped/starting/healthy/degraded/crashed`
- 另存 trust tier、grants、health、rollback snapshot 与 Host-monotonic `integrityEpoch`

package integrity 的唯一 lifecycle owner 是 Host Manager；integrity verifier 只提交带
`treeRole`（`active` / `staging candidate`）、package revision、digest/provenance/trust evidence
的校验结果，由 Manager 对照 durable inventory 与 operation journal 推进下表。active tree
证据是高优先级安全事件，不能按普通并发 operation 排队或延迟到 update/repair 完成；staging
candidate 失败只处置候选与所属 transaction，不能把仍 verified 的 active tree 误标为 damaged。
repair 请求、generic restore、catalog refresh、plugin callback 或 runtime 自报都不能写回 `verified`。
它与 authority/runtime 的跨维度转移固定如下：

| 当前 integrity / operation | Host 事件与 guard | 下一态 | 原子效果与恢复边界 |
|---|---|---|---|
| `verified / idle \| updating \| repairing` | **active tree** 的 digest、provenance 或 trust 校验出现 mismatch | `damaged / idle` | 立即抢占当前 operation、丢弃未提交 staging，并在同一 durable transaction 中写入 `damaged`、撤销该 package 全部 feature lease、停止新 event/callback delivery、把 current 投影为 fail closed，同时 quarantine active integrityEpoch 的全部未结算 settlement token；随后停止或 quarantine runtime。operation 不得先完成，runtime 未停止/隔离前不得开始 repair |
| `verified / uninstalling` | active tree mismatch 到达；uninstall 已先进入 authority revoke 阶段 | `damaged / uninstalling` | 将 damage evidence 与 integrityEpoch/token quarantine 合入 uninstall journal并继续用户请求的删除；若 uninstall 失败或 rollback，只能回到 `installed / damaged / idle` 且无 authority，不能恢复旧 runtime |
| `unknown / installing` | staging candidate 校验 mismatch | `unknown / idle` | 拒绝安装并丢弃 staging；没有 active tree、lease 或 settlement 可撤销 |
| `verified / updating \| repairing` | staging candidate 校验 mismatch，active tree evidence 仍 verified | `verified / idle` | 中止当前 staging transaction；按既有 cutover boundary 保留未撤销的 active runtime，或在已撤权时用同一可信 active tree 的新 activation revision reconcile。不得 quarantine active integrityEpoch |
| `verified / idle` | 用户请求对仍 verified 的同版本 package 显式 repair | `verified / repairing` | staging candidate 与 active tree 分开验证；staging 期间 active tree 可继续服务，若需要 runtime cutover 则先 ordinary revoke 并用新 activation revision reconcile；任一 active-tree mismatch 由首行抢占 |
| `damaged / idle` | 用户或诊断请求同版本 repair，且 catalog/version/digest/trust policy 仍有效 | `damaged / repairing` | desired 与全部用户数据保持不变；无 runtime authority，旧 context 全部拒绝；只允许 staging 获取与校验 replacement tree |
| `damaged / repairing` | replacement tree 完整验证并完成原子 swap | `verified / idle` | 只有 swap 后才能按 desired 签发全新 activation revision 并 reconcile；旧 lease/revision 永不复用 |
| `damaged / repairing` | staging candidate mismatch，或获取、swap、restart recovery 失败 | `damaged / idle` | 丢弃 staging 并保持 authority/delivery/current fail closed；不得以 repair 失败为由恢复旧 runtime，旧 quarantined integrityEpoch 永不重新可信 |

`configured` 不是 `installed` 的下一站，`healthy` 也不等于 `enabled`。community 包默认 quarantine、显式审批、不自动 import；现有 F240 same-power 路径必须先被 Host Broker/runner 替代。

### 3.5 Host Broker 与插件 runtime 握手（P7、P11、P12、P15）

- 插件 manifest 声明 contract version、runtime entrypoint/transport、task/contribution、请求的 capabilities；声明只是请求，不是授权。
- Host Broker 启动或连接插件 runtime，完成 `pluginId + packageDigest + contractVersion + instanceId` 握手；所有身份字段由宿主绑定，插件自报值只作候选。plugin-level handshake 只建立 runtime 身份，不授予共享 effect authority；逐 feature grant 由 §3.4 的 Host-issued feature execution lease 承载。
- call/callback 统一使用 `requestId/operationId/deadline`；职责回调投递同时签发仅供该 operation 结算的 settlement token，ack 与动作结算写 feature-scoped durable ledger，重启后 reconcile。
- runtime 可是 standalone 壳、child process 或 builtin adapter；载体不同不改变 contract。builtin 也必须经过同一 broker 语义，但可使用 in-process transport 优化。
- Broker 的 capability 校验只是逻辑隔离，不等于 OS sandbox。同一用户权限下的普通 child process 仍可能读宿主文件；在可验证的 filesystem/network sandbox 落地前，community 可执行插件只能 quarantine + 明示 same-power 风险，不能因“已出进程”就自动升为安全。runner 默认最小 env/工作目录；多 feature 共享进程不得把 feature secret 批量注入进程环境，secret 必须经对应 `FeatureContext` 按 lease/grant 读取，或为需要进程级注入的 feature 启动独立 runtime。
- SDK client/runtime 在插件仓；Host Broker/Adapter 在内核仓；双方只依赖同一 `plugin-contract` 包。

### 3.6 数据、secret 与 migration（P3、P8、P9、P13）

- **config**：内核存，Settings 统一渲染；字段 schema 带版本，升级走 migration。
- **secrets**：内核按插件属主隔离并 0600/可选系统 keychain 存储。用户可在明确的 reveal/edit 操作中查看自己的 secret；默认遮罩，禁止把所有 secret 下发给通用 renderer、日志或其他插件。
- **state**：v0 以宿主 namespace KV 为默认且 TTL=0；schema/version/migration 属插件，宿主负责原子切换与失败回滚。需要自管文件时必须在 manifest 声明数据目录；插件不得在卸载流程回调中自行删除未声明数据。
- **卸载、重装与显式清除的内建 store 语义**：config、secrets 与 namespaced state 是 Host 管理的内建 store，不适用 manifest dataset 的三选一策略。fresh install 从空 store 开始；disable/enable、restart/reconnect 与 repair 都不得 detach 或清除它们，只轮换 runtime authority。uninstall 必须先撤销全部 feature lease、停止 runtime 并清除注册，再按 durable transaction 中已经解析的 data disposition 处置数据；插件 callback 不参与也不能扩大删除范围。每次 uninstall transaction 只要保留任一数据，就由 Host 签发一个 opaque、durable 的 **`detachedBundleId`**，并把它连同只读的 source pluginInstanceId、source packageRevision 与 createdAt 审计元数据写入本次所有 detached record/inventory entry；该 ID 只关联同一卸载快照，不授予 runtime authority。config 与 namespaced state 默认以 TTL=0 保留在不可被任何 plugin runtime 访问的 **detached Host-owned record**，只有用户在卸载确认或 Settings 的独立 clear 操作中明确选择才删除。secrets 在每次 uninstall 前必须由用户明确选择“保留供重装恢复”或“清除凭据”，删除选项不得预选；非交互调用未提供该选择时 uninstall fail closed，不能静默保留或删除。所有 detached record 必须按 bundle generation 在 Settings 可见、可审计、可逐 store 清除，不能成为无入口的永久凭据坟场。
- manifest dataset 必须有不可随显示名变化的 **stable datasetId**。uninstall journal 把每个 dataset 的 `detachedBundleId + pluginId + publisher identity + origin + datasetId + dataClass + policy + schemaVersion + contentDigest` 写入 **detached dataset inventory**：`lifecycle` 内容删除且不入 inventory，`retained` 必须进入，`ask-on-uninstall` 只在用户选择保留时进入。inventory 的唯一定位至少包含 `detachedBundleId + datasetId`，stable datasetId 不能跨 bundle generation 充当快照主键。inventory 与内建 store 的 detached record 同样只能由 Host/Settings 管理，package absent 时任何 plugin runtime 都不可读；新 manifest 未声明的旧 dataset 继续 detached、可见、可显式清除，不能被同名新数据集或 payload 自报 ID 自动认领。
- reinstall 始终创建 **fresh pluginInstanceId** 及全新的 lease、cursor 与幂等/结算账本空间，绝不复活旧 runtime authority。只有新 package 的 `pluginId + publisher identity + origin` 与 detached record/inventory 完全匹配，且用户显式选择 **恰好一个 `detachedBundleId` generation** 恢复时，Host 才能把该 generation 的旧 config/secrets/state 和同 stable datasetId 的 `retained`、已选择保留的 `ask-on-uninstall` datasets 作为同一 staging 输入；禁止跨两个 bundle 选择、拼接或用“最新一代”隐式替用户决定。dataset 的 dataClass/policy 必须兼容，schemaVersion 变化必须提供声明式 migration。Host 在 package/config/state/dataset migration 全部成功后才把选中 bundle 的可恢复内容原子绑定给新实例并从 detached inventory 移除已绑定条目；`lifecycle` 与新增 dataset 从空内容开始，未在新 manifest 存续的 dataset 仍以原 `detachedBundleId` 保持 detached，其他未选 generation 全部原样保留。不同 signer/origin 不得看见或认领旧数据。恢复失败时选中 bundle 的全部 detached snapshot 原样保留，新实例保持未配置、disabled，不能出现跨代混合、部分 dataset 可读、半绑定或旧新实例双读；成功激活后，fresh context 必须能按 grant 读取恢复后的 dataset，旧 context 继续 fail closed。
- explicit clear 是 Host 控制面的用户动作，可分别针对 config、secrets、namespaced state 或单个 stable datasetId，已安装与 detached 两种记录都必须支持；`retained` 只禁止生命周期隐式删除，不得阻止用户主动 clear。对已安装实例，Host 先撤销能访问目标的 lease、停止 delivery、在 journal 中原子清除所选 store/dataset，再用新 activation revision reconcile；clear config 使 readiness 回到 `incomplete`，clear secrets 立即撤销对应凭据访问，clear state 删除完整 namespace/checkpoint，clear dataset 删除其内容但不改写 manifest declaration/policy。detached clear 必须以 `detachedBundleId + store kind` 或 `detachedBundleId + datasetId` 定位并同批删除对应 record/inventory entry，不能误清同 stable datasetId 的其他 generation；bundle 最后一项被清除后才移除其 generation 元数据。失败或 crash 必须回滚到清除前 snapshot；clear 不删除审计/transaction ledger，也不能由插件自行调用或伪装成 uninstall/repair/update 的副作用。
- **数据处置策略声明制（开发者声明，不转嫁用户）**：插件在 manifest 里按数据集声明三选一——①`lifecycle`：随插件生命周期，卸载即清除 ②`retained`：由宿主统一管理、永不随卸载消亡（静态配置与运行数据可分别声明）③`ask-on-uninstall`：卸载时由用户选择保留/清除。开发者按数据性质选策略，用户只在 ③ 或显式清除入口做决定。
- **dataClass 约束（宿主可验证，策略的前置分类）**：每个数据集必须先声明 `dataClass: cache/ephemeral | user-authored/derived-user-visible | relationship/interaction-history`。**只有 cache/ephemeral 类允许 `lifecycle`**；用户可见/可恢复预期的数据强制 `retained` 或 `ask-on-uninstall`；**关系与记忆类数据（relationship / 对话衍生记忆 / interaction-history——即使不直接展示）同样只能 `retained | ask-on-uninstall`，插件不得声明为 `lifecycle`**——互动痕迹属于用户与猫的共同历史，不因插件卸载而蒸发。用户状态默认持久化、删除只能用户 opt-in 是硬边界，开发者声明不能越过它。宿主对 dataClass 与策略组合做安装期校验，不合法组合拒绝安装。
- **repair 不触发卸载处置**：完整性检测把已启用 package 标为 `damaged` 时，必须先按 §3.4 的 integrity 转移撤销整包 authority、停止 delivery/runtime 并使 current fail closed，不能等 repair 开始或成功后才隔离。同版本 repair 只允许在该 fail-closed 状态替换损坏的 package tree，必须保留 config、secrets、state 与 manifest 声明的每个数据集；`lifecycle`、`retained`、`ask-on-uninstall` 三种策略在 repair 中一律不执行删除。成功只从 verified replacement tree 签发新 activation revision；失败/crash 继续保持 damaged 且无 runtime authority。数据处置只能由独立的 uninstall 或显式清除操作按上述策略推进。
- **update 是版本化数据事务**：Host 先在 staging 验证新 package 与 migration plan，以旧版本 config/state snapshot 为输入生成 staged migration output；secrets 和 `lifecycle`、`retained`、`ask-on-uninstall` 全部数据集默认原样保留，只有声明了版本迁移的数据结构可由 migration 改写。plugin 总闸与新旧 manifest 中同 ID feature 的用户 desired activation 携带到新 package revision；任何 current activation 都不复制，必须按 v2 grants/config 与新 activation revision 重新 reconcile，新增 capability 未获批时保持 fail closed。新 ID 默认 disabled，删除的 ID 不创建 v2 activation/lease，feature ID 变化按“删除 + 新增”处理而不自动继承；仅修改 name/description 必须保留稳定 ID。成功时 package tree、inventory version、迁移后的 config/state、plugin/feature desired projection 与新 activation revision 原子切换，旧 runtime 在新 runtime 可见前退出。失败或 crash/restart 分两类收敛：**切换边界前**若旧 lease/runtime 从未撤销，则丢弃 staging 并保持原 v1 current/revision；**切换边界后**一旦旧 lease 已撤销或 runtime 已退出，就只恢复旧 package、旧数据 snapshot 与 v1 desired projection，绝不恢复或复用旧 current/activation revision，而是签发全新的 rollback activation revision 重新 reconcile。后一分支中的旧 v1 context 与失败 v2 attempt 的 context 均继续 fail closed；两类分支都不得暴露 old/new 双 runtime、半迁移数据或触发 uninstall 处置。
- **闭环后 memory 域约束**：插件默认仅自己 namespace 读写；跨 namespace 检索如被真实消费者证明必要，只能走宿主中介、purpose-scoped 的独立授权；全局写入走内核蒸馏晋升，不直接写。该条不构成当前 v0 API。
- **猫的私密空间为 dataClass 级排除（非授权级）**：记忆数据模型预留 `visibility: normal | cat_private` 维度（作为需求提给 #1047 的数据模型，P8）；任何未来宿主中介检索都**硬排除 `cat_private`**——即使用户授权检索，猫的主体性数据（私人日记/私人时间痕迹）也不经插件通道暴露，除非猫侧主动策展公开。"猫把日记给你看"与"插件替猫翻日记"是两件事，前者是产品机制，后者结构性不可达。
- 每个能力域开放前必须列出存量数据 mapping + migration + rollback；本轮不为旧接口留 adapter，但不能丢旧消息、配置、binding、schedule 或 plugin state。

### 3.7 UI Contribution：两类形态（P5、P7、P13）

前台猫与插件配置管理正好代表两个方向，分开设计：

**A 类：In-console contribution（宿主渲染，声明式）**——插件在 Console 已有组件语言内补充入口，参考 IDE 插件模式（安装后出现对应管理菜单/按钮/页签）。**v0 只定机制骨架，slot 随首验插件逐个开放**（P1/P4）：每开一个 slot 先审该点位数据形状（P5），不预开清单。

机制骨架三件（全部有 IDE 界多年验证的先例）：

1. **锚点组位置模型**（IntelliJ Action Group / VS Code menus 同款）：宿主维护**锚点组注册表**（如 `composer.actions`、`nav.sections`、`message.toolbar`、`thread.panels`），插件 contribution 只能以 `{ group, anchor?: before|after <id>, order? }` 挂进已知组——**布局结构（栏/区/分割）宿主独有，插件永远只是组里的条目**。"整体布局不让插件随便改"由此机制化：允许调整的位置 = 注册表里有的组，调整程度 = 组内排序与显隐，仅此而已。
2. **command 间接层联动模型**（VS Code contribution points 的核心设计，PyCharm Action System 同理）：UI 元素**不直接绑代码，绑 `command` id**——manifest 声明 command，插件 runtime 注册 handler；用户点击 → 宿主捕获 → Host Broker 路由（capability 校验 + trace + ledger，即 callback 通道的 `onCommand` 类型）→ 插件执行 → 可选 UI 反馈。按钮的可见/可用由声明式 `when` 条件驱动（v0 只支持 capability/feature 状态级条件，不做完整表达式语言）。
3. **settings 不开自定义**：插件配置页由 config schema 自动生成（现有 connector/plugin 配置模式的延续，已足够通用）；插件最多声明字段分组/描述/顺序，不提供自定义 settings UI——省掉一个高成本低收益且样式易失控的扩展点。

- **声明式 + 宿主渲染**：contribution 是数据，不是插件自带 DOM/iframe——样式语言天然一致，主题/无障碍/布局由宿主统一保证。不受信插件的自由 UI（iframe 沙箱）不进 v0。
- **capability-gate 原生集成**：contribution 挂在 feature 上；只有 plugin 与 feature
  都启用且 grants 满足才装配。由此"默认折叠/关闭、启用才出现"不是独立的前端改造
  工程，而是**存量功能插件化收编的自动副产品**——Train B 的 voice-suite acceptance
  必须证明 ASR/TTS 分别启停时，按钮、消息元素和 runtime 注册同步生灭。
- slot 开放节奏跟随首验：voice-suite 开 `composer.actions` + 消息元素渲染；GitHub 视需要开 `nav.sections`；每次开放走 Console 既有 Design Gate 流程。

**B 类（闭环后候选，不属于当前 v0）：独立窗口 contribution（插件自有 surface）**——
插件拉起独立于主窗口的原生窗口（桌宠在桌面游走、未来的视频/语音实况交互窗）。
下列内容是 foreground-cat 开启该域时必须验证的设计约束，不是 Train B contract/SDK
surface：

- manifest 声明 `windows[]`；宿主 SDK 提供窗口生命周期与属性（create/show/hide · frameless/transparent/always-on-top/skip-taskbar），**窗口内容完全属于插件**（自选技术栈，P7 壳无关在 UI 层的体现）
- **窗口生命周期独立于主窗口**：主窗口最小化/收进托盘后，已启用插件的窗口继续存活——"桌宠在桌面上玩"的技术前提；具体行为逻辑在插件实现内
- **窗口状态上报义务（presence handover 的契约前提）**：`windows[]` 声明的每个窗口在握手后向 broker 状态面上报 `created/visible/hidden` + **续租式存活**（§3.2a liveness 契约的窗口形态：窗口侧仅发送 authenticated renewal，`lastSeen` 由 Broker 收包盖钟、`leaseExpiry` 由 Broker 按协商 TTL 计算；lease 过期即视为离线，不存在一次性 `alive` 布尔）——宿主 presence 逻辑据此实现"同一只猫同一时刻只有一个主身体"（桌面身体上线时，Hub 内同猫退化为指示器）。P11 在 UI surface 的自然延伸
- B 类是高敏 capability（可绘制于用户桌面任意位置）：按信任分级授权，创建/常驻状态在控制面可见可关（P13）
- 首个消费者：foreground-cat（desktop-pet-surface）；probe-desktop 的授权状态浮窗同属此类

分工含义：A 类 slot 体系随 Console 属内核仓；B 类窗口 runtime 属插件仓 standalone 壳（issue #1 底盘范围），内核只提供窗口 API 薄层与授权控制面。

### 3.8 首验覆盖与执行顺序（P4、P14）

1. **Contract conformance fixture + loopback plugin（M0）**：验证握手、grants、message.publish/append、ack/ledger、崩溃隔离；且必须含 **host+SDK 共跑的对抗矩阵（fail-closed 断言，全集）**：actor 伪造、system audience 伪造、任意 whisper target 伪造（超出 grant 允许集）、裸/越权 thread 寻址、state namespace escape（跨实例访问）、provenance 升级（inference→user_intent）、denied grant 调用、重复 idempotencyKey/operationId、deadline expiry（超时调用的结算与拒绝）、职责 callback retry/dead-letter 路径、断线后 cursor 续投 + 消费幂等（含 ack 前崩溃重投）、retention 越界的 stale 订阅追平、卸载后 retained/ask 类 durable state 不丢失、**P14 断言：第一方插件与第三方走同一 SDK 入口/同一授权流**、插件崩溃不拖垮宿主；**事件输入面四项**：undeclared/forbidden-class signal 发布拒绝、producer 伪造与认识论升级（observation→user_intent）拒绝、插件自报 wake route target 拒绝、lease 过期后 offline 判定生效。它是测试夹具，不是产品插件。
2. **Train B 真实消费者矩阵**：product-neutral fixture 之外，必须在隔离 acceptance
   环境用真实 Feishu、GitHub、MCP、voice-suite 与至少一个 IM provider slice 覆盖
   lifecycle/feature activation/messaging/config/state/secrets/scheduler/MCP/service/connector/UI；
   Manager lifecycle journey 必须包含已启用 package 的损坏注入，并证明 integrity 进入
   `damaged` 的同一 durable transition 已撤销整包 lease、停止 delivery/runtime 且 current
   fail closed，再开始同版本 repair；repair 失败/crash 不得复活旧 authority，成功只能从
   verified replacement tree 用新 revision 恢复。旅程还覆盖两版本 update migration、
   crash recovery、并发 operation 串行化，以及 config/secrets/state 与全部声明数据集（覆盖
   `lifecycle`、`retained`、`ask-on-uninstall`）在 repair/update 中按声明迁移或守恒；
   voice-suite 必须独立切换 ASR/TTS，并证明 Host-issued feature execution lease 绑定所有
   SDK effect：撤销 TTS 后旧 TTS context 的新调用、注册、事件/callback delivery 与 secret
   访问均被拒绝；撤权前已投递 callback 只能凭 settlement token 在 deadline 内幂等落账，
   不得产生新 effect。ASR context 仍可工作，且 ASR/TTS 使用相同 idempotencyKey 或
   operationId 时各自得到独立 ledger/receipt；slice 不提前切换生产默认路径。
   具体矩阵与关闭条件见 roadmap §5。
3. **Train C 全量存量迁移**：按 roadmap §6 的冻结 inventory 迁移 GitHub、
   video-analysis/video-gen、weixin-mp/wechat-visible-reader、全部现有 IM provider 与全部具体
   managed service；不是抽样迁移。Host 保留通用控制面，删除已迁移业务实现与第二入口。
4. **闭环后能力扩张**：foreground-cat 首先验证第一方同通道与 B 类 UI surface；
   memory/thread 则分别等待自己的真实消费者、权限/数据形状审查与独立验收，不能由
   foreground-cat 一次性代验；windows/presence 等其余能力同样按真实消费者成组开放。

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
2. 高敏能力不止闭环后的 thread/memory：当前凡读消息内容者（事件订阅、`onMessage`）也均按 scope 授权；v0 不设 hook 类接口——`input.pre` 与 `output.message.augment` 都没有不可替代消费者，TTS 类异步增补由"事件订阅 + `appendElements`"覆盖。
3. 生命周期方向不是“service manifest 泛化成万能引擎”，而是 F202 控制面 + 分类型 resource adapter + 正交状态投影。
4. contract schema 在插件仓单一真相，Host 实现在内核仓；双签的是 contract PR，不是两仓各写一份接口。

**对 issue #1 的回应结构**：
1. **确认接受**：四件共签框架、五条不让步项（P10 为其一的正面确认）、底盘自治分工。
2. **回答 issue 请 mindfn 侧定的三件事**：①壳选型——契约壳无关（P7），底盘实现选型自治决定；探针与桌面猫第一版共壳、契约层保持两个独立 plugin identity；②探针首版感知集合——Tier 0/1 起步（前台应用 + 文件打开；全局手势进 M1 再议），权限逐级单独授权；③评审形式——issue 异步批注为主 + 四件共签一次同步会收口。
3. **新增提议，待共同确认**：`plugin-contract` 包作为唯一机器真相源 + contract PR 双方 CODEOWNER 共签；M0 = Host Broker/standalone runtime + loopback messaging 纵切（GitHub 作为随后 schedule/state 首个真实插件，非 M0 唯一验证器）；调用结算语义（ack/ledger/重启 reconcile）进契约 v0。
