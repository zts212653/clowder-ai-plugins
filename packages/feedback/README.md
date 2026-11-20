# 问题反馈插件

[English guide](README.en.md)

反馈面板使用 `next` 的 PDL 控制台。包内 `console/pdl.yaml` 声明侧栏入口和浮窗，`GET panel` 提供页面，面板通过通用 HTTP 桥调用 `POST feedback/panel`。宿主核验当前用户与安装实例，报告和图片沿用通用流响应。

从左栏底部进入，恢复上次编辑的反馈；点击“新建反馈”可开始空白表单，旧记录仍会保留。选择问题反馈（`bug:`）或功能建议（`feat:`），首屏只需描述或图片，标题在检查页调整。推荐“生成分析报告”：进入分析设置后选择成员和可选项目目录，再准备、检查脱敏材料；“直接反馈”不依赖 Agent。两条路径都需要检查最终报告、截图、目标可见性并确认提交。

顶部“反馈记录”独立展示每条草稿、分析中、分析完成待投递、待网页提交、投递待核对及已投递状态。旧反馈不会占用新建表单或锁住另一条反馈；分析完成可从记录中继续投递。分析成员和项目位于分析步骤，多个投递目标在检查页选择。检查与提交页用页码和翻页按钮阅读长报告；点缩略图可核对完整截图。窄屏先看报告，再进入截图与提交。提交目标旁显示缺失或失效凭据的配置位置，并提供重新检查。侧栏图标使用 PDL 原生图标，面板配色跟随浏览器的浅色或深色偏好。

输入后会延迟自动保存；切换记录以及点击 X、按 Escape 关闭时，等待当前图片处理和草稿保存完成。保存失败会保留窗口和输入，恢复后可以重试。此关闭行为需要支持 `close.guard` 的配套 Host；旧 Host 会显示升级提示，仍须手动保存后关闭。重新打开或刷新面板时，会续接当前未完成的反馈及其内容和分析设置。已提交的 Issue 可在「反馈记录」里查看，重新打开面板会直接进入新反馈。草稿卡片支持确认后删除。只修改分析设置也会保存。“新建反馈”的空白选择也会保留。历史无法还原旧版本已覆盖的更早内容。迁移保留原始记录和投递回执；复制手动创建链接后状态为待网页提交，不能据此认定已创建 Issue。

自动提交成功会返回平台实际创建的 Issue 链接，并回读标题和完整正文。手动创建仍可通过「复制手动创建链接」在浏览器中继续，链接不携带标题或正文；字段旁可复制标题、报告，每张图可复制 PNG 或下载原图后上传。

## 安装与宿主要求

控制台位于包内的 `console/pdl.yaml` 和 `console/i18n`，需要支持插件 PDL 控制台的 `next` 宿主。

分析使用普通 `members`、`threads`、`messaging` 和可选 `runtimeInfo.get()`。从「设置 → 插件」安装、测试并启用问题反馈，再从侧栏打开。

源码联调可构建本地包：

```sh
pnpm --filter @clowder-ai/feedback build
cd packages/feedback
npm pack --ignore-scripts
```

将生成的包通过插件设置中的本地包安装入口安装，保存配置、测试后启用。提交日志使用宿主按安装实例隔离的私有 CAS 存储；图片按 SHA-256 保存在宿主提供的 dataPath 中，避免占用单值 1 MiB 的日志预算。业务数据保留；停用、升级与卸载不会由插件删除草稿、图片或提交回执。

新建分析会话使用「问题反馈：简短描述」作为标题，放在选定项目下。

## 目标配置

默认目标是公开的 `zts212653/clowder-ai`。GitHub.com 自动提交可使用已登录的 GitHub CLI 或在「设置 → 插件 → 问题反馈」填写 `githubToken`。GitLab REST 使用 `gitlabToken`。令牌留在宿主 secret 字段。返回反馈记录可继续未完成的报告，并重新检查投递条件。

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

填写问题时可直接粘贴剪贴板截图，使用与聊天框一致的粘贴方式；“添加图片”的本地文件选择仍保留。两种入口使用同一预览、移除和持久化流程，普通文字粘贴不受影响。

最多 4 张 PNG/JPEG/WebP，原图与发送副本各单张 4 MB、各类总计 8 MB。完整请求（含两类图片、base64 编码、正文和分析设置）还受 15 MiB 限制，添加与保存前即检查；例如保留同等大小原图时，2×3 MB 或 4×1.5 MB 会被拒绝，需要减少图片或裁剪。图片在本地解码为 PNG，服务端再次去除元数据；预览和哈希对应实际发送副本，图片不交给模型。原图独立保留用于本地下载，可能包含元数据，不会自动上传。文字脱敏无法覆盖图片中的隐私，用户必须先裁剪、遮盖并检查。

填写、报告检查与手动投递阶段都会自动保存。版本冲突时可“另存为新草稿”，保留当前窗口的正文、图片和分析设置，不覆盖其他窗口。保存失败会在固定底栏显示原因；配套 Host 在关闭等待或失败时提供“仍然关闭”，确认后会丢弃本窗口尚未保存的修改。恢复指针更新失败不影响已保存记录，可从“反馈记录”继续。

GitLab 使用项目 Markdown 上传接口，上传后回读实际字节并核对 SHA-256。公开项目的上传文件可能通过直接地址访问，不能把 Issue 保密状态当作附件隐私保证。

初次提交只发送报告正文。Issue 创建后，可在反馈面板中预览并勾选原截图，或选择新的本地图片，再把所选图片上传到同一个 Issue 的评论。默认不勾选。GitHub.com 使用支持 `--attach` 的 GitHub CLI（2.99.0 或更新版本） 和有仓库写权限的凭据，也支持组织批准的 `attachmentCommand` 和 `attachmentOrigins`。GitLab 使用项目图片上传和 Issue 评论。上传结果不明时，先核对原 Issue 的评论。确认没有这批截图后，可回到插件重新选择上传。

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

排查配方在 `src/recipe.ts`，版本 `feedback-diagnosis/5`。Bug 分析自动准备版本、问题描述和近期错误线索；功能建议生成需求、使用场景和建议方案，不采集错误日志。Host 只提供运行信息和真实日志来源；插件采集当前实例及所选项目 `logs` 目录最近 15 分钟的有界错误摘要，每来源最多两个文件、每文件 128 KiB。没有资料会显示缺口，不递归遍历目录、认证、完整配置或会话数据库。项目目录由 Host 校验访问规则。

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
