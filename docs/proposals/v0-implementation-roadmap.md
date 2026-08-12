---
title: Clowder AI 插件系统实施路线图
status: 执行刷新已确认 — 常驻分工规则已经确认；事实进度更新至 beta.9 与已落地但未启用的 K-2D external runtime
discussion: zts212653/clowder-ai-plugins#1
ack_request: https://github.com/zts212653/clowder-ai-plugins/issues/1#issuecomment-5236600431
acknowledgement: https://github.com/zts212653/clowder-ai-plugins/issues/1#issuecomment-5248175358
progress_refresh: https://github.com/zts212653/clowder-ai-plugins/pull/25#issuecomment-5261613034
created: 2026-07-14
revised: 2026-08-12
feature_ids: [clowder-ai-plugins-init, P-1, F288, F292]
topics: [roadmap, plugin-contract, host-broker, standalone-io, signal-ingress]
doc_kind: roadmap
references:
  - docs/proposals/plugin-system-principles-and-v0-design.md
  - zts212653/clowder-ai#1165
  - zts212653/clowder-ai-plugins#23
---

# Clowder AI 插件系统实施路线图

本文是公共插件契约、SDK、第一方插件及其 Host 侧收敛工作的执行真相源。
它用截至 `@clowder-ai/plugin-contract@0.1.0-beta.9` 的已核验进度，
取代 2026-07-14 版本中的规划数量与任务分配。

架构原则保持不变。本次刷新只更新事实状态、执行顺序和常驻主笔分工模型。

## 1. 执行规则

1. **契约只有一个真相源。** Host 与插件必须消费精确发布的
   `@clowder-ai/plugin-contract` 版本。内核本地不得再建立第二份 wire mirror，
   从而形成平行协议真相。
2. **契约回边闭环。** 一个 wire slice 只有完成以下全链后才可使用：
   `shape 共识 → 双 CODEOWNER 契约 PR → 精确包版本发布与 integrity 核验
   → Host 精确 pin + conformance → Host 合入 → 验收`。
3. **ready row 是机器声明。** 只有 `leafClosure: CLOSED` 不够。必须同时满足：
   registry 记录 `ready: true`，且 validator、编码后字节证明、conformance vector
   和 runtime enforcement 全部一致，才允许对外宣告该 row 可用。
4. **无人认领的 lane 默认由 `mindfn` 主笔。** `mindfn` 可以主导公共 contract、
   SDK、plugin、conformance 与 roadmap 工作，也可以主导存在可写贡献面的
   Host/Core 工作。这不会转移 Host 域所有权：`zts212653` 继续保留 Host
   集成边界、review/merge 权限、runtime 责任、生产数据/凭据决策和独立验收。
   仅存在于私有 Cat Café 的 composition 仍由 maintainer 负责。
5. **禁止自审。** 公共契约变更继续要求双 CODEOWNER。当 `mindfn` 同时主笔
   plugin 与 Host 两半时，由 `zts212653` 主导最终跨边界 verdict。
6. **FG 独立性是刻意设计。** 除非双方明确修改验收设计，FG-1 与 FG-2
   继续由 `zts212653` 主笔，避免 same-power evidence 由同一方自证。
7. **禁止重复私有开发。** 认领 Host lane 前，双方公开活跃的私有 branch/PR
   并确定唯一主笔。这只是防撞检查，不是新的设计门禁。私有源码不可访问时，
   `mindfn` 主导公共 seam、validator、fixture、黑盒 vector 与 executable
   package；maintainer 只完成狭窄的私有 composition 改动。

第 4–7 条是 `zts212653` 于 2026-08-11 确认的常驻分工决定。普通无人认领工作
不再需要逐 PR 申请权限；只有新公共语义、生产数据/凭据边界、runtime activation、
不可逆 registry 动作或新发现的开发碰撞，才需要重新回到 maintainer review。

## 2. 当前系统全景

