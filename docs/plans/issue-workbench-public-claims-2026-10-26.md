# GitHub 公开认领与宿主收件

来源：`thread_mucwsgsjtlbabfcq#0001792978585205-000120-871a3b48`。
延续原 Task 与 PR #80，不修改正在使用的宿主实例。

Before：认领依赖工作台本地记录/其收件开关，接收方需要工作台才能进入后续流程。
After：工作台派工写入 GitHub Assignees；成员可在 GitHub 原生界面认领、取消认领，其他人直接在 GitHub 看见。接收方的通用 GitHub 接入将事实送到宿主对话，猫通知本人，并由宿主按本人授权接续开发。本轮未新增工作台取消认领按钮。

## 事实、通知与开发权限

- GitHub Assignees 是当前负责人真相，GitHub assigned/unassigned 时间线保留历史；不使用独占标签、隐藏 JSON 评论或浏览器缓存作为认领前提。
- GitHub 原生添加/移除本人 Assignee 都应生效；取消只移除本人，保留其他负责人和已有成果。
- Issue 工作台负责展示和操作入口。接收走 `official.github-operations` 的通用 GitHub 连接，使用公共 SDK `messaging.send` 进入 Host 普通会话路由；不依赖 Issue 工作台、其 MCP、其收件存储或特殊评论格式。
- 每位成员在自己的宿主配置其 GitHub 身份、关注仓库、通知对话和协调猫。本次只在原独立实验启用，测试接收人为 YukinaXSer。
- 外部负责人变化是事实观察，不等于远端任何人都能授权本机运行代码。宿主先通知 co-creator；本人明确接手或已有适用的自动开工授权后，沿宿主原 Task/开发流程执行。不会伪造用户消息或绕开 Task admission。
- 取消认领会通知宿主停止把它当作当前认领；未开工不再启动，已开工由原宿主责任人处理暂停/交接，保留成果。

Architecture cell：GitHub Work Item Signals。
Map delta：在既有 GitHub 采集归属内增加本人认领观察；不增 Host 私有接口或第二套执行任务权威。
Why：GitHub 是跨成员公共事实，Host 负责对话、目标、授权与开发执行。

## 实施与验证

1. `packages/github-operations/src/assignment-provider.ts`：使用现行 gh 传输、完整分页、当前账号与 assigned/unassigned 事件 ID；失败不能解释为空认领。
2. `assignment-inbox.ts`：显式启用后的首次补收、持久去重、撤销/关闭/重认领、失败恢复、配置/身份变化与 stop；只投递受限元数据和标准 Issue URL。
3. 通过现行 manifest Settings/定时调度/重试动作和插件生命周期接入；沿用宿主公开 messaging 能力。
4. 真实隔离宿主安装打包制品，禁用 Issue 工作台后，在本人 fork 测试 Issue #1 上认领→收到 Host 消息→取消→收到撤销；重启、重放不重复，外部操作不触达其他成员或业务 Issue。
5. 接收、通知、授权开工、实际开发分别留证，不能用消息 ID 冒充开发已启动。成员 Mac/Windows 分工仍是同一 Task 的另一个未完成结果。

验收重点：接收方无 Issue 工作台仍收到；GitHub 上其他成员能看到同一负责人；撤销不被旧 pending 消息重新启动；离线新认领首次补收；同账号重新认领以新 GitHub 事件区分；源读取失败不发送假撤销；来源正文不得携带 Host 路由或执行权限。

## 手工验收入口（独立实验）

