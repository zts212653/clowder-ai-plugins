---
title: Clowder 插件体系：设计原则与 v0 方案
status: draft-for-discussion (v0)
discussion: zts212653/clowder-ai-plugins#1
created: 2026-07-12
revised: 2026-09-01
feature_ids: [P-1, F202, F237, F240]
topics: [plugin-contract, plugin-sdk, host-broker, plugin-manager, contribution-plane]
doc_kind: governing-design
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
`v0-implementation-roadmap.md` 持有。2026-09-01 operator 将终态进一步收敛为：M0 收口 →
Train B 一次交付静态 YAML、公共 SDK/Contribution、机器 catalog、终态 Manager/Marketplace/
Agent/UI 骨架与 `video-analysis` 首迁纵切（不切生产路径）→ Train C 用 Plugins 单一聚合 PR
迁移其余 IM、GitHub、业务插件和具体服务，再由 Core 单一聚合 PR cutover 并删除旧实现/旧 IM
管理入口 → 完成 install/configure/enable/use/restart/disable/uninstall 狗粮 → 开发者文档闭合 →
contract/SDK `0.1.0` 正式发布 → foreground-cat/windows/memory 等后续扩张。M1 的
“打开文件→猫跑过来→问要不要总结”目标保留，但不再作为与底座/存量收编并行的排期承诺。

### 2.3 两仓职责划分（本阶段核心产出）

**clowder-ai（内核仓）——改什么**：
1. 按本阶段能力域收敛接口（§3.2）：Host 侧真正的同义平行实现只按三个底层服务收口——
   F139/F202/猫 MCP/SDK schedule 归一到 Scheduler，Hub/ConnectorRouter/SDK 消息写入归一到
   MessageIngress，ConnectorDefinition 硬编码与动态 identity 归一到 IdentityRegistry。
   `plugin.yaml` 的 `type: mcp | skill | limb | schedule` 仍是正确的能力分类，Host 按 type
   分发到对应子系统，不合成一个万能 ToolRegistry；同一 capability type 若同时提供 YAML 静态
   与 SDK 动态注册，两路才共享底层 store、ledger 与 lifecycle。state namespace KV、
   signals/events 与 UI contribution 继续按域开放。memory/thread 是 Train C 闭环后的高敏候选域，
   不进入当前 v0 contract/SDK
2. 插件控制面与 Host Broker：F202 继续做统一编排，Core 只持有通用的时间/持久化/重试、
   HTTP ingress、IdentityRegistry、direct-tool registry、MCP runtime、skill registry、limb control
   plane、授权 binding 和分类型 resource adapter；
   GitHub poll/review 解析、IM 路由/回推、具体 service 等业务实现全部在插件侧，不把
   `ScheduleFactoryRegistry`、`ConnectorRouter` 或 provider-specific handler 当作终态 Host API
   （§3.4/§3.5）
3. 输出事件流：带单调 sequence/cursor 的 message 事件订阅 + `appendElements` 增补通道（覆盖 TTS 类异步增补）；hook 点位 v0 不开放，机制方向保留（F237 输入侧同构），M1 有真实同步需求再按 P5 逐个评审
4. 控制面：Train B 即交付 VS Code 式 Marketplace/Installed/Details/Settings 终态骨架；
   Console 与 Agent 投影同一 Host inventory。Agent 公共工具固定为 `plugin_list`、
   `plugin_search`、`plugin_get`、`plugin_install`、`plugin_set_enabled`、`plugin_uninstall`，
   不开放 `plugin_update`、`plugin_repair` 或 `updateAvailable`。Train C 只接入迁移 contribution
   并删除 IM connector 旧管理面，不再发明第二套 Marketplace；capability-gate 前端装配、审计/trace
   仍由 Host 拥有
5. SDK Host Adapter（鉴权、授权、调用结算、callback/事件调度）随内核发版；插件进程 runtime/client 在插件仓

**clowder-ai-plugins（公开插件仓）——做什么、怎么管**：
1. **契约机器真相源**：`@clowder-ai/plugin-contract`（envelope/event/manifest JSON Schema + TS 类型 + capability 表 + conformance fixtures；hook 表 future-reserved 不进 v0 包）；文档从 schema 生成或校验，不在内核仓复制定义（P15）
2. **SDK 与插件 runtime**：客户端库、握手/传输实现、standalone 壳 runtime；版本随 contract package
3. **插件脚手架与模板**：create-clowder-plugin 级别的起步体验（P14 的开发者体验面）
4. **业务插件与参考插件**：GitHub、现有 IM providers、voice-suite、Feishu、
   probe-desktop、foreground-cat；schedule handler、tool handler、webhook/长连接协议适配、
   thread 选择与外部回推均随对应插件发布，不在 Core 留业务副本
5. **开发者入口与准入管理**：manifest 规范、SDK API reference、教程/模板、机器可读
   catalog index、proposal-first、签名/digest，以及针对当前 Host contract suite 的插件 CI。
   catalog 是插件仓的发现/发布真相，artifact 内 `plugin.yaml` 始终是静态接入协议；Host 安装后
   的 inventory、integrity、grants、config/auth、desired/current 与 runtime health 是本机真相，
   任何 catalog、插件进程、Console 或 Agent 都不得维护第二份 inventory

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

- 外部 ingress 在绑定 thread 前先带 `sourceAddress(connectorId/chatId/messageId)`；插件负责
  按自身业务规则选择一个已授权的 `ThreadHandle`/`ConnectorBindingRef`，Host 的通用 binding
  adapter 只负责签发/解析句柄、actor/provenance 校验与 canonical admission，不知道“飞书群该进
  哪个 thread”或“GitHub review 推给谁”。**Draft 的寻址只能使用宿主签发的
  `ThreadHandle`/`ConnectorBindingRef`**——schema 层面即不存在“自报裸 threadId”的通道。
