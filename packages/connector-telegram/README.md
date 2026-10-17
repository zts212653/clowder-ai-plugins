# Telegram 连接器

简体中文 · [English](README.en.md)

通过 Telegram Bot 与 Clowder AI 私聊，支持长轮询收消息、文本与媒体回复，以及安全的 Telegram HTML 排版。

## 开始使用

1. 使用 BotFather 创建机器人，取得 `botToken`。
2. 在插件设置保存这个密钥，然后启用插件。
3. 在 Telegram 私聊机器人。只接收人类用户的私聊，不接收机器人消息或群聊。

此连接器没有群权限设置或额外初始化步骤。群管理命令不会为私聊发送者授予管理员权限。

## 消息与恢复

回复按 Telegram 限制分段，避免截断 Unicode 字符或 HTML 实体。轮询游标在宿主确认接收后才提交；停用停止轮询并关闭会话。网络冲突采用有界退避。媒体文件标识仅存于私有状态，对外只提供受限引用，读取结算后清理。

## 对话命令

可使用 `/where`、`/new`、`/threads`、`/use`、`/thread`、`/commands`、`/cats`、`/status`、`/history`、`/unbind`、`/focus` 和 `/ask` 查看位置、切换对话或发起请求。`/thread`、`/ask` 只有显式携带正文时才请求猫执行，宿主接受投递后才确认成功。`/use` 会遍历可见对话，列表不完整时不猜测选择。

`/allow-group`、`/deny-group` 仅适用于支持群聊且已配置管理员的连接器，不能通过普通私聊文本取得管理权。

## 安装权限

以下能力均来自同一份 `plugin.yaml`，由宿主决定是否授权；说明文件不授予额外权限。

| 权限 | 用途 |
| --- | --- |
| `media.read` | 读取当前调用获准的媒体引用。 |
| `plugin.state.get` | 读取宿主保管的私有业务状态。 |
| `plugin.state.set` | 保存私有业务状态、进度与去重记录。 |
| `message.event.subscribe` | 接收获准的对话消息与生命周期事件。 |
| `messaging.send` | 向获准目标发送消息和回复。 |
| `secret.read` | 读取明确授权给本插件的凭据。 |
| `thread.listMetadata` | 列出可访问对话的基本信息。 |
| `thread.readContent` | 读取获准对话内容；范围由宿主核验。 |
| `thread.write` | 创建或更新获准的对话关联。 |

宿主管理安装、授权、凭据和启停；配置保存不自动改变启用意图。英文文档是独立文件，互链不代表页面已支持自动语言切换。
