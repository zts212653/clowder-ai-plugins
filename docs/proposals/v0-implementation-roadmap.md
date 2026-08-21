---
title: Clowder AI 插件系统实施路线图
status: 执行中 — beta.11 公共契约已就绪；M0 Host messaging 待收口；下一阶段冻结为完整基础底座与存量迁移
discussion: zts212653/clowder-ai-plugins#1
ack_request: https://github.com/zts212653/clowder-ai-plugins/issues/1#issuecomment-5236600431
acknowledgement: https://github.com/zts212653/clowder-ai-plugins/issues/1#issuecomment-5248175358
progress_refresh: https://github.com/zts212653/clowder-ai-plugins/pull/25#issuecomment-5261613034
created: 2026-07-14
revised: 2026-08-21
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

本次刷新以 2026-08-21 已核验代码为准。它取代旧版“beta.9 row closure →
逐能力 Phase 2/3 扩张”的顺序。目标不是继续增加协议行或拆出大量小 PR，
而是尽快且可验证地完成完整插件底座，再集中迁移现有能力形成产品闭环。

## 1. 目标架构与硬边界

### 1.1 基础底座完成线

一个独立 npm 插件必须能够：

1. 从 Host 配置的 catalog provider 被发现、查询和安装；
2. 通过统一 Plugin Manager 完成校验、配置、启用、禁用、更新、修复和卸载；
3. 只依赖公共 `@clowder-ai/plugin-sdk` 使用授权后的消息、事件、配置、状态、
   secrets、scheduler、MCP、hook、service、connector 与 Console contribution；
4. 在重启后恢复正确状态，并在禁用或卸载时完整撤销注册、停止执行和按声明
   保留或清理数据；
5. 第一方与第三方插件走同一 SDK、Broker、grant、trace、ledger 和生命周期路径。

达到以上五条，才算“基础底座完成”。某个 package 发布、某组 wire row ready、
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

## 2. 2026-08-21 已核验现状

### 2.1 精确坐标

| 真相源 | 精确坐标 | 已核验事实 |
|---|---|---|
| `clowder-ai-plugins` | `a0b3554d5ebbe71a9043bbb63cca5bf5dcba74b5` | beta.10 lifecycle 与 beta.11 messaging 已合入；当前无开放实施 PR。路线图文档 PR #38 不占实施预算。 |
| `@clowder-ai/plugin-contract` | `next = 0.1.0-beta.11` | 13 条 handshake、messaging、lifecycle、events wire row 全部 `ready:true`。 |
| `@clowder-ai/plugin-sdk` | `next = 0.1.0-beta.7` | 已有 stdio runtime、handshake、dispatch classifier 与 `events.publish` helper；尚不是完整插件作者 SDK。 |
| `@clowder-ai/feishu-meeting-intake` | `next = 0.1.0-alpha.6` | 已有真实独立 npm/stdio 插件、owner auth 与事件输入；仍需作为基础底座的真实 dogfood。 |
| Clowder AI upstream | `3ea629e28747c80b1ce92d883740feea6a28fd68` | F202 local manager、K-2 Host runtime、官方 catalog/install/update/lifecycle API 与 Settings UI 已存在。 |
| M0 Host candidate | `9691dc752595e2516737cfac1db4f7dbf9e87c78` | 已 rebase 到 Clowder AI upstream `3ea629e28747c80b1ce92d883740feea6a28fd68`（behind=0）；beta.11 Host messaging、durable snapshot paging 与 stdio delivery 已实现，exact-HEAD 跨家族 review 已发起，尚未创建 upstream PR 或运行联合验收。 |

`latest` dist-tag 仍落后 `next`；当前属于 prerelease 交付车道，不宣称兼容性冻结。

### 2.2 成熟度判断

| 层面 | 当前判断 | 主要缺口 |
|---|---|---|
| Contract / trust | 高 | stable compatibility 与完整产品验收。 |
| Host runtime | 中高 | M0 Host candidate 收口、生命周期/消息联合验收。 |
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
   hook、service 或 UI contribution 都不是各开一串 PR 的理由。
3. **剩余基础闭环默认五个聚合 PR。** 每个 PR 内用小提交、TDD、按域测试矩阵和
   review 修订保证可审查性；review finding 继续修在原 PR。
4. **只有边界而非规模允许拆分。** 新信任边界、不可逆 registry/数据迁移，或确实
   无法在一个 review 单元内安全证明的状态机，才允许突破预算。
5. **双仓以 release train 协调。** Plugins 侧先发布精确 package，Core 在同一列车
   的聚合 PR 中 pin 一次；最终用两个 exact SHA 做联合验收。
6. **禁止边迁移边补底座。** Train B 完成前不迁移 IM/service，也不开始 foreground
   cat、memory、windows 等新插件化能力，避免每个迁移再次发明私有接口。

受保护分支强制产生的路线图文档 PR #38 是一次治理落盘，不计入上述五个实施 PR；
后续进度只在该路线图或对应实施 PR 内更新，不再为状态同步新开 PR。

## 4. Train A — M0 Runtime 收口（剩余 PR 1/5）