- **audience 两态**：Draft 侧 `draftAudience` 仅 public/whisper（whisper 目标限于 grant 允许集）；canonical `audience` 由宿主派生，`system` 只能由宿主产生——插件无法借草稿伪装系统消息。
- `derivedFromElementId` 指向稳定的 `elementId`；增补元素由宿主校验并原子 append，不能改写原文，也不能把 `inference` 提升为 `observation/user_intent`。
- **幂等分层（账本键写实）**：send 幂等账本键 = `(pluginInstanceId, featureId, idempotencyKey)`；append 幂等键 = `(pluginInstanceId, featureId, messageId, operationId)`；events.publish ledger key = `(pluginInstanceId, featureId, idempotencyKey)`。其中 `featureId` 必须由 Broker 从 Host-issued feature lease 绑定，不能采信 payload 自报值；同一 feature 重试返回同一 receipt，而 sibling feature 使用相同业务键时必须进入彼此独立的 ledger entry。插件间互不干扰、重装实例也不复用旧键空间。`baseRevision` 做并发冲突检测；`sourceEventId` 仅是外部 provenance。delivery ack/重试进入同一 feature-scoped ledger，不污染内容模型。
- **单一消息写入口**：Hub UI、迁移期 Connector Gateway 与 Plugin SDK 最终都调用同一个
  Host-owned canonical admission；不同来源只通过 Host 验证后的 `source/actor` 投影区分，不能
  各自维护一套消息落库/广播/唤醒逻辑。插件可提交外部 sender metadata，但 plugin/feature
  identity 必须从 execution lease 与 identity registry 绑定，不能由 payload 冒充。
- outbound 收敛：`sendReply/sendRichMessage/sendMedia` → `messaging.send(draft)`，返回宿主
  receipt/messageId（同 idempotencyKey 重试返回同一 receipt）；平台降级（卡片→纯文本、media
  fallback）、监听哪些已绑定 thread 以及怎样回推外部平台由 connector 插件负责。迁移完成后
  `OutboundDeliveryHook` 不再是第二条业务通道，等价能力由授权的 message subscription callback
  驱动。

### 3.2 能力域与收敛单位（P4）

域是渐进单位，**不是一条不可调整的全局瀑布顺序**。跨域执行顺序由 roadmap 持有；
选中某域时必须把该域的数据结构、call/callback/事件、权限、持久化、migration 与测试
一起收敛。当前基础平台 v0 的公开域边界是：

- **messaging**：canonical envelope + ingress binding + 单一 send/appendElements admission +
  带 filter/opaque cursor 的输出事件订阅；静态 binding 与 SDK 动态 subscription 最终都产生
  Host-owned、lease-scoped subscription，职责 callback/ack 语义一致
- **schedule**：manifest/YAML 可静态声明，SDK 可动态注册；两者归一到
  `{owner lease, stable name, schedule, action:{method, params}, policy}`。`action.method` 是
  Broker 可回调的插件 entrypoint token，不是跨进程传递的 JS closure；宿主持有时间、持久化、
  重试与 settlement，插件持有 task 实现及触发后向哪个授权 thread 发消息的业务决策。Core 不再
  持有 GitHub/IM 特定 schedule factory
- **identity**：manifest 可声明稳定展示身份，SDK 可注册运行期展示 contribution；Host 从
  package/instance/feature lease 绑定真实 owner，再投影 name/icon/color，payload 自报 identity
  不能升级 actor authority
- **tool/MCP/limb**：插件可声明独立 MCP server，或用 SDK 注册
  `{name, description, inputSchema, handler}` 的直接 tool contribution；普通 tool 经 Broker callback，
  Host 对外暴露的 canonical tool ID 默认带 package/feature namespace，未限定 alias 只能经显式
  policy 分配；物理设备 action 仍走 limb 的 Registry/Policy/Lease/ActionLog，不因都叫 tool 而
  绕过物理安全边界
- **webhook/inbound endpoint**：manifest/YAML 与 SDK 都可声明受限 path/method/handler；Host
  将相对 path 挂入 Host 分配的 plugin-instance namespace，禁止占用 Core/admin/其他插件 route；
  通用 edge 只负责限流、body budget、route ownership 与 secret-reference 验签适配，provider
  challenge/signature 语义和消息转换在插件 callback 内，禁止 manifest 内嵌明文 secret
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

**v0 明确不造**：stream delivery（无真实消费者；未来经握手 `supportedDeliveryModes` 声明取交集、随新 contract version 进入——不用 enum 预留位，追加枚举值对旧 validator/exhaustive union 是 breaking）；通用 discover/query_manifest 动词（callable 能力披露走各 resource 面，"谁在线"归 Broker registry 内部语义）；统一 heartbeat 动词（liveness 按 runtime 类型拆）；**通用 signal-ingress** 的任意动态 `subscribe()/unsubscribe()`（没有当前消费者）。该排除不适用于 messaging output subscription：IM 出站回推已经是当前真实消费者，必须按 §3.1/§3.3 的 lease、filter、callback、cursor、ack 与撤销语义进入 v0。

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
  scheduler.register/unregister({name,schedule,action})
  identity.register/unregister(display contribution)
  tools.register/unregister({name,inputSchema,handler})
  webhooks.register/unregister({path,methods,handler,verificationRef})
  messaging.send(draft)
  messaging.subscribe/unsubscribe({address,filter,callback})
  messaging.appendElements(messageHandle, elements[], operationId)【需订阅 grant，异步增补通道】
  events.publish(declaredSignal)

callback（内核→插件）:
  onLifecycle(init/enable/disable/shutdown)
  onTask(name,payload)【职责】 · onToolCall(name,input)【职责】
  onWebhook(route,request)【职责】 · onMessage(envelope)【职责】
  onEvent(event, cursor)【通知；含 message.publish/append 订阅，凭游标续读】