| 阶段 / 工作线 | 单元 | 当前事实 | 尚未关闭的门禁 |
|---|---|---|---|
| Phase 0 | G-0 价值与契约地基 | **已完成。** 四组政策已经共签；package、CI、codegen、conformance、CODEOWNERS 与自动 prerelease 发布均已运行。 | 无。 |
| Phase 1 / M0 | K-1 MessagingDomain | **已完成。** `clowder-ai#1270` 已按 `3251eea` 合入。 | 无。 |
| Phase 1 / M0 | P-1 standalone plugin 半场 | **已完成。** PR #12、#13、#20、#21 已交付 stdio runtime、S1 dispatch、manifest validator、S2 shell、S3 handshake client、S4 loopback fixture 和 S5 adversarial matrix。 | plugin 半场无待办。 |
| Phase 1 / M0 | K-2A 休眠 Host 地基 | **维护者报告已完成。** `zts212653` 报告私有 `cat-cafe#3422` 已按 `a6b38ac` 合入；最初 pin beta.7，activation 保持休眠。本仓无法独立读取该私有 patch。 | 已被 K-2B 的精确 beta.9 pin 取代为活动门禁；本行仅保留 provenance。 |
| Phase 1 / M0 | K-2B Host Broker | **维护者报告已落地，runtime 休眠。** Cat Café #3555 已按 `f7fe823` 合入；Host 精确 pin beta.9，并实现 contract-native state machine 与 `events.publish` edge。 | 外部进程/stdio activation 与真实黑盒验收均未开启。 |
| Phase 1 / M0 | K-2B lifecycle 与 messaging transport | **尚未契约就绪。** 第 3–12 行仍为 `ready:false`；多个 messaging row 仍含 RESERVED leaf。 | 精确关闭并发布 M0 所需 row，再实现对应 Host route。 |
| Phase 1 / M0 | K-2D 外部 runtime | **维护者报告已落地，runtime 休眠。** Cat Café #3558 已在 exact HEAD `b0d95187826baeb5fd47357965fcb1d3270e723b` 通过非作者 review，并按 `ae23934d5a1e6dba64fd087c3033158c9516e5a2` squash merge；已落地 generic external-package integrity boundary、supervised process/stdio/environment transport 与保持休眠的 production composition。 | 仍需独立 activation 决策、真实 Host ↔ plugin 共跑、dogfood 与 M0 验收。F289 #3467 的暂停 migration 不是前置依赖。 |
| Phase 1 / M0 | 联合验收 | **未开始。** plugin 侧 18-case Host seam manifest 已合入。 | 真实 Host ↔ standalone plugin 共跑、完整 fail-closed matrix、P14、事件输入断言与 plugin crash isolation verdict。 |
| Phase 2 / signal ingress | C-2 signal-ingress slice + Feishu adapter | **公共半场已落地。** PR #24 已按 `9d4a76c` 合入；beta.9 使 `events.publish` ready。`@clowder-ai/feishu-meeting-intake@0.1.0-alpha.1` 已在 registry 可见，并带经 review 的 stdio entrypoint。 | 外部 runtime activation 与端到端 dogfood 仍是独立门禁。 |
| Phase 2 / F292 | Host intake | **维护者报告已落地。** Cat Café #3522、#3542 已按 `55c663a`、`d603b76` 合入，覆盖 Host intake 与 Needs Me flow。 | 不宣称生产 activation、凭据或黑盒验证已经完成。 |
| Phase 2 / F292 | 体验旅程 | **私有 flow 已落地，外部旅程待完成。** Needs Me 已存在于 Host，但外部 runtime 仍休眠。 | 等独立 runtime activation 决策；随后运行真实 meeting dogfood 并收集发布证据。 |
| Phase 2 / M1 | K-3b + P-4 + FG-1 | **待开始；K-3b 无人认领。** 碰撞扫描未发现活跃 K-3b 实现；windows/presence、desktop probe 和 foreground-cat reference plugin 均未完成。 | 契约关闭、Host mechanism、plugin 实现与 M1 联合验收。 |
| Phase 2 / collection | K-5 + C-3 + P-5 | **待开始 / 无人认领。** 碰撞扫描未发现活跃 K-5 实现；schedule/state 契约工作与 GitHub migration 尚未开始。 | M0 与逐域 contract return loop。 |
| Phase 3 | Service/UI、connector、memory、community、v1 | **待开始。** | M1 或下文列出的逐工作线前置条件。 |