1. 打开 [实验宿主](http://localhost:5142/) 和 [认领收件对话](http://localhost:5142/thread/thread_mvkpxzwvqanuqkru)。原工作实例不重启、不改配置。
2. 在实验 Settings → Plugins → GitHub Operations 查看：接收我的 GitHub 认领开启，仓库 `YukinaXSer/clowder-ai`，通知对话 `thread_mvkpxzwvqanuqkru`，协调猫 `issue-lab-analyst`。在测试接收时停用 Issue 工作台，以验证它不是前提。
3. 用本人账号打开 [测试 Issue #1](https://github.com/YukinaXSer/clowder-ai/issues/1)，在 Assignees 中选择本人 YukinaXSer。GitHub 页面与 assigned 时间线应公开显示本人。
4. 等待一分钟左右，或在 GitHub Operations 中点击「重试认领同步」。宿主对话应收到仓库、编号、本人账号及来源链接；协调猫向本人转达。重复点击不重复投递同一次认领。
5. 在 GitHub Assignees 中移除本人。公开当前负责人应为空，时间线保留撤销历史；宿主收到取消通知，不按旧认领启动新的开发。
6. 再次添加本人应形成一条新的认领通知；停启 GitHub Operations 后重试，同一次认领不重复。
7. 最后移除本人，保留测试 Issue 为 Open、无负责人，供下一次手工验证。恢复 Issue 工作台以继续查看问题，但它的旧收件开关关闭，避免两个接收器重复通知。

本测试 Issue 的正文明确只允许通知验收，不要求实际修代码。实际开发的入口是宿主普通对话，由本人明确接手或适用的已有授权驱动；本轮不把收到通知或猫被唤醒当作「已完成开发」。成员角色/系统权重仍在原 Task 内续做，当前未配置成已生效规则。

## 首轮自检记录（修正前）

- 真实宿主发现并修复了 Settings operation 缺少 `render`，补了失败回归。
- 真实宿主拒绝 `threads.get` 的 `thread.readContent` 权限；改用已有 `threads.getCats` 元数据能力校验目的对话和可路由猫，不扩大宿主权限，补了默认无内容读取权的回归。
- 最终代码 `4bf424e17e003be11ca9db3f6553d87c0bda70f8` 已同步上游 `ec0ef60`。GitHub 包 743 项通过、1 项既有跳过、0 失败；typecheck/build 通过。全仓 `pnpm gate:ci` 36 项一次完整通过（720 秒），记录在 `packages/issue-workbench/artifacts/public-claims-2026-10-26/upstream-gate.log`。后续本文件仅补充验收记录，不改变被验证的源码或制品。
- 制品为 `@clowder-ai/github-operations@0.1.0-alpha.28`，已安装到 3142/5142 独立宿主。打包记录为 `packages/issue-workbench/artifacts/public-claims-2026-10-26/github-pack-alpha28.json`；integrity 为 `sha512-zyPVsDszwuwOlQ8TYQapOtKOXfS1lxrwwIxedQFAM9FHk46JPzzfFJT7uJeqZuzFqHVai88RYG+kbRZl39skNw==`，与 candidate catalog 一致。
- 认领消息：`0001792980286142-000000-8718addf`；原生 GitHub assignment event：`34217307307`。实验猫已向本人转达认领和撤销；第一次撤销消息 `0001792980328668-000002-07c305af`，停启后仍是原两条通知。重新认领使用新事件 `34217676813`，新通知 `0001792980625455-000004-7819083d`；最后撤销 `0001792980740921-000006-4919a57c`。
- 最终 alpha.28 再次在工作台停用时验收：认领事件 `34218560767`、通知 `0001792981714247-000008-014ce3d4`、猫回复 `0001792981714267-000009-80186307`；撤销通知 `0001792981949578-000010-5fbbb9ca`、猫回复 `0001792981949597-000011-49be2999`。
- 早期完整门禁发现英文 README 未按字面按钮名标记，随后发现 alpha.16 已发布、不得替换摘要。现已修正文档，并同步上游最新 alpha.27 后新增 alpha.28 候选；历史已发布版本的 catalog 条目保持上游原值。失败日志保留，最终 36 项通过不覆盖或抹除早期失败。
- 最终远端 HEAD、远端 CI 和独立 review 以 PR #80 实时记录为准；本地通过不代表远端批准。未合入、未发布 npm。

Architecture ownership：既有 GitHub Signals cell 内扩展采集和事实通知；普通 Host 消息负责持久投递与唤醒。Host 源码、权限策略和 Task admission 无新增修改。插件仓不具备家内 `check:architecture-ownership` / tips seed 检查入口；操作指引随双语 README 和本验收文档交付。

## 首轮实物与边界（2026-10-26，修正前）

- 作者在实际 Hub 收件对话打开并展开猫回复，确认可见认领通知、撤销通知和猫转达内容；浏览器无页面错误。采样当时 Issue 工作台 `stopped`、GitHub Operations `running`。
- 三次认领、三次撤销，共六条源通知和六次实际猫回复；首次停启和重复手工同步未新增同一事件通知。最后一轮运行 alpha.28；浏览器截图来自较早的同功能候选，最终版本另有真实 API 与猫回复证据。测试结束为 Open、Assignees 空。
- 独立宿主仍为 `cat-cafe-issue-workbench-lab`（Hub 5142 / API 3142 / Redis 6358）；原工作实例代码、配置和数据未修改。试验租期到 2026-10-26 21:28 Asia/Shanghai，届时停服务、保留数据。
- 实验猫已回复本人，但其 `gh` 直接联网复核被只读网络沙箱拒绝；未把通知观察当作当前 GitHub 核验，也未启动开发。通用连接自身的真实 GitHub 读取、Host 普通投递和唤醒已通过。实际开发仍需宿主适用授权及工具能力；专用测试 Issue 明确不要求修代码。
- 工作台已恢复启用，其旧 `receiveAssignments` 关闭；通用 GitHub `receiveAssignedIssues` 继续开启，避免重复接收。原工作区不受影响。

本地完整证据位于独立宿主 `.cat-cafe/lab-evidence/public-claims-2026-10-26/`（最终消息、启停与包摘要、浏览器截图）；不把整段实验对话或账号配置提交到公共仓库。

## 独立审查后的修正

水兵月对 `03de7a7` 提出两项阻断：managed-user 登录名中的下划线被收件器拒绝，以及双语安装说明仍要求核对 alpha.27。现将 Settings 探针与认领收件统一到 `github-login.ts`，保留显示大小写、身份比较时规范化；两份 README 均核对 alpha.28。

新增四个行为用例在原实现均失败：managed-user 本人读取、普通账号遇到其他 managed-user 负责人、这两种情形的收件持久化/重启/撤销/重认领。修复后相关 24 项和 typecheck 通过，完整 GitHub 包 747 通过、1 项既有跳过、0 失败。未新增 fallback；本插件仓没有 `check-fallback-layers.mjs`，人工检查此次 diff 无新后备分支。

新制品仍为未发布的 alpha.28（重新打包前 registry 精确版本返回 404），打包记录为 `packages/issue-workbench/artifacts/public-claims-2026-10-26/review-r1/pack.json`；integrity 为 `sha512-27f4P9lkKfAgtav6oMHUuIIe5vmnFha0HuwGEfYnah04/HSnl8pmVKIkr4qP8DYhgm39xwqM+1rQ9SU3OANIWQ==`。前文旧摘要及三轮通知属于修正前的历史证据，不能作为新制品安装或最终门禁回执。

修正后的同一制品已在原独立宿主更新，保留原 plugin instance。停用 Issue 工作台后，再次认领和取消本人测试 Issue；本轮两条通知为 `0001792983401700-000012-68b05d46`、`0001792983471063-000014-8530448c`，两次猫回复为 `0001792983401755-000013-41324617`、`0001792983472245-000015-f88a3a4f`。重复同步没有重发；仍未启动实际开发。

本轮补齐独立状态快照：通知时工作台 `stopped`、通用 GitHub `running` 且摘要匹配；作者实际打开 Hub 并展开本轮取消回复，截图与浏览器日志均记录新摘要，page errors 为空。首次浏览器检查因等待中的模型回复尚未包含旧固定措辞而失败；改为核验稳定的取消通知内容，保留首次失败日志，没有修改产品行为。

测试结束直接以 `gh issue view` 回读：测试 Issue 为 Open、Assignees 空（`updatedAt=2026-10-26T02:57:37Z`），并恢复工作台运行。证据在 lab 的 `.cat-cafe/lab-evidence/public-claims-2026-10-26/review-r1/`，汇总为 `acceptance.json`，状态及最终 GitHub 回读不再只依赖作者文字说明。

首轮局部审查的两项修复不代表完整工作台已验收：Windows/macOS 硬筛选、部分成员职责与分配权重尚未实现。用户要求的完整动线审查仍须覆盖这些缺口；原 reviewer 在接续该审查时报告 `quota_exceeded`，不能把该退出当作批准。

修复代码 `3d9cdec3995f67ee100a22d734b949647d29f617` 的完整 `pnpm gate:ci` 36 项通过（523 秒），见插件 `artifacts/public-claims-2026-10-26/review-r1/gate.log`。后续仅补验收文档，不改被验证的源码或制品。候选依旧未发布，远端 CI、独立复审和整体需求完成状态分别核验。