```

上表只描述 wire 形状，不定义授权主体。除 runtime bootstrap/health 与 plugin 总闸
lifecycle 外，所有 effect-bearing call、resource callback 与 event delivery 都必须由
§3.4 的 Host-issued feature execution lease 绑定；payload 中的 `featureId` 仅可用于一致性
校验，不能选择或升级 authority。SDK 可以用闭包包装 developer experience，但 wire/manifest
只冻结 callback method token 与可序列化 params；`pluginId`、`featureId` 和 identity owner 均由
Host context 注入，不要求插件在每个注册 payload 中重复自报。

Train B 的插件作者层还必须提供 roadmap §5.1 冻结的类型化 contribution facade：
`featureCtx.scheduler`、`featureCtx.identity`、`featureCtx.tools`、`featureCtx.mcp`、
`featureCtx.webhooks`、`featureCtx.messaging.subscribe`、`featureCtx.services`、
`featureCtx.connectors`、`featureCtx.ui`，以及
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
  ├─ IdentityResourceAdapter  → Host-authenticated display/source projection
  ├─ ToolResourceAdapter      → direct tool registry / Broker callback
  ├─ WebhookResourceAdapter   → generic HTTP edge / route lease / callback
  ├─ MessageResourceAdapter   → canonical admission / subscription / cursor
  ├─ ServiceResourceAdapter   → 复用 service manager / deep health
  ├─ ConnectorResourceAdapter → generic binding / transport contribution
  ├─ ScheduleResourceAdapter  → TaskRunner / durable schedules
  ├─ HookResourceAdapter      → future-reserved（随 M1 hook 点位评审，非 v0 构成）
  └─ UiContributionAdapter    → slot/capability/renderer policy
```

这些 adapter 只拥有通用 authority 与 resource lifecycle。GitHub poll/review parsing、
PR/issue tracking tool、IM provider protocol、thread 选择、外部平台回推与具体 service 实现
全部在插件进程；Core 中现存的业务 factory/router/hook 只是 Train C 前的兼容路径，不是可冻结
的插件 API。同一 capability type 的静态 manifest 与动态 SDK 注册必须进入同一个 type-specific
adapter/registry，不能形成两套 owner、冲突、dispose 或 restart 语义；不同 type 按图中的
分类型 adapter/control plane 分发，不因共享生命周期 envelope 而合成一个 registry。

**manifest 的 feature 聚合与 activation**：一个插件可含多个"能力"（feature = 基于
mcp/skill/limb/schedule/sdk 资源组合成的一个完整用户可感知能力，如 github 插件的
"PR 追踪"= schedule + mcp tool + UI 入口）。manifest v0 按
`features[{id, name, resources[], capabilities[]}]` 组织，feature 是一等公民。Train B
用 product-neutral conformance 同步交付 feature-level activation；Train C 再由真实 voice-suite
证明用户可独立启用 TTS 或 ASR。不能先展示 feature、却只允许整包启停。

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

