# clowder-ai-plugins

> Clowder AI 官方插件生态仓——契约、插件侧 SDK/runtime 与官方插件的家。**契约 v0.1 候选实现中**，见 [Issue #1](https://github.com/zts212653/clowder-ai-plugins/issues/1)。

## 这个仓在做什么

我们在做的不是"桌宠工具"，是**让一群有记忆、有身份、有分寸的猫，获得能走出网页的身体**。

插件是可独立发布、可嵌入、可携带本地能力的"体验身体"；[Clowder AI](https://github.com/zts212653/clowder-ai) 内核保有猫的身份、记忆、会话与协作真相。骨架和灵魂用一份**插件契约**对接。

```
┌────────────────────────────────────────────┐
│ 灵魂层（Clowder 内核）                       │
│ 身份 / 记忆 / 会话真相 / 表达分寸             │
├──────────── 插件契约（本仓定义）──────────────┤
│ 输入信封（origin × epistemicStatus 两轴）    │
│ 输出事件流 · manifest · capability 类型      │
├────────────────────────────────────────────┤
│ 插件（本仓实现）                             │
│ 前台猫 · 桌面探针 · 语音包 · IM connectors    │
└────────────────────────────────────────────┘
```

## 仓库边界

Clowder AI 采用两仓协作，而不是把插件管理和插件实现混在一起：

| 仓库 | 职责 |
|---|---|
| `clowder-ai-plugins`（本仓） | 插件契约、插件侧 SDK/client、standalone runtime、脚手架、官方插件源码与 conformance fixtures |
| [`clowder-ai`](https://github.com/zts212653/clowder-ai) | 插件发现与安装、统一管理 UI、授权、Host Broker、运行时编排、审计与用户数据管理 |

本仓**不是插件管理器**。官方插件会在这里独立开发、构建和发布；Clowder AI 宿主负责下载或接收插件制品，校验 manifest 与 digest，取得用户授权，然后安装、启用并通过 Host Broker 运行它们。第一方插件与第三方插件走同一套 SDK 和授权通道。

## SDK 被谁使用

插件 SDK 面向插件作者和插件 runtime，而不是 Host 内部实现：

```text
官方插件 / 第三方插件 / loopback fixture
                  │
                  ▼
       @clowder-ai/plugin-sdk（P-1 首切片）
                  │  call / callback / event / handshake
                  ▼
       Clowder AI Host Broker（内核仓）

Host Broker ─────┐
插件 SDK ────────┴─→ @clowder-ai/plugin-contract
```

- `@clowder-ai/plugin-contract`：双方共同消费的机器契约真相源，包含 JSON Schema、生成类型、capability 表与 conformance fixtures；F285 的 `physical-limb` contribution schema 在这里定义物理动作、观察、readiness 与独立设备 grant，刻意不包含 raw sensor media。
- `@clowder-ai/plugin-sdk`：提供 schema-neutral standalone stdio runtime、握手/`events.publish` Host-bound helper 与 beta.10 Train B contribution facade；其余 RPC 仍须等对应 contract row 从 reservation 变为 executable。
- Host Adapter/Broker：属于 `clowder-ai` 内核，不放在本仓，也不通过插件 client SDK 实现。

仓库名与 npm 包名不需要一一对应；SDK 可以从本 monorepo 的独立 package 构建并单独发布，无需另开一个 `clowder-ai-sdk` 仓。

## 当前阶段

`packages/plugin-contract` 是机器契约真相源；`packages/plugin-sdk` 已落地 schema-neutral standalone stdio runtime，并开放 Host-bound `events.publish`。`packages/feishu-meeting-intake` 是 C-2 的首个官方纵切：只发布有界 meeting metadata + opaque source handle，durable outbox/cursor 负责断线恢复，长期飞书凭据仍由 Host 注入的 gateway 保管。Host Broker、Needs Me 与用户数据仍属于内核仓。

## 插件类型（capability contributions）

`input-source`（感知采集）· `surface`（展示表达）· `connector`（消息渠道）· `service`（本地服务，如 ASR/TTS 模型）· `tool-provider`（给猫加工具）· `skin`（形象资产）· `local-brain`（端上反射）

一个插件包可声明多种 contribution。

## 首批插件（规划中）

| 插件 | 类型 | 状态 |
|---|---|---|
| `probe-desktop` 桌面探针 | input-source | 契约讨论中 |
| `foreground-cat` 前台猫 | surface + skin + local-brain | 契约讨论中 |
| `voice-suite` 语音包 | service | 契约讨论中 |
| `feishu-meeting-intake` 飞书会议入口 | input-source | alpha 实现中 |
| IM connectors（微信公众号等存量迁移） | connector | 待收编 |

## 皮肤 ≠ 身份

本仓将包含官方猫形象资产。先说清楚一件事：**装了同款皮肤，跑起来的不是同一只猫**——猫的身份不在形象文件里，在它与你的记忆和可验证的连续性里。你可以领养同款猫，但每只猫会长成你家的样子。

## License

代码：MIT。`assets/` 目录下的形象资产将适用单独许可（LICENSE-ASSETS，敲定中；先行原则：可使用，不可商用，不可改作）。

## 参与

契约 v0 讨论阶段：请到 [Issue #1](../../issues/1) 参与；实现 PR 待契约 v0 冻结后开放。
