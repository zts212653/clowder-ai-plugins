# 快捷用语

[English](README.en.md)

把重复使用的任务派发文字保存到聊天输入框旁，下一次可以直接搜索并填回草稿。

1. 在支持快捷用语入口的 Clowder AI Host 上安装并启用插件。
2. 草稿有文字时，点击书签图标，选择「是」保存这段文字。草稿仍可继续编辑。
3. 草稿无文字时，点击同一图标浏览已保存用语。每页五条，按选用次数从多到少排列，次数相同时按保存顺序从新到旧排列，搜索随输入更新。选中一条后回填草稿。已有图片和附件会保留。
4. 要移除用语，点击该条末尾的删除按钮并确认。

插件无须配置或授权外部账号。用语按当前 Host 用户分开保存在插件私有存储中，停用后保留。快捷用语最多与一条聊天消息等长，每位用户的用语合计可占用 1 MiB 存储。

选用次数与用语一起持久保存，已有用语从零次开始统计；浏览、搜索和重复保存不会增加次数。需要 Host 在选用时发送计数通知；旧版 Host 仍可保存、搜索和选用，但不会更新次数。

## 开发和安装

维护位置为本仓的 `packages/quick-phrases`，跟踪需求见 [Host Issue #1898](https://github.com/zts212653/clowder-ai/issues/1898)。

```sh
pnpm --filter @clowder-ai/quick-phrases typecheck
pnpm --filter @clowder-ai/quick-phrases test
pnpm --filter @clowder-ai/quick-phrases build
```

构建完成后，在 Host 插件管理中从本地目录安装此目录。需要支持 `composer.quick-phrases` 入口的 Host。本插件通过已有的插件资源转发提供列表、保存和删除。

同一 `phrases` 资源接受 `POST { "text": "…" }` 保存，`POST { "id": "<phrase-id>" }` 记录一次选用；两字段互斥，同时提供返回 `400`。计数按用户隔离，列表在搜索和分页前按次数排序；写入冲突沿用 `409` 重试响应。