这里的 `updating/repairing` 是 Host 内部 package transaction/integrity 状态，不构成 public
Agent/Marketplace surface，也不进入 Train B 稳定旅程。公共控制面仍严格限定为 §2.3 的六个工具；
damage 由 Host fail closed 并给出可操作状态，不能伪装成 `updateAvailable` 提示。

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
- **卸载、重装与显式清除的内建 store 语义**：config、secrets 与 namespaced state 是 Host 管理的内建 store，不适用 manifest dataset 的三选一策略。fresh install 从空 store 开始；disable/enable、restart/reconnect 与 repair 都不得 detach 或清除它们，只轮换 runtime authority。uninstall 必须先撤销全部 feature lease、停止 runtime 并清除注册，再按 durable transaction 中已经解析的 data disposition 处置数据；插件 callback 不参与也不能扩大删除范围。任何 durable detach generation 只要保留任一数据，就由 Host 签发一个 opaque、durable 的 **`detachedBundleId`**。bundle metadata 写 `bundleKind: update-holding | uninstall-snapshot`、只读的 source pluginInstanceId、createdAt；每个 detached record/inventory entry 另写表示首次脱离原因的不可变 `sourceOperation: uninstall | update`、source packageRevision 与原数据 metadata。`uninstall-snapshot` 还写入有序、去重的 `absorbedDetachedBundleIds`，被吸收的 bundle 反向写一次性的 immutable `absorbedByDetachedBundleId`。child 可以是 update-holding，也可以是一次部分恢复后仍有残留的旧 uninstall-snapshot root；这些 Host-issued 边必须组成无环、单父的**递归 logical restore closure**，深度不固定为一层。Host 必须按 committed inventory 迭代遍历并对 bundleId 去重，不能依赖递归调用栈。lineage 只用于审计、Settings 嵌套展示与幂等 restore，不授予 runtime authority；entry 保留首次所在 bundle 的 exact key，**不 re-key** 到新 root，也不允许用户在 restore 时临时拼 bundle。top-level root 在任一时刻只能是 absent 状态下独立可选，或通过 Host-issued `restoreCarryOwnerPluginInstanceId` 独占绑定一个已安装 fresh instance，不能同时可选又被 carry；carry 只保留下一次卸载的 lineage continuity，不授予 runtime 数据访问权。uninstall snapshot 可同时包含内建 store 与 dataset；update-holding bundle 只包含因新版本清单不再接纳而脱离的 dataset。config 与 namespaced state 在 uninstall 时默认以 TTL=0 保留在不可被任何 plugin runtime 访问的 **detached Host-owned record**，只有用户在卸载确认或 Settings 的独立 clear 操作中明确选择才删除。secrets 在每次 uninstall 前必须由用户明确选择“保留供重装恢复”或“清除凭据”，删除选项不得预选；非交互调用未提供该选择时 uninstall fail closed，不能静默保留或删除。所有 detached record 必须按 logical generation 在 Settings 可见、可审计、可逐 store/entry 清除，不能成为无入口的永久凭据坟场。
- **restore carry 生命周期**：disable/enable、restart/reconnect、repair 与 update 都必须原样保留 `restoreCarryOwnerPluginInstanceId`，不得重绑、复制或把 residual 暴露给 runtime；只有 closure 被 explicit clear/restore 排空，或该 owner instance 的 uninstall 在同一 commit 把 root 变成新 snapshot child 时才能清除 carry binding。
- manifest dataset 必须有不可随显示名变化的 **stable datasetId**。uninstall journal 把每个 dataset 的 `detachedBundleId + sourceOperation + pluginId + publisher identity + origin + datasetId + dataClass + policy + schemaVersion + contentDigest` 写入 **detached dataset inventory**：`lifecycle` 内容删除且不入 inventory，`retained` 必须进入，`ask-on-uninstall` 只在用户选择保留时进入。update journal 则把被移除、stable ID 更换，或在 dataClass/policy/schemaVersion 上无法被 v2 声明与 migration 兼容接纳的旧 dataset 连同原声明元数据写入 `sourceOperation=update` 的同类 inventory；update 本身不执行三种 uninstall policy。inventory 的唯一定位至少包含 `detachedBundleId + datasetId`，stable datasetId 不能跨 bundle generation 充当快照主键。inventory 与内建 store 的 detached record 同样只能由 Host/Settings 管理；detached 内容在 package installed/absent 两种状态下都不可被任何 plugin runtime 读取，但必须在 Settings 可见、可审计、可按精确 key 显式清除。新 manifest 未声明的旧 dataset 继续 detached，不能被同名新数据集、后续 package 或 payload 自报 ID 自动认领。
- **update-holding / restore carry 到 uninstall snapshot 的 lineage 收口**：Plugin Manager 在卸载 disposition census 中必须同时枚举当前 attached stores/datasets、**same pluginInstanceId** 的全部 standalone update-holding entries，以及至多一个由上次成功部分恢复绑定给该 instance 的 carried source root。Manager 只对本次 attached 内容与 standalone U 按原 policy 处置：`lifecycle` 删除，`retained` 保留，`ask-on-uninstall` 纳入本次用户选择；carried closure 已由更早一次卸载完成处置，除非用户走 explicit clear，否则本次卸载不得重新解释其 policy 或隐式删除。若当前保留内容、非空 U 或 carried closure 任一非空，整个 uninstall 只签发一个新的 `bundleKind=uninstall-snapshot` root B：在同一 durable commit 中把本次 attached 保留内容写入 B，把非空 U 和 carried source snapshot A 都作为 immutable child 加入 B 的 `absorbedDetachedBundleIds`，写各自一次性的 `absorbedByDetachedBundleId=B`，并清除 A 的 `restoreCarryOwnerPluginInstanceId`。A 的既有 descendants 与所有 entry exact key、首次 `sourceOperation`、source packageRevision、dataClass/policy/schemaVersion/contentDigest 保持不变，由 B 递归可达；不得为压平深度而 re-key 或改父。普通 uninstall 绝不吸收其他 instance 的独立历史 snapshot；唯一例外是该 instance 的 durable carry edge 明确绑定的 A。成功后不得残留 same-instance standalone U 或 carried root，Settings 只把 B 作为 top-level generation，递归嵌套展示/精确 clear A 及其 descendants。失败/crash 只能收敛到“installed + 原 standalone U + carried A、无 B”或“absent + 完整 B closure、无 standalone U/carry”，重试必须复用 journal operation/bundle ID，不能重复生成 B、丢 entry、形成环/多父边或 split lineage。
- reinstall 始终创建 **fresh pluginInstanceId** 及全新的 lease、cursor 与幂等/结算账本空间，绝不复活旧 runtime authority。只有新 package 的 `pluginId + publisher identity + origin` 与 detached record/inventory 完全匹配，且用户显式选择 **恰好一个 top-level `bundleKind=uninstall-snapshot` 的 `detachedBundleId` generation** 恢复时，Host 才能把 A 的 direct records 和 Host-declared recursive `absorbedDetachedBundleIds` closure 中实际存在的旧 config/secrets/state 与 datasets 作为同一 restore input；standalone update-holding 或 carry-bound root 不作为独立 reinstall input。禁止用户跨两个 top-level snapshots 选择、临时拼 arbitrary bundle-set 或用“最新一代”隐式替自己决定。dataset 的 stable ID/dataClass/policy 必须兼容，schemaVersion 变化必须提供声明式 migration。Host 在创建 migration staging 前必须先按 stable datasetId 枚举 A closure 的完整候选集：A direct 与任意深度 descendant 中实际存在的 entry 都是候选，精确键统一为 `(entry.detachedBundleId, datasetId)`；Settings 从 committed inventory/lineage 与待安装的 verified manifest/migration plan **纯投影**每项的 compatibility/migration eligibility 与原 provenance，不另存一份会漂移的 candidate list。当同一 ID 的原始候选多于一项时，用户必须在 eligible candidates 中显式选择至多一个 exact candidate；未选择时该 ID 默认不恢复，Host 不得猜“当前”“最新”或偏向任一 generation。restore journal 在 staging 前冻结所选 A、完整 closure/inventory revision、verified package revision 与 exact candidate keys，Plugin Manager 在同一 transaction 中重新验证每个 key 仍属于 A closure、仍 eligible 且同 ID 未多选；restore 与 concurrent clear/uninstall 串行，stale/foreign/ineligible/duplicate selection 或 package revision 漂移一律在消费任何 entry 前 fail closed，crash retry 复用 journal 中同一选择。只有选中的 candidate 才进入 migration staging，未选或不兼容的 entry 保持原 key/lineage detached；单一 candidate 仍走普通 compatibility/migration 路径。Host 在 package/config/state/dataset migration 全部成功后先计算 **restore yield**；yield 以将要新绑定的 durable store record 或 dataset inventory entry 数量计，不以 payload 字节数计。只有至少一项实际绑定的 **positive-yield** restore 才能原子提交 fresh instance、移除已绑定条目，并从被排空的 leaf 向 root 逐级同批删除 reciprocal edge 与空 bundle metadata。此时若 A closure 仍有任何未选、不兼容或未迁移 record，restore commit 必须把残留 A root 原子标为 `restoreCarryOwnerPluginInstanceId=freshInstanceId`，使其从 absent/top-level selectable 转为 installed-carried、在下一次 uninstall 被收口；若 closure 全空则删除 A metadata，不创建 carry。若内建 stores 已被显式清空且所有剩余 dataset 都不兼容或未选择，导致没有任何 durable record 可绑定，则是 **zero-yield**，不是成功恢复：transaction 必须以 typed `no_compatible_restore_input` 在 fresh instance/package activation 与 carry commit 前 fail closed，丢弃 staged instance，保持 package absent、A closure 原样 top-level selectable 且不写 `restoreCarryOwnerPluginInstanceId`，允许用户改用 later compatible verified package 重试或另走不选择 A 的 fresh install。`lifecycle` 与新增 dataset 只在 positive-yield restore 提交后随 fresh instance 从空内容开始，其他未选 top-level generations 全部原样保留。不同 signer/origin 不得看见或认领旧数据。恢复失败时选中 logical generation 的完整 closure 原样保留且仍 top-level selectable；一般 migration/commit 失败至多留下未配置、disabled 的 staged/新实例，而 zero-yield 不得提交任何新实例，均不能出现跨代混合、部分 dataset 可读、半绑定、carry 泄漏或旧新实例双读；成功激活后，fresh context 只能按 grant 读取已绑定 dataset，carried residual 对该 runtime 仍不可读，旧 context 继续 fail closed。
- explicit clear 是 Host 控制面的用户动作，可分别针对 config、secrets、namespaced state 或单个 stable datasetId，已安装与 detached 两种记录都必须支持；`retained` 只禁止生命周期隐式删除，不得阻止用户主动 clear。对已安装实例，Host 先撤销能访问目标的 lease、停止 delivery、在 journal 中原子清除所选 store/dataset，再用新 activation revision reconcile；clear config 使 readiness 回到 `incomplete`，clear secrets 立即撤销对应凭据访问，clear state 删除完整 namespace/checkpoint，clear dataset 删除其内容但不改写 manifest declaration/policy。detached clear 必须以 `detachedBundleId + store kind` 或 `detachedBundleId + datasetId` 定位递归 closure 中的 exact entry，并从 leaf 向 root 同批删除变空节点的 reciprocal edge/metadata；不能误清同 stable datasetId 的其他 generation。carry-bound root 也只能通过这个 Settings 路径清理，和 restore/update/uninstall journal 串行；若 closure 排空，必须同批清除 `restoreCarryOwnerPluginInstanceId` 与 root metadata，已安装实例本身继续存在。失败或 crash 必须回滚到清除前 snapshot；clear 不删除审计/transaction ledger，也不能由插件自行调用或伪装成 uninstall/repair/update 的副作用。
- **数据处置策略声明制（开发者声明，不转嫁用户）**：插件在 manifest 里按数据集声明三选一——①`lifecycle`：随插件生命周期，卸载即清除 ②`retained`：由宿主统一管理、永不随卸载消亡（静态配置与运行数据可分别声明）③`ask-on-uninstall`：卸载时由用户选择保留/清除。开发者按数据性质选策略，用户只在 ③ 或显式清除入口做决定。
- **dataClass 约束（宿主可验证，策略的前置分类）**：每个数据集必须先声明 `dataClass: cache/ephemeral | user-authored/derived-user-visible | relationship/interaction-history`。**只有 cache/ephemeral 类允许 `lifecycle`**；用户可见/可恢复预期的数据强制 `retained` 或 `ask-on-uninstall`；**关系与记忆类数据（relationship / 对话衍生记忆 / interaction-history——即使不直接展示）同样只能 `retained | ask-on-uninstall`，插件不得声明为 `lifecycle`**——互动痕迹属于用户与猫的共同历史，不因插件卸载而蒸发。用户状态默认持久化、删除只能用户 opt-in 是硬边界，开发者声明不能越过它。宿主对 dataClass 与策略组合做安装期校验，不合法组合拒绝安装。
- **repair 不触发卸载处置**：完整性检测把已启用 package 标为 `damaged` 时，必须先按 §3.4 的 integrity 转移撤销整包 authority、停止 delivery/runtime 并使 current fail closed，不能等 repair 开始或成功后才隔离。同版本 repair 只允许在该 fail-closed 状态替换损坏的 package tree，必须保留 config、secrets、state 与 manifest 声明的每个数据集；`lifecycle`、`retained`、`ask-on-uninstall` 三种策略在 repair 中一律不执行删除。成功只从 verified replacement tree 签发新 activation revision；失败/crash 继续保持 damaged 且无 runtime authority。数据处置只能由独立的 uninstall 或显式清除操作按上述策略推进。
- **update 是版本化数据事务**：Host 先在 staging 验证新 package 与 migration plan，以旧版本 config/state snapshot 为输入生成 staged migration output；secrets 原样保留，manifest dataset 则由 Plugin Manager 对 v1/v2 声明逐项决定唯一归属。stable datasetId、dataClass 与 policy 兼容，且 schemaVersion 未变或声明式 migration 成功的 dataset 原子绑定到 v2；v2 移除或改换 stable ID、声明不兼容，或声明比较阶段没有可用 migration 时，旧字节不得删除或悬空，而是连同原 metadata 原子移入一个 Host-issued `bundleKind=update-holding` detached bundle，v2 的新增/替代 dataset 从空内容开始。已经选中的 migration 若执行失败，必须使整个 update 失败并恢复 v1，不能降级成空 v2 dataset。update 不执行 `lifecycle`、`retained`、`ask-on-uninstall` 的 uninstall policy；后续 uninstall 才按上一条 lineage 收口规则处置并 link same pluginInstanceId 的 update-detached U。runtime 只能读取 v2 当前 manifest 已绑定的 dataset；update-holding 内容不能被 runtime、后续 package 或 reinstall 隐式认领，只能由 Settings 显式 clear，或在该实例后续 uninstall 时原子进入唯一 uninstall snapshot closure。

  plugin 总闸与新旧 manifest 中同 ID feature 的用户 desired activation 携带到新 package revision；任何 current activation 都不复制，必须按 v2 grants/config 与新 activation revision 重新 reconcile，新增 capability 未获批时保持 fail closed。新 ID 默认 disabled，删除的 ID 不创建 v2 activation/lease，feature ID 变化按“删除 + 新增”处理而不自动继承；仅修改 name/description 必须保留稳定 ID。成功时 package tree、inventory version、迁移后的 config/state、dataset binding、完整 detached bundle/inventory、plugin/feature desired projection 与新 activation revision 在同一 durable transaction 原子切换，旧 runtime 在新 runtime 可见前退出。失败或 crash/restart 分两类收敛：**切换边界前**若旧 lease/runtime 从未撤销，则丢弃 staging 并保持原 v1 current/revision；**切换边界后**一旦旧 lease 已撤销或 runtime 已退出，就只恢复旧 package、旧数据 snapshot、v1 dataset binding 与 v1 desired projection，绝不恢复或复用旧 current/activation revision，而是签发全新的 rollback activation revision 重新 reconcile。后一分支中的旧 v1 context 与失败 v2 attempt 的 context 均继续 fail closed；两类分支都不得暴露 old/new 双 runtime、半迁移数据、orphan bytes 或 partial inventory，并且必须满足 **no partial or duplicate detached bundle**。

