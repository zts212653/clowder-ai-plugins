# Issue 工作台 group 与提交者优先：作者自验

后续变更：2026-10-21 用户已明确从 GitHub Organization 关联人员，手工名单方案
由 [Organization 接入](issue-workbench-organization.md) 替代。以下保留当时自验事实。

需求来源：`thread_mucwsgsjtlbabfcq#0001792510714026-000073-37b4fb6b`。
工作分支：Plugins `feat/issue-workbench`，本轮开始 HEAD `8150f16f599f41e586b010660d527db6a361f662`。
只更新 PR #80；未修改宿主、SDK 或生产配置。宿主 #1639 保持已撤回状态。

## 原始要求与实物

| 要求 | 本次实现与检查 |
| --- | --- |
| 分类后按用户派工 | 保留分类与优先级；面板选择组员、预览公开内容、确认单次派工。自动开关独立。浏览器完成确认、结果回读和刷新去重。 |
| 只有 group 成员才是工作人员 | `teamGroupName` / `teamMembers` 是独立名单；规则、仓库协作者、模型输出均不产生资格。自动、手动、重试、收件和进度发布检查成员资格。 |
| 组员自己提的问题优先本人猫猫 | GitHub API 的 `user.login` 为作者真相；组员作者优先于 Feature/分类规则；本人插件按本机账号补收，再通知本人配置的猫。无法指派时保留待处理，不静默换人。 |
| 合入前建议本人验收 | 面板、GitHub 派工评论、收件猫通知均显示建议；明确不是已验收、独立审查或自动合入。 |

历史状态（2026-10-20）：group 来源已询问，尚未收到确定标识。本轮显式采用插件内维护的成员组，
不宣称 GitHub Organization Team 自动同步，不填写猜测的真实账号。

## 观察到的失败与修正

- 初始六条 group 检查全部失败：缺少独立资格、作者优先、复检与收件限制。
  实现后全部通过，已有分类与 Feature 标签保留。
- 手动派工最初读取不存在的 SDK `owner.confirmed`。改为现有 manifest
  操作 `confirm`，由 Host 确认后传入公开 owner authority；未扩改 Host 契约。
- 浏览器先复现缺少组员选择；实现后又发现独立预览漏接 `assign`，
  修正插件自己的测试/示例路由后完整旅程通过。
- 新增复检带来的异步窗口曾在请求过期后漏出一次 fixture 派工。
  回归 RED→GREEN：成员/策略读取后、外部写入前再次检查当前请求授权；
  同类收件、回执和重发路径同步修正。
- 无效自动规则曾清空仍有效的组员选项。保留真实名单及错误提示，
  禁止自动派工，同时允许 owner 明确选择有效组员；回归通过。

## 验证与边界

本地工具链：Node 24.18.0、npm 11.16.0、pnpm 9，系统 Chrome。
工作目录 `/Users/yuki/Documents/AINest/clowder-ai-plugins-issue-workbench`。

- `pnpm --filter @clowder-ai/issue-workbench build`：通过。
- `node --import tsx --test test/team-browser.test.mjs test/team*.test.ts`
  （package cwd）：39/39 通过，包含两实例离线补收、当前成员资格、
  单次确认/重放、权限中途撤销、未知评论结果恢复。
- 扩充打包页面检查后再次运行 `test/team-browser.test.mjs`：通过。
  刷新不会重复指派；390px 无横向溢出；桌面和手机确认截图已由作者查看，
  延续已有三栏和窄屏研判页签，组员选择、公开内容与确认按钮可见。
- `git diff --check`：通过。
- 提交前完整仓库门禁：35/35 步通过，约 479 秒。执行仓库 `buildGateSteps()`
  的完整列表，仅飞书下载步骤沿用 Node 环境代理；原有飞书打包豁免未改变。
- 最终 `pnpm --filter @clowder-ai/issue-workbench test:browser`：5/5 通过，
  包括原有分类、多来源保存/恢复、公共 READ Host 和新增组员确认旅程。
  两个命令退出码均为 0；唤醒后重新核对 109 个文件摘要，无变化。
  日志、源码摘要和最终结论位于 `packages/issue-workbench/artifacts/team-group-2026-10-20/`。
  此后只补充本文和 VALIDATION 的结果记录，不重跑未改变的行为检查。

五轴风险：业务改变派工顺序；保留旧数据但作者指纹升级会要求旧分析重新研判；
资格与请求权限写前复检；仅扩展插件声明；测试未产生真实 GitHub 写入。
Architecture cell：现有插件 team runtime / team-ui；无新增 Host 归属或并行存储。
源码镜像和分类语料不变；仓库根目录无新媒体工件。

完整真实旅程**没走通**：尚缺已安装 Host 工作台入口、实际 group 成员与双账号在线猫验收。
隔离测试使用公开模块 ABI 和真实 packed browser，但 GitHub 写入与猫收件是 fixture；
不能把它们当作真实用户任务已派发。普通 READ 预览继续诚实显示团队尚未接入。
独立 review 与真实旅程留在原 Task，不合入 PR，不以作者自检作为 approval。
