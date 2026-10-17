---
feature_ids: [repo-sync]
topics: [workbench-ux, delivery-history, cancellation, retry, auto-merge]
doc_kind: implementation-plan
created: 2026-10-16
---

# PR #77 工作台与可恢复交付实施交接

## 目标与范围

来源是本对话中对 PR #77 的连续反馈：用户需要在多个同步项目之间快速切换；工作台和设置页应各司其职；所有待办操作应有明确入口；每笔同步能查看完整历史和对象明细；未合入 PR 可以安全放弃并重试；自动合入必须由用户逐项目主动开启，默认关闭。过程模式还必须完整保留来源 PR 的开发提交、Issue 及内外 SHA 映射。

本方案只覆盖现有 `feat/repo-sync-plugin` 分支，不创建第二个 PR。CodeHub/GitHub 的真实账号、仓库和凭据不进入本计划、测试夹具或 PR 评论。平台 API 的 mock / 本地 Git 证据不能写成真实内网验收。

## 当前现场与已知证据

- Worktree：`G:\AIwork\clowder-ai\worktrees\feat-repo-sync-plugin`；分支 `feat/repo-sync-plugin`；当前本地 HEAD 和本地 `fork/feat/repo-sync-plugin` 跟踪引用为 `ebb2ba5`。
- 工作区已有大量未提交实现和测试，包括侧栏、同步详情、撤销交付、开发提交重放、自动合入开关。它们是待审草稿，不应因为文件已存在就视为验收通过。
- 完整 `pnpm --dir packages/repo-sync test:browser` 在 `connection-browser-check.mjs` 失败并短路后续矩阵。单独复现得到的任务状态是 `STOP_UNCONFIRMED`，不是 `CANCELLED`：Windows 测试中的 Git 子进程树退出未获确认，执行器按保护规则保留执行锁。测试断言却只等待“已取消”。这项机制和测试夹具需要先查清，不能把 `STOP_UNCONFIRMED` 改成成功来让测试变绿。
- 5220 返回 HTTP 200，页面能显示项目侧栏；`/api/status` 显示正式服务和未配置的默认项目。当前监听进程被 `preview:process status` 判定为 `unmanaged`，所以端口存活不能证明它加载了当前 worktree 的最新代码，也不能作为配置后完整试用的证据。
- `gh auth status` 显示 GitHub token 无效；`git ls-remote fork` 因 Windows Schannel 没有可用凭据失败。因此目前不能确认远端 PR HEAD、推送分支或发评论。当前工作尚未提交、推送或回复 PR。
- `.repo-sync-tests/` 是本地 Git 测试数据，必须排除提交。`FIX_PR77_SUMMARY.md` 是未跟踪的现有文件，先保留并由维护者决定是否属于交付；不要自动加入 PR。

## 已定产品契约

1. 一个工作台管理多个独立项目。每个项目有自己的仓库绑定、同步模式、任务和历史；两项目不得接管同一内部仓库与目标分支。
2. “同步工作台”展示当前项目的进行中交付、进度和唯一主要下一步；“仓库设置”只展示当前项目配置。设置入口在项目列表项旁。切换项目不能把旧页面按钮误作用到新项目。
3. 已完成历史按每笔交付查看，包含源 PR、目标版本、内外 PR、Issue、提交数量和 SHA 映射、每个大步骤/子步骤状态与时间。历史详情只读，不和当前操作列表重复堆叠。
4. 只有确认尚未合入、原 PR 可查且主干未推进时，才能撤销当前交付。先持久化撤销意图再关闭 PR；回执不明时回读原 PR。不能回滚 main、删除候选分支、清除台账或创建重复 Issue。撤销成功后保留 CANCELLED 历史和 Issue 映射；显式继续才重新读取同一目标并创建新的交付/PR。
5. 如果原 PR 已合入或 main 已推进，拒绝撤销，转入合入核验。远端关闭能力缺失或关闭结果无法确认时，暂停在可恢复状态，不得伪报成功。
6. 自动合入按项目保存、默认关闭。开启自动合入不能绕过必需审查、批准、CI、分支保护或平台策略；不支持或结果不明时转人工/恢复核验，不重复提交合入请求。
7. 重写提交身份时仍逐条重建开发提交，不能 squash；记录每个外部 SHA 到内部 SHA。PR main squash 落点只作为接受游标/树验证，不代替 PR 的原始开发提交序列。

## 工作单元

### A. 单一清楚的工作台导航与项目切换

