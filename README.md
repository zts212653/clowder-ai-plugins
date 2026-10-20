# clowder-ai-plugins

> Clowder AI 官方插件生态仓——契约、插件侧 SDK/runtime 与官方插件的家。开发入口见[插件开发指南](docs/plugin-development.md)，贡献与发布要求见 [CONTRIBUTING](CONTRIBUTING.md)。源码中的候选版本不代表 npm 已发布版本。

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
- `@clowder-ai/plugin-sdk`：提供 standalone stdio 载体工具、统一 delivery／streams 和 module 生命周期辅助。声明 `runtime.transport: builtin` + root `entrypoint` 的包必须让该 ESM 模块的 `default` export 通过 `requirePluginModuleEntrypoint(...)`，Host 不猜测 named exports。
- Host Adapter/Broker：属于 `clowder-ai` 内核，不放在本仓，也不通过插件 client SDK 实现。

仓库名与 npm 包名不需要一一对应；SDK 可以从本 monorepo 的独立 package 构建并单独发布，无需另开一个 `clowder-ai-sdk` 仓。

## 开发入口

- **开发官方插件**：在 `packages/<插件目录>` 维护独立声明、源码和构建，按[开发指南](docs/plugin-development.md)进行仓内联调与制品验证。
- **开发独立插件或团队 Git 仓**：直接依赖可获取的 SDK npm 版本，也可按公开 module 契约实现不依赖 SDK 的插件；不必复制本仓 SDK 源码或先发布自己的插件。
- **同时修改 SDK**：SDK 在本仓独立 package 中开发；插件通过包名导入其公开 API。workspace 联调与最终制品依赖分别验证。

插件按[接口基线](docs/plugin-development.md)与[源码开发和安装指南](docs/plugin-projects.md)验证。workspace 联调与最终安装制品须分别核实；已激活的官方版本和摘要见 [catalog](catalog/catalog.json)，源码候选见 [candidate](catalog/candidate.json)。包发布并验证可获取后，再通过普通 PR 更新官方目录；候选不直接参与发现。

## 插件提供什么能力（contributions）

常见声明有 `mcp`（MCP 工具服务）、`skill`（使用指引）、`schedule`（调度）、`limb`（工具接入）、`connector`（消息渠道）和 `desktop-window`（桌面窗口）。一个包按实际需要选择，不要求每种都声明。

`tool`、`webhook`、`identity` 等也可能是功能与 Host 之间的接线；内部路由或验证编号不等于用户要逐项设置的功能。完整机器字段以 Contract 为准，用户说明放在每个插件的 README 中。

## 已有插件源码

`packages/` 已包含 IM 渠道、微信公众号、个人 Chrome、微信可见读取、企业工作流、GitHub、Collective、飞书纪要、视频分析/生成、GenOffice、Companion、象棋等插件。每包的 `plugin.yaml` 和 README 描述实际能力。

源码存在、制品发布和兼容 Host 验收是不同状态。官方 npm 安装目录以 `catalog/catalog.json` 为准；不要把所有源码包都视为已发布或完整验收。

## 皮肤 ≠ 身份

本仓将包含官方猫形象资产。先说清楚一件事：**装了同款皮肤，跑起来的不是同一只猫**——猫的身份不在形象文件里，在它与你的记忆和可验证的连续性里。你可以领养同款猫，但每只猫会长成你家的样子。

## License

代码：MIT。`assets/` 目录下的形象资产将适用单独许可（LICENSE-ASSETS，敲定中；先行原则：可使用，不可商用，不可改作）。

## 参与

新插件与修复通过 PR 提交。先读[插件开发指南](docs/plugin-development.md)和[贡献说明](CONTRIBUTING.md)；契约变更继续按路径责任与审批规则处理。