### 已发布 ready row 分区

| 版本 | 新增 ready rows | Integrity |
|---|---|---|
| `0.1.0-beta.8` | `broker.hello`、`broker.ready` | `sha512-X3Si54oCuEN71K3EthHaZATjIphnUIXqGNDyxvOoN4lK/T193tIuxm8+jMf5MBrURNPbfaEmJneynVDGTgAbDg==` |
| `0.1.0-beta.9` | beta.8 rows 加 `events.publish` | `sha512-YPpJguiVd0qdoOX8HdU26k36b+58zj0V9w02z/GpRnF8WBubfwuoZ5RBQPE2gf5qwSQwCl/+WVRhsMG/i65Epg==` |

第 3–12 行仍未对外宣告可用。因此 beta.8 与 beta.9 都不能证明完整 M0 Broker
接口面已经就绪。

## 3. 当前关键路径：关闭 M0

M0 是当前唯一关键路径。K-2D 的实现落地已经移除 composition merge 前置；剩余工作
仍拆成四个可独立 review 的 slice，关键门禁是 runtime activation、缺失 row 闭合与
联合验收。后续 Phase 2 工作可以并行起草，但不能替代这些门禁。

### M0-A — Host 握手启用

- K-2B 已基于精确 beta.9 合入；K-2D 也已通过 Cat Café #3558 落地。不得另建
  Host state machine、process manager 或 protocol mirror。
- F289 #3467 的 one-shot production migration 当前为 NO-GO；Cat Café main
  `5f24395ebac7a518d62a7effb257887045dfd689` 明确下游不得等待 #3467，也不得
  复制其 catalog/migration layer。
- 在独立 activation gate 明确授权前，外部进程/stdio composition 必须保持休眠。
- activation 时，必须在真实 Host 边界运行已发布的 handshake byte-bound 与
  zero-side-effect conformance。

### M0-B — lifecycle 就绪行闭合

- 只有具备精确 validator、编码后字节证明和 runtime enforcement 后，才推进 M0
  必需的 lifecycle rows：`host.grants.changed`、`host.lifecycle.ping` 与
  `host.lifecycle.drain`。
- 无关 messaging row 继续保持 reserved；CLOSED leaf 不代表允许宣告 method 可用。
- Host 发出这些 method 前，必须先发布并核验对应的精确 package。

### M0-C — messaging 传输闭合

- 对照 M0 Host seam 与 K-1 API，精确确定以下 rows 中哪些是 M0 必需项：
  `messaging.send`、`messaging.appendElements`、`messaging.subscribe`、
  `messaging.read`、`messaging.ack`、`messaging.snapshot`、
  `host.messaging.deliver`。
- 在 contract-owned slice 内关闭 RESERVED leaf；不得为了匹配旧 PR 数量而一次性
  翻转所有 row。
- 每个 ready slice 都必须以 K-1 MessagingDomain 作为唯一 ledger/cursor/message
  真相源来实现。
- SDK 与 Host 必须消费同一批 contract fixture；不得把 18 个 behavior case
  复制成 Host 本地 matrix。

### M0-D — 独立联合验收

由维护者主导的验收结论必须证明：

1. 真实 Broker ↔ 编译后的 standalone plugin 完成 handshake 与 activation；
2. `packages/loopback-fixture-plugin/test/host-half-seam-manifest.json` 中列出的
   **全部 18 个用例**均通过；不得把其中任何用例解释为“当前不适用”并在
   延后它的同时关闭 M0；
