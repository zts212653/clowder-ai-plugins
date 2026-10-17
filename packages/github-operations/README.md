# GitHub 协作

简体中文 · [English](README.en.md)

`@clowder-ai/github-operations` 把 GitHub 动态跟踪和社区协作放在一个插件里：跟踪 PR 审查、CI 检查、合并冲突、Issue 和评论，汇集仓库动态，并提供社区分诊与待确认的 Issue 草稿。

## 开始使用

1. 在 Clowder AI 设置中安装插件。GitHub CLI `gh` 应在运行 Clowder AI 的机器上完成登录。
2. 如需指定凭据，在插件的 Personal Access Token 密钥字段填写；也可使用机器已有的 `gh` 登录。不要把 token 放进聊天、工具参数或仓库内容。
3. 启用插件，使用已安装的 GitHub Operations skill 和工具。配置保存与启用意图是两件事；跟踪和后台轮询需要插件实际运行。

其余配置按需填写，不是安装前置步骤：

| 配置 | 用途 |
| --- | --- |
| Noise Bot Login List | 过滤已知的纯设置评论噪声。 |
| GitHub Webhook Secret | 仅在启用仓库 Webhook 时配置；使用 Host 提供的准确回调地址。 |
| Repositories allowed for public issue drafts | 允许发布 Issue 草稿的 `owner/repository`，以逗号分隔；留空时不允许新建或发布这类草稿。 |
| Community narrator cat / thread | 同时指定接收手动分诊简报的猫和已有 thread；留空不发起新请求。 |

`mcpToken` 是为旧 inventory 保留的配置键，不是当前工具调用的凭据，无需为使用原生 MCP 另行填写。新安装不要求导入旧配置、旧权限或历史游标；现有数据不会被本次迁移隐式删除。

## 跟踪 PR 和 Issue

插件声明了 `github-tracking` 原生 MCP。猫通过当前工具说明使用：

- `cat_cafe_register_pr_tracking`：登记 PR 跟踪。
- `cat_cafe_register_issue_tracking`：登记 Issue 跟踪。
- `cat_cafe_unregister_tracking`：停止指定跟踪，保留历史。

登记需要仓库、编号和唯一 `registrationId`。响应不明时，使用相同 ID 和相同参数重试，不要另建一份跟踪。当前猫、thread 和 invocation 身份由 Host 认证，不是工具参数。

第一次登记只记录当前基线，不补发一串历史动态；之后符合条件的变化才投递成普通消息。仓库收件箱另行登记仓库。没有登记的对象不会因为安装插件就被定时轮询。页面按需读取 PR 标题是独立的只读操作，不会登记跟踪或刷新仓库索引。

关闭或合并的对象在最终采集和投递完成后退出跟踪。采集失败不推进游标；待投递消息保留重试。禁用插件会取消正在进行的 provider 工作并等待清理，之后重新启用仍使用持久状态恢复。

## 社区分诊与发布

Community 页面可以读取仓库事实、查看草稿和进行已声明的协作操作。Issue 草稿会先经过整理和确认，发布仍需明确操作及允许的目标仓库；空白发布仓库配置不能被绕过。

如配置了 narrator 的猫和 thread，手动分诊提交会保存固定目标和简报，再由既有调度投递。修改目标会暂停原投递，不会把旧简报改发给新目标。恢复原配置后可重试；启用配置不会自动唤醒历史事项。

外部审查结果通过 `github_record_external_review_verdict` 提交。`pending_verification` 表示结果已保存，**不表示审查送达或租约完成已被批准**。缺少可信发布者关联时，验证会返回 `insufficient`，不能仅凭 GitHub 上出现一条审查就宣称完成。

## 页面上的能力名称是什么意思

MCP、skill 和调度是用户或猫直接使用的能力；插件也需要声明与 Host 页面、消息及验证流程相连的接点。

| 名称 | 实际作用 |
| --- | --- |
| 工具 / `github-tracking` MCP | 登记、读取和停止跟踪，以及已声明的 Community 操作。 |
| Skill | 说明这些工具的适用场景和用法。 |
| 调度 | 定时检查已登记的事项，恢复未完成的采集与投递。 |
| `community-http-01` 到 `29` | Community 页面的内部 HTTP 路由编号，不是要求用户去 GitHub 配置 29 个 Webhook。 |
| `github/events` | 可选的外部仓库 Webhook；检查原始请求的 HMAC，只接受已登记仓库。 |
| `github/pr-title` | 页面展示需要时读取最新 PR 标题，不改跟踪状态。 |
| `review-predicate` / 完成验证 | Host 使用的私有审查验证接点，不是要用户点的验证按钮，也不直接授予完成权。 |
| `github-notification`、`github-wait` 身份 | 标记通知和等待的插件来源，不是新的 GitHub 账号，也不是调用者授权。 |

这些接点都属于**同一个插件**，共享一份 `plugin.yaml`、pluginId、版本和能力声明；不是多个插件或新增配置步骤。本包没有声明 limb。内部编号是否出现在普通能力页，由 Host 的展示层处理，不应通过删掉实际接线来改变功能。

## 权限与恢复边界

Host 管理安装、授权、thread 访问、存储机制和普通消息/唤醒；插件管理 GitHub 读取、过滤、跟踪和社区业务。安装不等于自动同意所有权限。

插件实际请求的权限及用途如下；访问范围仍由 Host 授权和校验，不从 README 或仓库内容推导额外 grant。

| 权限 | 用途 |
| --- | --- |
| `schedule.register` | 定时检查已登记事项，恢复待处理的采集和通知。 |
| `plugin.config.read` | 读取本插件的设置。 |
| `secret.read` | 读取配置给本插件的 token 和 Webhook 密钥。 |
| `plugin.state.get`、`plugin.state.set` | 读取和保存私有跟踪状态、游标、去重记录与投递进度。 |
| `task.read`、`task.write` | 读取任务并更新跟踪、等待投影；范围由 Host 校验。 |
| `thread.listMetadata` | 读取获准对话的基本信息，确认投递目标。 |
| `thread.readContent` | 读取获准对话内容；这是需要明确同意的内容访问权限。 |
| `thread.write` | 对获准对话执行已声明的写入操作。 |
| `messaging.send` | 向获准目标投递通知与分诊简报。 |
| `custody.invoke` | 向 Host 提交已声明的协作操作，不自行授予批准或完成权。 |
| `custody.verify` | 为 Host 的私有审查验证提供证据，不是普通工具或用户按钮。 |
| `deployment.read` | 读取部署中的猫目录，确认分诊对象可用。 |
| `frustration.read`、`frustration.link` | 读取已确认的问题来源，并关联相应 Issue 草稿。 |

工具参数、评论、仓库文本及消息元数据都不能充当当前猫身份、owner 权限、批准或发布授权。原生 MCP 通过 SDK 的认证调用通路进入本插件；不会恢复已退役的外部 GitHub MCP 集成。私有验证方法不是普通工具或 action。

PR 轮询每轮最多接纳 20 个等待，使用共同的 CI 基础事实；每个 PR 的深入读取有独立 10 秒界限，整轮预算为 30 秒。失败保留原基线和 generation。中途取消或重登记会再次校验，未完成的通知可恢复；这些包内回归不是 Host 真实旅程通过的替代证据。

发行备注：当前是未公开发布的本地候选，真实账号旅程与公开分发需分别验收。
