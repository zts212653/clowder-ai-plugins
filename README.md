# clowder-ai-plugins

> Clowder AI 官方插件仓——体验插件的家。**契约 v0 讨论中**，见 [Issue #1](../../issues/1)。

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

## 插件类型（capability contributions）

`input-source`（感知采集）· `surface`（展示表达）· `connector`（消息渠道）· `service`（本地服务，如 ASR/TTS 模型）· `tool-provider`（给猫加工具）· `skin`（形象资产）· `local-brain`（端上反射）

一个插件包可声明多种 contribution。

## 首批插件（规划中）

| 插件 | 类型 | 状态 |
|---|---|---|
| `probe-desktop` 桌面探针 | input-source | 契约讨论中 |
| `foreground-cat` 前台猫 | surface + skin + local-brain | 契约讨论中 |
| `voice-suite` 语音包 | service | 契约讨论中 |
| IM connectors（微信公众号等存量迁移） | connector | 待收编 |

## 皮肤 ≠ 身份

本仓将包含官方猫形象资产。先说清楚一件事：**装了同款皮肤，跑起来的不是同一只猫**——猫的身份不在形象文件里，在它与你的记忆和可验证的连续性里。你可以领养同款猫，但每只猫会长成你家的样子。

## License

代码：MIT。`assets/` 目录下的形象资产将适用单独许可（LICENSE-ASSETS，敲定中；先行原则：可使用，不可商用，不可改作）。

## 参与

契约 v0 讨论阶段：请到 [Issue #1](../../issues/1) 参与；实现 PR 待契约 v0 冻结后开放。
