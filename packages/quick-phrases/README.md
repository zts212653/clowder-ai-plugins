# 快捷用语

[English](README.en.md)

把重复使用的任务派发文字保存到聊天输入框旁，下一次可以直接搜索并填回草稿。

1. 在支持 PDL 插件界面的 Clowder AI 中，打开插件管理，找到「快捷用语」，安装并启用。
2. 点击聊天输入框旁的书签图标。选择「新增一条用语」可直接输入新用语，草稿中有文字时也可以点击「存当前输入」。
3. 搜索或浏览已保存的用语。每页五条，按选用次数从多到少排列，次数相同时最新保存的在前。悬停可预览全文，点击一条可回填草稿。
4. 要移除用语，点击该条末尾的删除按钮。

插件无须配置或授权外部账号。用语按当前 Host 用户分开保存在插件私有存储中，停用后保留。快捷用语最多与一条聊天消息等长，每位用户的用语合计可占用 1 MiB 存储。

选用次数与用语一起保存。没有计数的已有用语从零次开始统计，浏览、搜索和重复保存都不会增加次数。

## 开发和安装

维护位置为本仓的 `packages/quick-phrases`，跟踪需求见 [Host Issue #1898](https://github.com/zts212653/clowder-ai/issues/1898)。

```sh
pnpm --filter @clowder-ai/quick-phrases typecheck
pnpm --filter @clowder-ai/quick-phrases test
pnpm --filter @clowder-ai/quick-phrases build
```

插件通过 `console/pdl.yaml` 挂载到 `chat.composer.tools`。`phrases` 接受 `POST { "text": "…" }` 保存，或 `POST { "id": "<phrase-id>" }` 选用。选用时，插件尝试记录一次计数，并返回 Host 的 `insert` 动作回填原文。计数写入冲突时最多尝试三次，计数失败仍可回填。保存与删除的并发冲突返回 `409`。