**update dataset 归属矩阵（Plugin Manager 是唯一 lifecycle writer）**：manifest 是 v2 声明真相源，Host-owned dataset store 是字节真相源，attached/detached inventory 是 runtime 可读性与 Settings 管理入口的真相源；plugin migration 只产生 staging output，不能自行 bind、detach、clear 或签发 bundle。

| v1 dataset 与 v2 声明关系 | staging 决议 | 成功 commit 后唯一归属 | 失败/crash |
|---|---|---|---|
| 同 stable ID，dataClass/policy 兼容，schema 不变 | 保留原 bytes | attached to v2；runtime 可按 fresh grant 读取 | 完整恢复 v1 binding |
| 同 stable ID，兼容且声明 migration | 执行 migration | migration 成功才 attached to v2 | migration 失败使整个 update 失败；不创建 bundle |
| v2 移除/更换 ID，或同 ID 声明不兼容且无可用 migration | 保留原 bytes 与原 metadata | 进入本次 `bundleKind=update-holding, sourceOperation=update` bundle；runtime 不可读、Settings 可见/可清 | 完整恢复 v1 binding；不创建 bundle |
| 仅 v2 新增 ID | 创建空 dataset | attached to v2，初始为空 | 不创建 v2 dataset |

**detached lineage 真相源矩阵**：

