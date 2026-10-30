# 问题反馈插件

[English guide](README.en.md)

从左栏底部进入，默认打开空白的新建表单。选择问题反馈（`bug:`）或功能建议（`feat:`），标题选填，只需描述或图片即可。推荐“生成分析报告”：详细材料由已配置的 Agent Client 分析后生成；“直接反馈”不依赖 Agent。两条路径都需要检查最终报告、截图、目标可见性并确认提交。

顶部“反馈记录”独立展示每条草稿、分析中、分析完成待投递、待网页提交、投递待核对及已投递状态。旧反馈不会占用新建表单或锁住另一条反馈；分析完成可从记录中继续投递。分析成员、目标和可选项目目录放在折叠的“分析与投递设置”。

输入后会延迟自动保存；内部切换到新建或记录时等待保存完成。关闭面板前请点击“保存草稿”并确认显示“草稿已保存到反馈记录”；Host 的 X/Escape 会直接关闭，不保证保存尚未完成的最后输入。历史只恢复旧版本仍保留的当前草稿和最近一次分析，无法还原被旧版本覆盖的更早内容。迁移保留原始记录和投递回执；打开手动入口仅表示待网页提交，不能据此认定已创建 Issue。

自动提交成功会返回平台实际创建的 Issue 链接，并回读标题和完整正文。手动创建始终保留为兜底，跳转地址不携带标题或正文；字段旁可复制标题、报告，每张图可复制 PNG 或下载原图后上传。

## 安装与宿主要求

需要配套 Host #1732 的通用 `ui` command / `activity-bar.bottom` 面板能力；分析复用普通 `members`、`threads`、`messaging` 和可选 `runtimeInfo.get()`。此包仍为候选，尚未加入发布目录或默认安装列表；旧 Host 不会显示侧栏入口，不能单独宣称兼容。通用能力诉求见 Host Issue #1734。

```sh
pnpm --filter @clowder-ai/feedback build
cd packages/feedback
npm pack --ignore-scripts
```

将生成的包通过插件设置中的本地包安装入口安装，保存配置、测试后启用。提交日志使用宿主按安装实例隔离的私有 CAS 存储；图片按 SHA-256 保存在宿主提供的 dataPath 中，避免占用单值 1 MiB 的日志预算。业务数据保留；停用、升级与卸载不会由插件删除草稿、图片或提交回执。

## 目标配置

默认目标是公开的 `zts212653/clowder-ai`。GitHub 自动提交需要 `githubToken`；GitLab REST 使用 `gitlabToken`。令牌只存于宿主 secret 字段，不要放入 JSON 或命令参数。

`destinations` 可配置多个目标，用户在表单选择。每次修改配置需递增 `revision`；所有配置字节和报告、图片摘要都会绑定到确认，改变后旧确认无效。内网目标不会降级调用公网。

```json
[
  {
    "id": "internal", "label": "内部反馈", "revision": 1,
    "provider": "gitlab", "mode": "both", "project": "team/clowder-ai",
    "apiBaseUrl": "https://gitlab.example.test/api/v4",
    "issueCreateUrl": "https://gitlab.example.test/team/clowder-ai/-/issues/new",
    "visibility": "private", "attachmentOrigins": []
  }
]
```

只支持网页创建时将 `mode` 设为 `manual`，无须 API 凭据。保留完整的目标配置便于后来切换自动通路。`visibility` 可用 `public`、`private`、`unknown`；自动通路要求实际可见性与配置相同，未知时先人工核对。

## 图片交付

最多 4 张 PNG/JPEG/WebP，单张 4 MB、总计 8 MB。图片在本地解码为 PNG，服务端再次去除元数据；预览和哈希对应实际发送副本，图片不交给模型。原图独立保留用于本地下载，可能包含元数据，不会自动上传。文字脱敏无法覆盖图片中的隐私，用户必须先裁剪、遮盖并检查。

GitLab 使用项目 Markdown 上传接口，上传后回读实际字节并核对 SHA-256。公开项目的上传文件可能通过直接地址访问，不能把 Issue 保密状态当作附件隐私保证。

GitHub Issue REST 没有本插件可直接使用的图片上传通路。带图自动提交需要配置 `attachmentCommand` 和 `attachmentOrigins`，使用组织批准的附件存储。无适配器时，界面保留报告和图片并指向手动创建；无图自动提交仍可使用。不能上传本机 `file:`/`blob:` 地址或把图片遗漏后宣称提交完成。

```json
{
  "attachmentCommand": { "executable": "C:\\tools\\feedback-attachments.exe", "args": ["--json"] },
  "attachmentOrigins": ["https://attachments.example.test"]
}
```

