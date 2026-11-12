# 快捷用语

[English](README.en.md)

把重复使用的任务派发文字保存到聊天输入框旁，下一次可以直接搜索并填回草稿。

1. 在支持快捷用语入口的 Clowder AI Host 上安装并启用插件。
2. 草稿有文字时，点击书签图标，选择「是」保存这段文字。草稿仍可继续编辑。
3. 草稿无文字时，点击同一图标浏览已保存用语。每页五条，按选用次数从多到少排列，次数相同时按保存顺序从新到旧排列，搜索随输入更新。选中一条后回填草稿。已有图片和附件会保留。
4. 要移除用语，点击该条末尾的删除按钮并确认。

插件无须配置或授权外部账号。用语按当前 Host 用户分开保存在插件私有存储中，停用后保留。快捷用语最多与一条聊天消息等长，每位用户的用语合计可占用 1 MiB 存储。

选用次数与用语一起持久保存，已有用语从零次开始统计；浏览、搜索和重复保存不会增加次数。插件在 GET 的每条结果上返回可选的 `onInserted` 回执（不持久化）：支持该回执的 Host 只在实际插入后执行，插件内部最多 3 次 fresh-read + CAS，只有未应用时才重试。兼容边界分三种：不发选用通知的旧 Host 不计数；仍发送 legacy `POST {id}` 的 Host 继续被接受并计数；新版 Host 搭配没有 `onInserted` 的旧插件仍可保存、搜索和选用，但不会更新次数。

## 开发和安装

维护位置为本仓的 `packages/quick-phrases`，跟踪需求见 [Host Issue #1898](https://github.com/zts212653/clowder-ai/issues/1898)。

```sh
pnpm --filter @clowder-ai/quick-phrases typecheck
pnpm --filter @clowder-ai/quick-phrases test
pnpm --filter @clowder-ai/quick-phrases build
```

构建完成后，在 Host 插件管理中从本地目录安装此目录。需要支持 `composer.quick-phrases` 入口的 Host。本插件通过已有的插件资源转发提供列表、保存和删除。

同一 `phrases` 资源接受 `POST { "text": "…" }` 保存，`POST { "id": "<phrase-id>" }` 记录一次选用；两字段互斥，同时提供返回 `400`。计数按用户隔离，列表在搜索和分页前按次数排序；`POST {id}` 最多 3 次 fresh-read + CAS，只有 `applied:false` 才重试，持续冲突返回 `409`。普通保存/删除保持单次 CAS 与原有 `409` 语义。GET 的每条 item 额外返回 `onInserted: { request: { method: "POST", path: "phrases", body: { id } }, notifyFailure: false }`，Host 只在文本实际插入后执行该 action；该字段不回写存储。