| 数据 | 真相源/唯一写者 | 消费方 | 派生与级联规则 |
|---|---|---|---|
| bundle kind、source instance、absorption/carry lineage | Plugin Manager durable operation journal | recovery、audit、Settings | inventory 只从已提交 journal 投影；retry 复用 operation/bundle ID；carry owner 与 absorbed parent 互斥 |
| store/dataset bytes 与原 policy/schema metadata | Host-owned store/dataset repository | migration staging、uninstall disposition、explicit clear | plugin 只能经 fresh lease 访问 attached bytes，不能改 lineage |
| entry 当前归属（attached/standalone U/top-level closure/carry-bound closure/deleted） | Host attached/detached inventory + Host lineage edges | runtime authorization、Settings list/clear、reinstall staging | journal commit 原子切换 logical membership；每个 child 单父，root 只能 top-level selectable 或 carry-bound 二选一 |
| reinstall 可恢复集合 | 用户选择的单一 top-level uninstall snapshot recursive closure + verified manifest | Plugin Manager restore transaction | 至少一项 durable record 实际绑定才提交 fresh instance；positive-yield 的残留 root 原子 carry-bound，zero-yield 则 typed fail closed、A 保持 top-level selectable |

**detached bundle 状态×事件矩阵（Plugin Manager 是唯一 lifecycle owner）**：generic restore、package callback、payload 自报 ID 与 Settings list 都不得 re-key、吸收或组合 bundle；Settings clear 只能删除精确 entry，不能创建 lineage。

| 当前状态 | 事件 | 原子成功终态 | 失败/crash 终态 |
|---|---|---|---|
| installed + 零或多个 same-instance update-holding U | explicit clear `U + datasetId` | 只删除目标 entry；U 排空才删 generation metadata | U 与 entry 原样保留 |
| installed + 零或多个 same-instance standalone U、无 carry | uninstall | 原 policy 删除/询问/保留；当前 stores/datasets 直接写唯一 A，非空 U 原子 link 为 A child | installed + 原 standalone U、无 A |
| absent + top-level A recursive closure | 用户选择恢复 A 并提交 exact candidate keys；至少一项 durable record 可绑定 | restore journal 冻结 A/closure inventory/package revision/keys；同 ID 在完整候选集中显式至多选一，仅选中且复验 eligible 的 entry 绑定 fresh instance；positive-yield 的非空 residual A 原子写 `restoreCarryOwnerPluginInstanceId` | stale/foreign/ineligible/duplicate key、package revision 漂移或任一失败均使 A closure 原样 top-level selectable；新实例未配置、disabled |
| absent + top-level A recursive closure；built-in stores 已清且剩余 dataset 全部不兼容/未选择 | 用户提交恢复 A，但零条 durable record 可绑定 | typed `no_compatible_restore_input`；在 fresh instance/package activation 与 carry commit 前终止，package 仍 absent，A closure 原样 top-level selectable、无 carry | 同成功终态；retry 复用或终止 journal 均不得创建 instance/carry、消费 entry 或改变 A revision |
| installed + carried A root + 零或多个 same-instance standalone U | uninstall | 新建唯一 B；当前保留内容为 B direct，U 与 carried A 原子成为 B children，清 A carry owner；A descendants 原样递归可达 | installed + carried A root + 原 U、无 B，或 absent + 完整 B closure；禁止 split lineage |
| uninstall commit 已落盘 | restart/retry | absent + 完整 root closure；journal 重放同一 root 与同一 `absorbedDetachedBundleIds` | 不得把 child 改回 standalone/carry、创建第二 root、环、多父边或重复 entry |
| absent 或 installed-carried recursive closure，任意 descendant 非空 | clear exact entry | 只删 exact entry；从 leaf 向 root 原子删空节点/reciprocal edge，closure 全空才删 root/carry owner | closure 与 entry 原样保留，无 dangling edge |
| absent + top-level A recursive closure，同 ID 存在任意深度多候选 | 用户选择恢复 A 并提交 exact candidate keys | restore journal 冻结 A/closure inventory/package revision/keys；同 ID 在完整候选集中显式至多选一，仅选中且复验 eligible 的 entry 进入 staging；未选项仍留 A；最终 commit 仍须通过 INV-DL11 restore yield gate | stale/foreign/ineligible/duplicate key、package revision 漂移或任一失败均使 A closure 原样保留；新实例未配置、disabled |
| absent + 多个互不 carry-related 的 top-level snapshots A/B | 用户选择恢复 A | 只枚举 A recursive closure 并按上一行处理 collision；positive-yield 时兼容/迁移成功项绑定、未选/未接纳项 carry-bound 给 fresh instance，B 不变；zero-yield 时 A/B 均保持 top-level selectable 且不提交 instance/carry | A/B closures 全部原样保留；新实例未配置、disabled |