Plugins 侧 beta.11 已合入，本列车只剩一个 Core Host PR。当前分支不再扩 SDK、
marketplace 或 Console scope。

### 必须完成

1. 将 M0 Host candidate rebase 到最新 upstream，得到 behind=0 的 exact SHA；
2. 关闭分支自身的 build/test/gate 回归；基线漂移单独给出 provenance，不伪装绿色；
3. 由非作者跨家族 reviewer 审查授权、durable cursor、Redis 原子性、stdio
   correlation、deadline、crash/recovery 与默认安全 composition；
4. 创建并跟踪一个 upstream Core PR；
5. 冻结 reviewed Host SHA 与 Plugins `a0b3554d...`，运行 canonical 18-case
   Host ↔ compiled standalone plugin 联合验收；
6. 用真实 Feishu plugin 证明 install/enable/start/publish/disable/restart 不绕过
   Broker、inventory 与 domain settlement。

### 完成线

- 全部 18 个 canonical vector 通过；
- malformed、unauthorized、oversize、stale、cross-instance/subscription、deadline、
  crash、drain 和 restart/reconcile 均 fail closed；
- P14 成立：第一方与第三方走同一 runtime/grant 路径；
- M0 关闭不附带新的 SDK/UI/迁移欠账声明。

## 5. Train B — 完整基础底座（剩余 PR 2–3/5）

Train B 是 M0 后唯一关键路径，由一个 Plugins 聚合 PR 和一个 Core 聚合 PR 组成。
实现可以按领域提交，但不得把每个 facade、adapter 或 contribution point 拆成 PR。

### 5.1 Plugins 聚合 PR：公共 SDK 与 Contribution Contract（PR 2/5）

- `definePlugin(...)` 与类型化 `PluginContext`；
- `activate` / `deactivate` / `dispose` 生命周期，以及注册即返回 disposer 的
  `ctx.effect(...)`；
- `ctx.messaging`、`ctx.events`、`ctx.config`、`ctx.state`、`ctx.secrets`；
- `ctx.scheduler.register(...)`、`ctx.mcp.register(...)`；
- 生命周期 hook 与按真实消费点审查的类型化领域 hook；不开放任意内部 hook；
- `ctx.services`、`ctx.connectors`、`ctx.ui` contribution API；
- typed manifest contribution schemas、generated types、conformance fixtures；
- create-plugin template、API reference、升级兼容规则和真实 composition fixture。

所有公开注册 API 必须证明：grant 拒绝零副作用、重复注册可判定、dispose 后注册项
消失、重连/重启语义明确、插件不能自报 Host identity 或持有另一插件实例。

### 5.2 Core 聚合 PR：统一 Manager、Adapters、Marketplace 与 Console（PR 3/5）

在现有 F202、official catalog、external lifecycle 和 Settings 上收敛，不另建平行系统：

- Plugin Manager 统一 package/config/activation/runtime 正交状态；
- 本地插件、官方 npm 插件与后续 community package 共享生命周期投影；
- `.env` 只选择 catalog provider/索引位置；Host 继续验证允许的 origin、版本、
  digest、provenance、trust tier 与 quarantine，配置来源不能自动变成信任来源；
- `clowder-ai-plugins` 发布机器可读 catalog index，支持查询、详情、版本和兼容性；
- Console 与 Agent 使用同一组 revision-fenced、带授权和审计的管理 API；
- resource adapters 将 SDK contribution 接入现有 scheduler/MCP/service/connector；
- Console 提供声明式 slot/command/settings/message-element contribution，挂载与销毁
  绑定 plugin instance lifecycle；v0 不执行不受信任的任意 DOM/React 代码；
- install/update/uninstall 与 retained/ask-on-uninstall 数据策略经过 crash、并发、
  stale revision、rollback 和 restart 对抗测试。

### Train B 完成线

一个不含产品特判的 fixture npm 插件必须能从 catalog 安装，只使用公共 SDK 注册
至少 messaging、schedule/MCP、lifecycle 和 Console contribution，经历配置、启用、
重启、禁用、更新、卸载后，Host inventory、注册表、UI 和 retained data 全部一致。

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

### Train C 完成线

IM、至少一个现有业务插件、至少一个 ASR/TTS service package 三种形态均从
`clowder-ai-plugins` 安装并通过公共 SDK 工作；Core 不再包含它们的业务实现或
第二套管理入口。达到此处，插件基础平台形成闭环。

## 7. 闭环后的能力扩张

Train C 通过前，以下工作只保留需求输入，不进入实现关键路径：

1. foreground cat / windows / presence；
2. memory/thread 高敏能力；
3. 更多 signal producer、内容发布和 physical limb；
4. community arbitrary executable trust、network/filesystem sandbox；
5. v1 compatibility freeze。

闭环后按真实插件消费需求成组开放，不预先把所有 Core API 暴露成 SDK，也不因为
“未来可能需要”开放任意 hook 或 UI code execution。

## 8. 依赖视图

```text
已完成：G-0 + K-1 + P-1 + contract beta.11 + K-2A/B/D
                                      │
                                      ▼
Train A：M0 Host exact-HEAD + review + PR + 18-case + Feishu dogfood
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
