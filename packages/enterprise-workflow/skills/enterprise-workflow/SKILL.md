---
name: enterprise-workflow
description: >
  企业 IM 工作流自动化：文档、表格、待办/任务、会议/日程一键创建。
  Use when: operator要求创建企微/飞书的文档、表格、待办、会议、日程、幻灯片，或一句话生成完整工作流。
  Not for: 普通聊天、消息收发、会议纪要 intake，或插件安装与配置。
  Output: 通过 Host 的 plugin_call 返回企业资源 handle 与链接。
triggers:
  - 创建文档
  - 创建表格
  - 创建待办
  - 创建任务
  - 创建会议
  - 创建日程
  - 幻灯片
  - golden chain
  - 工作流
  - 飞书
  - lark
  - 企微
  - wecom
---

# Enterprise Workflow — 企业 IM 工作流自动化

这个 skill 使用已安装插件 `official.enterprise-workflow` 的声明式工具。Host 负责调用身份、
审计、实时实例与授权校验；插件负责通过本机官方 CLI 创建资源。

## 调用纪律

1. 先用 `plugin_get` 确认插件已启用且运行。
2. 每次操作前用 `plugin_list_tools({ pluginId: "official.enterprise-workflow" })` 读取实时 schema。
3. 只从返回结果选择以下精确坐标之一：
   - `contributionId: "wecom-actions"`, `toolName: "wecom_action"`
   - `contributionId: "lark-actions"`, `toolName: "lark_action"`
4. 用 `plugin_call`，把 action 参数放入 `arguments`。
5. 不猜 schema，不传 `invocationId` / `callbackToken`，不调用旧 `/api/callbacks/*-action`，不裸调 CLI。

调用外壳：

```json
{
  "pluginId": "official.enterprise-workflow",
  "contributionId": "wecom-actions",
  "toolName": "wecom_action",
  "arguments": {
    "action": "create_doc",
    "docName": "会议纪要",
    "content": "# 纪要"
  }
}
```

## 平台选择

| operator 提到 | 工具 |
|---|---|
| 企微 / WeCom / 企业微信 | `wecom_action` |
| 飞书 / Feishu / Lark | `lark_action` |
| 只说企业 IM | 先问平台；不要自行跨租户创建 |

## WeCom actions

### 创建文档

```json
{ "action": "create_doc", "docName": "会议纪要", "content": "# 纪要\n..." }
```

### 创建智能表格

```json
{
  "action": "create_smart_table",
  "tableName": "Bug 跟踪表",
  "fields": [
    { "fieldTitle": "Bug", "fieldType": "FIELD_TYPE_TEXT" },
    { "fieldTitle": "优先级", "fieldType": "FIELD_TYPE_SINGLE_SELECT" }
  ],
  "records": [{ "Bug": "登录超时", "优先级": "P1" }]
}
```

### 创建待办

```json
{
  "action": "create_todo",
  "content": "Review PRD",
  "followerUserIds": ["zhangsan"],
  "remindTime": "2026-04-20 09:00:00"
}
```

### 创建会议

```json
{
  "action": "create_meeting",
  "title": "评审",
  "startDatetime": "2026-04-20 14:00",
  "durationSeconds": 3600,
  "inviteeUserIds": ["zhangsan"]
}
```

### WeCom golden chain

```json
{
  "action": "golden_chain",
  "docName": "Q2 产品 PRD",
  "docContent": "# Q2 产品规划\n...",
  "tableName": "Q2 任务跟踪表",
  "tasks": [
    { "content": "完成 API 设计", "assigneeUserId": "zhangsan", "remindTime": "2026-04-20 09:00:00" }
  ],
  "meetingTitle": "Q2 PRD 评审会",
  "meetingStart": "2026-04-20 14:00",
  "meetingDurationSeconds": 3600,
  "meetingInviteeUserIds": ["zhangsan", "lisi"]
}
```

## Lark actions

### 创建文档

```json
{ "action": "create_doc", "title": "会议纪要", "markdown": "# 纪要\n..." }
```

### 创建多维表

```json
{ "action": "create_base", "name": "Bug 跟踪表", "timeZone": "Asia/Shanghai" }
```

### 创建任务

```json
{
  "action": "create_task",
  "summary": "Review PRD",
  "assigneeOpenId": "ou_xxx",
  "due": "2026-04-20"
}
```

### 创建日程

```json
{
  "action": "create_calendar_event",
  "summary": "评审",
  "start": "2026-04-20T14:00:00+08:00",
  "end": "2026-04-20T15:00:00+08:00",
  "attendeeOpenIds": ["ou_xxx"]
}
```

### 创建幻灯片

```json
{ "action": "create_slides", "title": "Q2 Deck" }
```

### Lark golden chain

```json
{
  "action": "golden_chain",
  "docTitle": "Q2 产品 PRD",
  "docMarkdown": "# Q2 产品规划\n...",
  "baseName": "Q2 任务跟踪表",
  "tasks": [
    { "summary": "完成 API 设计", "assigneeOpenId": "ou_xxx", "due": "+3d" }
  ],
  "calendarSummary": "Q2 PRD 评审会",
  "calendarStart": "2026-04-20T14:00:00+08:00",
  "calendarEnd": "2026-04-20T15:00:00+08:00",
  "calendarAttendeeOpenIds": ["ou_xxx", "ou_yyy"],
  "includeSlides": true
}
```

## 结果与失败

- 成功结果直接是所选 action 的资源 handle；`golden_chain` 还包含可回贴的 `summary`。
- `INVALID_INPUT`：参数不符合 `plugin_list_tools` 返回的 schema；修正参数，不要重试原请求。
- `VENDOR_API_ERROR`：厂商 API 拒绝，等价于旧回调的 502；根据错误码和权限处理。
- `CLI_UNAVAILABLE`：CLI 路径无效、未安装、未登录或超时，等价于旧回调的 503；请 operator 修复本机配置。
- `CLI_PROTOCOL_ERROR`：CLI 输出与已验证协议不符；停止操作并报告，不要把它降级成“没找到资源”。

## 回贴格式

只回贴实际返回的 handle，不虚构 URL、用户或会议链接。示例：

```text
已完成工作流创建：

📄 文档: Q2 产品 PRD — <returned URL>
📊 表格: Q2 任务跟踪表 — <returned URL>
✅ 任务: 2 条已分发
🗓 日程: Q2 PRD 评审会
```

未知 user ID / open ID 时先向 operator 索取或使用已授权的通讯录能力；本插件没有用户搜索工具，
不得绕过 `plugin_call` 直接调用 CLI 搜索。