**改动位置**：`packages/repo-sync/web/index.html`、`app-shell.mjs`、`app-shell.css`、`projects.mjs`、`project-view.mjs`、`app.mjs`。

**实现**：侧栏显示项目名、模式/同步状态和每项目设置入口；项目切换、工作台/设置视图切换不重复渲染同一大块项目配置。工作台首屏给当前状态、当前交付和一个主要操作；辅助动作留在详情或菜单。移动端用可折叠导航，不改变项目绑定。

**不变量**：任何表单、异步回执和按钮操作都必须绑定渲染时的 `projectId`、`bindingId` 和交付身份；发生切换或状态变化时拒绝旧操作并提示刷新。设置页面不能显示另一个项目的草稿或认证内容。

**验收**：两个项目分别配置不同模式和仓库；切换后工作台/设置正文对应当前项目；设置入口正确；窄屏无水平溢出；切换后旧页面按钮不会提交到新项目；后台任务不因切页而停止。

### B. 可读的单笔交付摘要、对象映射与历史时间线

**改动位置**：`packages/repo-sync/web/delivery-overview.mjs`、`delivery-overview.css`、`history.mjs`、`workbench.mjs`；后端投影位于 `src/inspect-delivery-source.mjs`、`development-history.mjs`、`recording.mjs`、`ledger.mjs`、`task-store.mjs`、`server.mjs`。

**实现**：交付详情顶部直接显示源 PR 编号/标题、开发提交数量、main 落地提交数量、内 PR 地址、Issue 数量与 Issue 列表。展开提交表可见消息标题及外部/内部 SHA。时间线按一笔交付关联大步骤、子步骤、状态、开始/结束时间和可操作的 PR 链接。历史记录能直接打开同一详情；历史只读并清楚标出当时配置快照、tag/commit、仓库绑定摘要和同步位置。

**边界**：展示摘要以来源数据和持久台账为准，不用执行步骤数量推算 PR/Issue/commit 数；数据不完整时标为未知并给出恢复入口。Token、认证值和私有原始日志永不进入记录。

**验收**：18 个开发提交被上游 squash 成一个 main commit 的夹具，内侧仍显示并重放 18 笔且每条 SHA 可映射；Issue 逐条列出且区分普通关联与合入后关闭；刷新/重启后同一历史详情和时间线一致；旧绑定数据不能串到新项目。

### C. 未合入交付的撤销与重试

**改动位置**：后端 `src/cancel-delivery.mjs`、`actions.mjs`、`engine.mjs`、`ledger.mjs`、`task-store.mjs`、`tasks.mjs`、`server.mjs`、`transfer-state.mjs`；前端 `web/delivery-overview.mjs`、`form-submission.mjs`、`operations.mjs`、`recovery-navigation.mjs`、`action-policy.mjs`。

**状态顺序**：确认对象与主干状态 → 在写锁内落盘撤销意图并暂停轮次 → 请求关闭原 PR → 回读 PR 关闭/合入状态 → 将原交付标记 CANCELLED 并保留审计/Issue 映射 → 等待用户明确继续 → 重新读取同一目标并创建新交付身份。每个远端副作用都必须可幂等恢复。

**拒绝条件**：PR 已合入、main 已推进、交付对象不属于当前项目/绑定、无法唯一定位 PR、当前仍有写任务、平台不支持可核验的 PR 状态。拒绝时不得改动 main、游标、旧 PR、Issue 或历史。

**验收**：关闭请求成功；请求发出后进程崩溃；远端已关闭但本地回执丢失；PR 实际已合入；重复点击；刷新/服务重启；两个项目并发操作；内部 Issue 已存在；重试创建回执丢失。所有恢复场景都必须先回读原对象，不重复创建 Issue/PR。

### D. 用户可选的自动合入

**改动位置**：`src/auto-merge.mjs`、`actions.mjs`、`automation.mjs`、`server.mjs`、`recording.mjs`、`transfer-objects.mjs`、`transfer-state.mjs`；项目设置与工作台入口放在 `web/platform.mjs` / 设置表单对应模块及 `action-policy.mjs`。

**实现**：每项目显式勾选，首次配置、旧配置迁移和模板导入均为关闭；服务端动作再次检查开关，不能只靠 UI 隐藏按钮。只在指定 PR、必需 CI/批准/分支保护均允许时调用平台合入能力，并保存操作意图、远端请求回执、回读结果和时间。未知结果先查远端状态再恢复。手动审核合入仍是默认完整流程。