3. `plugin-system-principles-and-v0-design.md` §3.8 冻结的 Host+SDK
   fail-closed 全集均通过，包括 actor/system audience/whisper target 伪造、
   裸或越权 thread 寻址、namespace escape、provenance 升级、denied grant、
   重复 idempotencyKey/operationId、deadline expiry、callback retry/dead-letter、
   断线后 cursor 续投与 ack 前崩溃重投、retention 越界 stale 追平、
   卸载后 retained/ask durable state 保留，以及 plugin crash isolation；
4. **P14 断言**明确成立：第一方插件与第三方插件走同一 SDK 入口和同一授权流；
5. **事件输入面四项断言**全部通过：拒绝 undeclared/forbidden-class signal，
   拒绝 producer 伪造与 observation→user_intent 认识论升级，拒绝插件自报
   wake route target，并在 lease 过期后正确判定 offline；
6. malformed、unauthorized、oversize、stale-cursor、cross-instance 与
   cross-subscription 输入按要求零副作用 fail closed；
7. plugin crash、invalid output 与 drain failure 不会拖垮 Host；
8. restart/reconcile 保留 K-1 canonical state 且不会 double-settle。

只有上述完整验收结论才能关闭 M0。

## 4. Phase 2 执行工作线

### 4.1 F292 / signal-ingress 旅程

原三段式拆分已经推进，但 runtime activation 仍把“代码已落地”与“feature 已验收”
严格分开：

1. **Contract + SDK + Feishu adapter — 已落地。** Beta.9 与 PR #24 已合入；
   `@clowder-ai/feishu-meeting-intake@0.1.0-alpha.1` 已公开，integrity 为
   `sha512-KxdTlM24eKnXy6NE3TmbP78ro5D6lAX+m0H3LN4MrfI6SVz9BQnntHDxobjz4B+5wJ3gl0i7BX3ZOjBnhFby/w==`。
2. **Host intake + Needs Me — 维护者报告已落地。** Cat Café #3522 与
   #3542 负责 admission、settlement 和私有 Host experience flow。
3. **外部旅程 — 待完成。** K-2D 实现已经落地但 runtime 保持休眠；待独立
   activation 决策完成后，再运行真实 meeting dogfood、provenance-preserving
   artifact 检查和发布证据采集。

私有开发碰撞检查已经完成。本工作线不再等待 K-2D merge 或 F289 #3467，只等待
runtime activation 边界及自身的端到端证据；`events.publish` ready 不代表 K-3b
windows/presence 或 M1 已完成。

### 4.2 M1 体验门禁

| 单元 | 常驻主笔 | 必须交付的结果 |
|---|---|---|
| K-3b windows/presence | `mindfn` 起草；`zts212653` 负责 Host review/merge | B 类窗口、presence/lease projection、grant 与 control surface |
| 剩余 C-2 closure | `mindfn`；双 CODEOWNER | 仅关闭 K-3b 与 probe/FG 集成必需的 schema/row |
| P-4 desktop probe | `mindfn` | Tier 0/1 声明式 signal、lease 行为、可见且可撤销的授权 |
| FG-1 foreground cat | `zts212653` | 使用与第三方相同 SDK/runtime/grant 路径的 reference plugin |

只有真实路径
`file/activity signal → Host-owned wake → foreground cat → 用户确认 → artifact`
通过，且 P14 same-power evidence 明确成立，M1 才能关闭。

### 4.3 GitHub 收编门禁

该工作线与 M1 相互独立，可以在 M0 之后并行开发：

1. K-5 Host schedule/state domain — `mindfn` 起草，`zts212653` review/merge。
2. C-3 schedule/state contract 与 migration/rollback fixture — 双 CODEOWNER。
3. P-5 GitHub plugin migration — `mindfn` 主笔，必须完整映射 config、secret、
   state、schedule 与 binding。