上面字段加在完整目标对象内。上传请求仅包含已确认 PNG 发送副本的字节；原图旁路字段不会传给 CLI；回执必须提供 `url`、`sha256`、与目标相同的 `visibility`。地址必须属于允许源，远端字节回读一致后才关联到报告。需要身份才能下载的独立存储可通过组织适配器统一实现；当前通用附件命令回读按无凭据 HTTPS 请求进行。

## 组织 CLI / glab 适配

将 `provider` 设为 `organization-cli` 并提供 `command: { executable, args }`。程序可包装现有 `glab`、内部命令或网关 SDK。业务代码不依赖命令名称。仅设置固定可执行文件与参数，不使用 shell 字符串，也不要将用户输入插入参数。

进程从 stdin 读取一份 UTF-8 JSON，向 stdout 输出一份 JSON；stderr 不展示给用户。协议为 `clowder-feedback/v1`，30 秒超时，输出上限 2 MB；进程仅继承系统路径、临时目录与原生认证所需的 HOME 目录变量，认证由适配器自己的凭据库负责。

```json
{
  "protocol": "clowder-feedback/v1", "op": "create",
  "target": { "id": "internal", "project": "team/clowder-ai", "apiBaseUrl": "https://gitlab.example.test/api/v4", "visibility": "private" },
  "payload": { "submissionId": "uuid", "title": "title", "body": "approved markdown including marker" }
}
```

| 操作 | 请求 payload | 返回 |
| --- | --- | --- |
| `preflight` | `{}` | `principal, project, visibility, canCreate, attachments` |
| `upload` | `submissionId, attachment`（含 base64、mime、sha256） | `url, sha256, visibility` |
| `create` | `submissionId, title, body` | `id`/`iid`/`number`, `url`, `title`, `body`/`description` |
| `read` | `id` | 同 `create` 的实际远端内容 |
| `reconcile` | `submissionId` | `{ issues: [...] }`，必须保留正文中的提交标记 |

创建回执必须返回真实 Issue 编号和目标项目内的实际链接。CLI 成功退出、打开浏览器、返回预览地址都不构成发布完成。

## 诊断与隐私边界

排查配方在 `src/recipe.ts`，版本 `feedback-diagnosis/4`。Bug 分析自动准备版本、问题描述和近期错误线索；功能建议生成需求、使用场景和建议方案，不采集错误日志。Host 只提供运行信息和真实日志来源；插件采集当前实例及所选项目 `logs` 目录最近 15 分钟的有界错误摘要，每来源最多两个文件、每文件 128 KiB。没有资料会显示缺口，不递归遍历目录、认证、完整配置或会话数据库。项目目录由 Host 校验访问规则。

本地 Client 可能使用云端模型，脱敏材料会发送给该模型；界面在开始分析前说明，可展开查看材料。错误摘要是模型输入，不会作为原始日志附件直接上传到 Issue；最终报告可能引用相关线索，提交前仍需检查。普通 Client 沿用已有权限、项目规则和原生历史，prompt 的“默认只读”不是沙箱。新回复使用可读的 Markdown 标题和正文；插件兼容旧 JSON、正常身份签名和转义换行。普通消息历史投影提供当前请求的持久化完成状态，丢失实时事件或关闭重开也可恢复完成报告；无效输出明确失败，不会永久等待。进展静默更新，不重建整页。最终报告再次脱敏，以正文预览供用户检查与编辑；“停止等待”不会强制终止 Client。

准备任务先留记录再创建线程，创建结果未知时显示待核对，不自动重复创建。插件停用/进程重启后无法证明继续的旧运行显示中断，并提供原对话入口；不会永久显示运行中。项目日志解析后的路径必须留在所选项目内，项目外 junction 不纳入材料。

上传前先持久化 `writing` 状态。网络超时、进程退出或回读不一致会保留 `unknown`，只能核对远端，不会自动重发。查不到结果不代表未创建；人工核对前不建议手动再建。已取得真实链接但回读失败时，显示“已创建，待核验”和链接。附件逐张记录回执，明确尚未进入建单阶段的失败可保留回执后返回编辑，不会自动重传。恢复核对最多查看最近 100 条 Issue；无法找到唯一标记时保持待核对。

## 验证

```sh
pnpm --filter @clowder-ai/feedback typecheck
pnpm --filter @clowder-ai/feedback test
pnpm --filter @clowder-ai/feedback build
```

单测使用合成日志、测试凭据和远端替身；真实模型、GitHub/GitLab 写入及企业附件适配器需要在目标环境按实际配置验收，不能用这些测试代替。