可测试不变量：

- **INV-DL1（单一逻辑归属）**：每个 store/dataset entry 恰好处于 attached、standalone U、一个 top-level/carry-bound recursive closure 或 deleted 之一；bundle child 单父，root 的 top-level selectable、`restoreCarryOwnerPluginInstanceId` 与 `absorbedByDetachedBundleId` 三态互斥；inventory/graph uniqueness 断言。
- **INV-DL2（同实例收口）**：成功 uninstall 后，same pluginInstanceId 的所有非空 U 与该 instance 唯一 carried source root 都只由新 root 的 recursive closure 可达；update→partial restore→uninstall journey 断言。
- **INV-DL3（跨实例隔离）**：收口不得修改或吸收其他 pluginInstanceId 的独立历史 uninstall snapshots；只有 durable carry edge 绑定给当前 instance 的旧 source root 可进入新 root；A/B generation journey 断言。
- **INV-DL4（单 root 恢复）**：reinstall 只接受用户选择的一个 top-level uninstall snapshot recursive closure，拒绝 standalone/carry-bound child 与 arbitrary bundle-set；negative restore fixture 断言。
- **INV-DL5（crash 原子性）**：首次 uninstall 的 crash point 只可见 installed + 完整 standalone U 或 absent + 完整 A closure；carry-forward uninstall 只可见 installed + carried A + 完整 U 或 absent + 完整 B closure。journal retry 不生成第二 root/lineage edge；fault-injection matrix 断言。
- **INV-DL6（provenance 与显式删除）**：link 不改 entry key、首次 sourceOperation/source revision/original metadata；clear 只命中 exact bundle + entry key 且不抹 audit ledger；inventory/audit fixture 断言。
- **INV-DL7（图引用完整性）**：每个 parent→child 都有 child→parent reciprocal pointer，child 只能一个父；图无环且可从唯一 root 对每个 bundle 恰好访问一次。clear/restore 排空节点时从 leaf 向 root 同批删双向边，recursive closure 全空才删 root/carry owner；graph referential-integrity/deep-chain/fault-injection 断言。
- **INV-DL8（同 ID 候选完备）**：A recursive closure 中某 stable datasetId 的原始候选全集恰好覆盖 root direct 与任意深度 descendant entry；多候选时 selector 以 `(entry.detachedBundleId, datasetId)` 唯一标识 eligible candidate，至多选一且零选择不恢复，只有选中项进入 staging，未选项保持原 key/lineage detached；cross-depth collision journey 断言。
- **INV-DL9（选择有栅栏）**：candidate list 只从 committed inventory/lineage 与 verified manifest/migration plan 纯投影；restore journal 在 staging 前冻结 A/inventory/package revision/exact keys，和 clear 串行且每次重试复用同一选择；stale/foreign/ineligible/duplicate key 或 package revision 漂移在消费 entry 前拒绝；revision-race/crash-retry/adversarial key fixture 断言。
- **INV-DL10（部分恢复 lineage continuity）**：成功的 positive-yield restore 若仍有 residual，必须在绑定至少一项 durable record 的同一 commit 将 source root 独占 carry-bound 给 fresh instance；该 instance 下一次 uninstall 必须把 carried source root 与本代数据收进唯一新 root。任意代数重复 partial restore→uninstall 后，用户始终只选一个 top-level root 就能枚举最新 attached generation 与全部历史 residual，不能产生 sibling top-level split；multi-generation partial-restore continuity journey 断言。
- **INV-DL11（restore yield gate）**：restore commit 必须证明至少一项 Host-owned durable store record 或 dataset inventory entry 实际绑定；built-in stores 已清且 dataset 全不兼容/未选择的 zero-yield 输入只能返回 `no_compatible_restore_input`，不得提交 fresh instance、carry、entry consumption 或 lineage revision，source root 始终保持 top-level selectable；zero-yield/crash-retry journey 断言。

既有正确行为保护点：

| 行为 | 必须保持 | 保护方式 |
|---|---|---|
| 两个互不 carry-related 的已完成 uninstall generations A/B | 互不拼接、互不改写，用户只选一个；被 restore carry 绑定的 A 不再算独立 top-level generation | 既有 A/B reinstall journey + INV-DL3/DL4 |
| update cutover | attached/U disposition 与 package switch 原子，失败完整回 v1 | 两版本 update crash journey + INV-DL1/DL5 |
| explicit clear | 精确删除 installed/detached 单项，不误清同 ID 另一代 | 既有 clear journey + INV-DL6 |
| reinstall authority | fresh pluginInstanceId/lease/cursor/ledger，旧 context fail closed | 既有 post-reinstall readability/adversarial context journey |
| root/任意 descendant 同 ID | 不偏向深度或 generation；用户可精确选择任一 eligible candidate，未选则都不恢复；stale/越界选择不消费数据 | cross-depth collision journey + INV-DL8/DL9 |
| partial restore 后再次 uninstall | residual source root carry 到 fresh instance，并进入下一 root；不会与最新 generation 分裂成两个 top-level snapshot | multi-generation continuity journey + INV-DL10 |
| zero-yield restore | 不把“什么都没恢复”提交成 fresh instance/carry；source snapshot 仍可被 later compatible package 直接重试 | zero-yield restore journey + INV-DL11 |
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
  都启用且 grants 满足才装配。Train B 的 conformance 必须证明声明式 contribution 与 runtime
  注册同步生灭；Train C 的 voice-suite 再证明 ASR/TTS 独立启停时对应按钮和消息元素同步生灭。