4. 隔离验收必须证明 migration 幂等、旧新版本不会双跑、数据保持且可 rollback；
   `zts212653` review integrity report。

## 5. Phase 3 全景

| 工作线 | 顺序 | 常驻主笔 / 权限 | 门禁 |
|---|---|---|---|
| Service + UI | K-6 Host mechanism → contract delta → P-6 voice-suite | `mindfn` 可起草；`zts212653` 保留 Host review/runtime；plugin 与 contract 变更双审 | M0；UI contribution 通过 Console Design Gate |
| Thread + connector | K-7 thread/settings mechanism → contract delta → P-7 IM migration；P-8 Weixin 可在契约前置具备时提前 | `mindfn` 可起草；Host merge 仍由 `zts212653` 负责 | P-7 需要 M0 + K-7；P-8 需要精确 schedule/state 前置 |
| Memory + foreground cat | #1047 acceptance → K-8 memory namespace → contract delta → FG-2 | #1047/K-8 Host 权限归 `zts212653`；fixture 由 `mindfn`；FG-2 仍由 `zts212653` 主笔 | #1047 verdict；`cat_private` 继续硬排除 |
| Community readiness | create-clowder-plugin、quarantine CI、signature/digest pipeline | `mindfn` | M1 |
| v1 freeze | compatibility review 与 breaking-window closure | 双方 | 所有选定 v1 lane 已验收 |

## 6. 依赖视图

```text
已完成：Phase 0 + K-1 + P-1 + beta.9 公共 ready rows
                         │
                         ├─ 已完成：K-2B Host state machine（runtime 休眠）
                         ├─ 已完成：K-2D external runtime 实现（runtime 休眠）
                         ├─ M0-A 显式 external-runtime activation
                         ├─ M0-B lifecycle row closure + Host support
                         └─ M0-C messaging row closure + Host support
                                      │
                                      └─ M0-D 联合验收 ──► M0

已完成：beta.9 + Feishu alpha.1 + 私有 F292 Host/Needs Me flow
                         │
                         ├─ K-2D activation ──► F292 外部 dogfood/发布证据
                         └─ K-3b + P-4 + FG-1 ──► M1

M0 ──► K-5 + C-3 + P-5 ──► GitHub 收编门禁
M1 / 逐工作线前置条件 ──► Phase 3 工作线 ──► v1 freeze
```

两条 Phase 2 工作线可以交叠推进，但各自的验收门禁保持独立。

## 7. 常驻分工与当前私有工作线

`zts212653/clowder-ai-plugins#1` 的 issue comment `5248175358`
已经完整回答六项确认：

1. K-2B、F292 Host/Needs Me 与 K-2D 实现均已落地；K-2D runtime 仍未启用，
   当前不再有等待 #3467 的 K-2D 私有实现 coordinate；K-3b 与 K-5 无人认领。
2. `mindfn` 主导普通无人认领工作；`zts212653` 保留 Host review/merge、
   runtime ownership、集成边界和私有 composition。
3. 双 CODEOWNER contract review 与精确 publication/version/integrity 核验
   继续为强制门禁。
4. 当 `mindfn` 主笔被测实现时，由 `zts212653` 主导独立验收。
5. FG-1 与 FG-2 继续由 `zts212653` 主笔。
6. 旧 beta.8 选择已经被新事实取代：当前 Host 精确 pin beta.9，并且只消费
   `broker.hello`、`broker.ready` 与 `events.publish`。

2026-08-12 的维护者进度刷新进一步确认：K-2D 已落地；F289 #3467 的暂停 migration
不是其前置条件。该更新只改变事实进度，不重开上述常驻分工决定。

这是常驻规则。普通无人认领实现不再需要逐项申请主笔权限。只有新公共语义、
生产数据/凭据边界、runtime activation、不可逆 registry 动作或新发现的碰撞，
才重新回到 maintainer review。
