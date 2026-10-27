# 派工选择、补充负责人和退回改派

来源：`thread_mucwsgsjtlbabfcq#0001793005387590-000003-2ea1407a`（2026-10-26）。责任：砚砚 / gpt-6-astra；原 Task `0001791620604302-000089-54218821`，继续在 PR #80 与 `feat/issue-workbench` 实现。

## 用户可用路径

- 新派工收件人默认留空，必须选择成员或点击“采用推荐人选”，再确认。推荐不自动成为用户选择。
- 邀请发出而 GitHub 仍未认领时，选择区保留，可以改为“设置 GitHub 负责人”并明确选人。完成记录不可改写，使用当前来源与新请求创建派工记录。
- 已有 GitHub 负责人时，显示“在 GitHub 退回或改派”。接收人在 Issue 评论说明原因，移除自己的 Assignee；没有权限时请仓库维护者协助，不移除其他共同负责人。协调人刷新团队结果，再选择符合系统/职责的成员确认派工。
- 不要求接收人安装工作台。GitHub 原生通知和 Issue 页面是公共入口；通用 GitHub Operations 的认领收件将原生认领送入本人配置的普通宿主对话。邀请评论尚未建立认领，不触发通用认领收件。
- 当前负责人以实时 GitHub 为准，历史邀请和历史派工只描述过去动作。旧分析、邀请与派工记录保留。已绑定收件人的未知发布结果仍使用同一记录恢复，不开放换人。

本轮没有新增工作台的撤销写入 API，也不代替接收人接受开发任务。GitHub 原生改派不会执行工作台的成员/系统筛选，协调人仍需核对指定七人及其职责。默认指引为退回后由协调人重派；没有把未答复的可选偏好问题当成授权接收人自动改派。

## 根因与修复边界

`TeamAssignment` 原来以 `preferredLogin` 初始化用户选择，并在历史记录为 `invited` 或 `assigned` 时直接返回空。用户因此没有明确选人也能确认，发出邀请后则失去补充负责人的入口。`TeamRecordView` 还把历史邀请固定描述为等待接手，即使 GitHub 已被认领。

此次仅调整现有团队 UI、回归测试及双语说明。后端权限、成员环境和职责限制、当前来源校验、发布去重与持久记录模型未改变。未完成研判仍可向相同的现负责人公开分析；已完成记录保持不可变。新请求使用当前来源版本，并继续通过原后端成员/系统/权限检查。

## Quality Gate

五轴：behavior=中（选择与后续操作）；data=低（沿用已有新建派工和历史记录）；security=低（无新增权限）；contract=低（无 SDK/API/schema 变化）；irreversible=外部 GitHub 写入仍需原有明确确认。

Architecture cell：既有 Issue Workbench 团队 UI；Map delta：none。未新增路由器、存储或后备链。tips_exempt：独立插件的现有操作修复，随双语 README 和页面指引交付；此仓没有家内 capability-tips 或 architecture-ownership 检查脚本。

本轮实际验证：

- 初始五个 UI 反例均在旧实现失败；恢复场景另一个反例证明不能清空已绑定的未知发布收件人。修正后 UI **29/29** 通过。
- `pnpm lint` 通过（类型、Core 导出摘要及私有依赖边界）；`pnpm test` 的 5 项同步、29 项来源/接口、29 项 UI、1 项数据、94 项团队测试全部通过；build、打包和 `git diff --check` 通过。
- 打包后的两个团队浏览器流程通过。其中新增完整操作：空选择禁用 → 明确采用推荐 → 发邀请 → 刷新仍可补负责人 → 确认认领 → 重进不重发 → GitHub fixture 移除本人 → 刷新改派同系统另一成员 → 重进保留新负责人与三条历史记录。
- 这些浏览器流程运行实际打包的 UI 与团队 runtime，但 GitHub 和收件成员为隔离 fixture，未冒充真实多人联调。最初浏览器命令因当前 PATH 缺少可用 npm 而未能打包；失败日志保留，使用仓库既定 Node 24.18.0 / npm 11.16.0 后通过。
- 本次没有重跑全仓 36 项门禁。旧 `d9acb36` 的完整通过仅属既有范围证据；本轮 UI/文案增量由包级检查与受影响打包流程覆盖，不宣称旧 gate 验证新 HEAD。

## 作者实际页面核验与边界

作者沿独立 Hub `http://localhost:5142/` 建立会话，打开 API 3142 的实际已安装工作台，进入用户正在使用的 `YukinaXSer/clowder-ai#1`。该 Issue 已由用户在 08:59 UTC 认领，当前负责人是 `YukinaXSer`。

安装保持原插件实例、配置及历史数据，最终制品：
`sha512-ZZd1V7O2LaFf/2iDs+rB6DArenJY9Mz3Gu0s+Hy61FnjZl1i3/FKayj3W80UNVtTm8hfCYcs9jKiiBSeVsH9Og==`。

实际页面确认当前负责人仍在，历史邀请不再标作等待接手，退回/改派链接指向该 Issue，刷新及重进仍正常，移动端无横向溢出，无 pageerror。没有对用户当前认领执行取消或重派，也没有新 GitHub 评论/通知。本轮真实 GitHub 写入为 **0**。真实 GitHub 的完整退回/换人交互未在本轮执行；对应完整流程在打包隔离测试中走通。

插件工位：`/Users/yuki/Documents/AINest/clowder-ai-plugins-issue-workbench`；实验宿主：`/Users/yuki/Documents/AINest/cat-cafe-issue-workbench-lab`（Hub 5142 / API 3142 / Redis 6358）。原工作宿主不变。

本地证据：插件 `packages/issue-workbench/artifacts/owner-recovery-2026-10-26/` 的 RED/GREEN、build、打包、浏览器日志及截图；实验宿主 `.cat-cafe/lab-evidence/owner-recovery-2026-10-26/` 的安装回读、浏览器操作、桌面/移动截图。该目录按既有约定不提交整份本地数据。

独立审查绑定最终新 HEAD；旧 `2cceeec` 的 approved 不批准本轮改动。独立 reviewer 浏览器能力缺口继续如实记录，不要求其把作者截图核对写成本人 DOM 操作。PR 未合入，候选未发布。
