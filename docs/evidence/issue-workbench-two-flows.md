# Issue 工作台两条流程与接单入口 · 2026-10-23

需求来源：`thread_mucwsgsjtlbabfcq#0001792720019489-000003-73541c9f`；
独立续做授权：`0001792720429391-000012-f711d500`。
沿用插件 PR #80，宿主未改、未合入、未部署生产。

## 本轮实现

- `initialClassification` 可选地对接入仓库 Open/Closed 历史做一次猫分析，重启续跑。
- 人工类别、分析备注与历次版本存于安装实例的 CAS 存储；分组、详情和派工共享有效类别。
- 独立 `automaticAssignment` 扫描 Open 问题；人工分类可在猫还没回复时用于派工。
- 当前组织成员自提、Feature、类别规则的优先级保留；暂停队列、来源变化和不确定发布继续限制副作用。
- 安装页使用宿主已有的认证 webhook 路由提供打包 HTML/JS/CSS，全部读写走公开 owner-operation。
- 接收者在“我的收件”明确接单，记录重启可恢复；提供原收件对话链接和开工指令，最终由本人发送用户消息托付正式任务。
- 新页面完整读取 GitHub 讨论；评论分页校验同一版本。旧预览文件数据不自动迁入安装实例。

## 验证与证据

新增回归先红后绿：首次自动分类缺失、人工改类不驱动规则、无主人的接单入口、
讨论未读取、待猫结果挡住人工规则派工。`test:team` 当前 78 项通过。
隔离真实宿主的 `test:host` 13 条旅程检查通过；模型结果、账号、GitHub 网络与
有效 grants 使用显式夹具。宿主源文件及关键编译文件前后相同。

可复跑命令：仓库固定 Node 24.18.0 / npm 11.16.0 工具链下运行
`pnpm --filter @clowder-ai/issue-workbench test`，以及设置
`ISSUE_WORKBENCH_HOST_ROOT` 和 `PLAYWRIGHT_CHROMIUM_EXECUTABLE` 后的
`pnpm --filter @clowder-ai/issue-workbench test:host`。
本轮制品、完整日志、报告与两张页面截图位于
`packages/issue-workbench/artifacts/two-flows-2026-10-23/`。
最终提交的完整门禁结果另记在该目录，不把中间版本测试当作最终 HEAD 通过。

## 尚未达成的真实验收

宿主 `machine-catalog-provider.ts#resolveLocalPluginEffectiveGrants` 对无宿主策略项的
插件返回空 grants；当前策略不包含 `dev.clowder.issue-workbench`。包内 manifest
或远端 catalog 不能扩大宿主授权。实际运行的猫咖仍不能完成本插件的授权激活。

2026-10-20 用户曾明确撤回专属宿主白名单改动（PR #1639 已关闭），后续又要求
不改宿主完整验证；该撤回仍有效。本轮没有恢复旧补丁、修改库存授权或复用其他插件身份。
隔离测试注入权限证明公开接口可协作，不是实际安装的授予入口。

所以整体 Task 保持未完成：仍需一个获准使用的真实宿主授予路径，以及指定的真实
Issue、接收账号/对话和实际猫执行回执。不能用本地接单记录、合成分析或测试权限替代。