**验收**：默认配置和迁移后配置均关闭；显式打开后才允许提交；未批准、CI 失败、冲突、平台无权限、API 不支持、超时回执丢失均不被当作合入；已合入 PR 重试不重复合入；项目 A 的开关不影响项目 B。

### E. 修复 Windows 取消测试的真实性与执行证据

**改动位置**：先查 `src/terminate.mjs`、`src/process.mjs`、`src/tasks.mjs`；测试位于 `test/connection-browser-check.mjs` 和相关进程终止测试。

**实现**：先在 Windows 复现并记录具体 taskkill/进程句柄/退出确认结果。区分“子进程树已确认退出”与“无法确认”。只有前者标记 CANCELLED 并释放执行锁；后者保持 STOP_UNCONFIRMED、阻止新的 Git 写操作并提供核验/恢复指引。修正测试夹具或真实终止实现，让测试等待实际契约，不通过放宽断言伪造成功。

**验收**：取消长时间 Git 下载后，子进程及后代均退出；服务重启后任务状态和锁一致；无法确认退出时 UI 显示 `× STOP_UNCONFIRMED`、锁仍保留且可以按受控步骤恢复；修复后定向检查稳定重复通过。

## 验证矩阵与命令

在现有 worktree 的 `packages/repo-sync` 目录执行；不要连接用户生产 Redis，也不要在测试中使用真实内网凭据。

| 层级 | 命令 / 场景 | 通过标准 |
|---|---|---|
| 逻辑与 Git 合同 | `pnpm --dir packages/repo-sync test` | 多提交 replay、SHA 映射、撤销边界、自动合入策略、迁移/恢复和重复请求全部通过 |
| Windows 取消根因 | `node test/connection-browser-check.mjs`，并运行进程终止定向测试 | 子进程树真实退出才报告取消；不确定时锁不释放。连续重复测试不遗留子进程 |
| 浏览器用户旅程 | `pnpm --dir packages/repo-sync test:browser` | 全矩阵从头到尾完成，包含项目切换、当前任务操作、历史详情、取消/重试、暂停/继续、刷新恢复、移动端 |
| 静态与协议 | `pnpm --dir packages/repo-sync lint` | `scripts/check.mjs`、manifest 与 MCP 测试通过 |
| 正式构建 | `pnpm --dir packages/repo-sync build` | 仅正式产品入口打包，无 demo server 和测试夹具 |
| 安装消费者 | `pnpm --dir packages/repo-sync test:package` | packed consumer 可安装、启动正式 `setup/serve` 并读取工作台资源 |
| 真实试用入口 | 用当前构建按 `packages/repo-sync/README.md` 的 `setup/serve` 启动；检查 `http://127.0.0.1:5220/`、`/api/status`、Console、当前项目切换与页面截图 | 托管状态为 running；页面静态资源来自当前 worktree build；工作台明确显示未配置/待配置或真实绑定状态；未配置凭据时不声称完整同步验收 |
| 远端 PR 交付 | `gh auth status`、确认远端 HEAD、推送现有分支、PR #77 评论后 API 回读 | 只更新 #77；评论 UTF-8 无 BOM 文件提交；回读远端评论确认中文和关键结论 |

开发时遇到测试失败，先单独复现并记录任务状态/日志/页面信号；修正根因后再跑失败项和完整浏览器矩阵。不要把某个测试成功等同于真实 CodeHub 验收。

## 建议执行顺序

1. 先保全当前 dirty worktree，确认所有未跟踪数据归属；排除 `.repo-sync-tests/`、私有配置和非交付总结文件。
2. 先审阅并冻结 `development-history-and-retry` 计划中的提交重放、Issue 复用、取消与恢复契约；修复 Windows `STOP_UNCONFIRMED` 测试/行为分歧。
3. 完成历史摘要与侧栏/统一操作区的前端旅程，跑项目切换、详情历史及移动端检查。
4. 完成每笔撤销/重试服务端状态机及异常恢复矩阵，再串联浏览器路径。
5. 最后完成默认关闭的自动合入开关、服务端策略和失败回读；跑所有验证命令并重新构建 packed consumer。
6. 启动并核对 5220 托管试用服务；随后用有效 GitHub 凭据只更新现有 PR #77，回读远端 HEAD 和评论。

## 交付边界

收到此文档后，未提交代码仍在现有 worktree，用户接管前不要假定它们已验收。当前 GitHub 认证和 5220 托管启动状态是具体阻碍；恢复认证后才可完成推送/评论。真实 CodeHub PR/Issue、凭据和真实仓库同步需在用户自己的网络与账号下验证。