- slot 开放节奏跟随真实迁移：Train B 先交付终态骨架和确定性 fixture；Train C 随 voice-suite
  开 `composer.actions` + 消息元素、GitHub 视需要开 `nav.sections`。每次开放走 Console 既有 Design Gate。

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

1. **Contract conformance fixture + loopback plugin（M0，已关闭）**：Core PR #1410 已用
   contract beta.12 / SDK beta.8 在真实 Host seams 完成 18/18（9 wire / 3 admission / 1 delivery /
   5 Host-control）；签名 `execution.method` 是唯一 dispatch truth。它仍是回归夹具，不是产品插件。
2. **Train B terminal foundation + one real slice**：product-neutral conformance 覆盖全部 v0
   machine schema、YAML/SDK contribution、feature authority、static/dynamic equivalence、dispose、
   restart 与 fail-closed；隔离 acceptance 只首迁真实 `video-analysis` package，证明 machine
   catalog list/search/get、packed-artifact install、静态 `plugin.yaml`、config/secret、direct
   tool/MCP 与 install→configure→enable→use→restart→disable→uninstall。Console/Agent 同时交付
   §2.3 的终态骨架和六个固定工具。该 slice 不替换 Core 生产默认路径；internal update/repair
   状态机不构成公共工具或本列车稳定 gate。具体关闭条件见 roadmap §5。
3. **Train C 全量存量迁移**：按 roadmap §6 的冻结 inventory 迁移 GitHub、
   video-analysis/video-gen、weixin-mp/wechat-visible-reader、全部现有 IM provider 与全部具体
   managed service；不是抽样迁移。Host 保留通用控制面，删除已迁移业务实现与第二入口。
4. **闭环后能力扩张**：foreground-cat 首先验证第一方同通道与 B 类 UI surface；
   memory/thread 则分别等待自己的真实消费者、权限/数据形状审查与独立验收，不能由
   foreground-cat 一次性代验；windows/presence 等其余能力同样按真实消费者成组开放。

GitHub 是 schedule/state 的真实验证器，但不反向重开已关闭的 M0。Train B 不能只靠通用
fixture：还必须有 `video-analysis` 的 packed-artifact 纵切；其余公开 surface 的真实业务
package 证据在 Train C 冻结 inventory 中一次补齐。

旧版“收编线/体验线并行，M1 排期不等待收编”的安排已被 2026-08-23 operator 改序、
并由 2026-09-01 的终态 Manager/Marketplace/Agent、单一首迁纵切与 Train C 全量聚合迁移
进一步收敛。
这些变化不撤销 M1 产品目标，也不降低 P4/P14：foreground-cat
将来仍必须走同一公开 SDK/授权路径并完成真实纵切验收；在 Train C 闭环前只保留需求
与设计输入，不进入实现关键路径。

### 3.9 已收敛结论与回应结构

**本轮已收敛**：
1. MessageEnvelope 需要 actor、稳定 elementId、causation/correlation、外部幂等键；异步 TTS 通过 `message.elements.append` 事件，不重发整个 envelope。
2. 高敏能力不止闭环后的 thread/memory：当前凡读消息内容者（事件订阅、`onMessage`）也均按 scope 授权；v0 不设 hook 类接口——`input.pre` 与 `output.message.augment` 都没有不可替代消费者，TTS 类异步增补由"事件订阅 + `appendElements`"覆盖。
3. 生命周期方向不是“service manifest 泛化成万能引擎”，而是 F202 控制面 + 分类型 resource adapter + 正交状态投影。
4. contract schema 在插件仓单一真相，Host 实现在内核仓；双签的是 contract PR，不是两仓各写一份接口。
5. manifest/YAML 与 SDK 在表达同一 capability type 时是静态/动态入口，共享 type-specific
   store、owner lease、ledger 与 disposer；`mcp/skill/limb/schedule` 的协议分类继续保留。
   当前 Host 平行实现的收敛对象只有 Scheduler、MessageIngress 与 IdentityRegistry，
   `register_tool` 是 direct-tool SDK surface，不是把 MCP/skill/limb 合成一个 ToolRegistry 的理由。
6. Host 只持有通用 control/authority plane：具体 GitHub/IM/service 逻辑、thread routing 与平台
   回推在插件侧；Hub、兼容期 Gateway 与 Plugin SDK 的消息写入最终收敛到一个 canonical admission。

**对 issue #1 的回应结构**：
1. **确认接受**：四件共签框架、五条不让步项（P10 为其一的正面确认）、底盘自治分工。
2. **回答 issue 请 mindfn 侧定的三件事**：①壳选型——契约壳无关（P7），底盘实现选型自治决定；探针与桌面猫第一版共壳、契约层保持两个独立 plugin identity；②探针首版感知集合——Tier 0/1 起步（前台应用 + 文件打开；全局手势进 M1 再议），权限逐级单独授权；③评审形式——issue 异步批注为主 + 四件共签一次同步会收口。
3. **新增提议，待共同确认**：`plugin-contract` 包作为唯一机器真相源 + contract PR 双方 CODEOWNER 共签；M0 = Host Broker/standalone runtime + loopback messaging 纵切（GitHub 作为随后 schedule/state 首个真实插件，非 M0 唯一验证器）；调用结算语义（ack/ledger/重启 reconcile）进契约 v0。
