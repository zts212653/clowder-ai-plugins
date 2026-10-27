# Issue 团队联动候选：2026-10-20

完整用户旅程：**尚未走通**。本记录描述 PR #80 中的候选实现和隔离验收，
不代表用户安装、在线猫已调用、真实双账号派工、模型训练或 Feature 完成。
PR 保持不合入。授权源：`thread_mucwsgsjtlbabfcq#0001792487469228-000178-8c6b1ebb`。

**当前边界（2026-10-20 15:18 UTC 用户纠正后）**：仅更新插件 PR #80。
宿主配套 PR #1639 已关闭，授权策略、测试与验收脚本已由 `459935be8` 全部撤销；
其完整文件树与扩改前基线一致。本地源分支同一改动已由 `30a4a5efa` 撤销。
下文实际 Host 验收记录依赖该已撤回策略，保留为历史事实，不证明当前可安装、
可授权或已联动，也不再构成待合入依赖。生产配置和用户数据没有因此变更。
纠正来源：`thread_mucwsgsjtlbabfcq#0001792509520767-000070-c6435188`。

## 本轮实物与原约定

- 原生模块使用公开 SDK `0.2.0-beta.21` 的实例存储、调用身份、线程与消息接口。
  研判绑定原文版本、提交猫和调用来源，保存类别、1–10 分/未评分、理由、证据和替代办法。
  Feature 路由优先，负责人仅来自已保存规则；冲突、旧原文或已有其他负责人不自动覆盖。
- 三栏右侧接入「请猫分析」、结果/分数/当前 GitHub 负责人、明确人工反馈。
  顶部「团队记录」打开个人收件、研判历史和反馈统计；保留原分类、Open/Closed 与本仓记录。
  按类别/分数/历史派工成员统计，区分研判次数和独立问题，不称为训练或当前工作量。
- Owner Settings authority 与猫调用身份独立：页面请求不伪造 caller 或聊天消息；
  使用 `teamWorkbench` 公共 operation，路由与自动写入开关只读已保存的安装配置。
  权限撤回后清除页面旧数据；未安装/未接入时明确提示。
- 分析与收件详情均提供查重重试、明确确认再次发布。确认绑定当前 storage revision，
  旧确认不可重放；再次发布只处理评论，不再次分配成员。
- 撤销/关闭后向原对话发送一次持久变更提醒，失败后重试；同一分配关闭后重开会再次提醒，
  重启不重复通知，旧提醒历史保留。已投递、已接手、已验证仍是不同事实。
- 新业务/页面在插件 `src/team/`、`src/team-ui/`、`src/ports/team.ts`。
  Core export `031244712b8b62d1dc017ed379efd09b15dd4fc6` 只提供泛化 slots，
  并让移动端来源设置随工具栏实际高度定位。未改共享契约/生产数据/权限模型。

## 已观察的验证

作者实际执行了本轮模块和 packed browser 验收；独立 review 尚未取得。
仓库 `buildGateSteps()` 的完整 35 步全部通过；按现有工具链适配，仅 Feishu 下载步骤
使用 Node 环境代理。Pack gate 保留仓库已有 Feishu intake 例外，21 个发布包检查通过。

| 旅程与边界 | 证据 | 实际范围 |
|---|---|---|
| 页面请求 → 研判结果 → 保存反馈 → 统计 | `test/team-browser.test.mjs` | 实际 tgz 页面、真实候选模块、隔离 provider 与显式测试 authority |
| 收件回执发布结果未知 → 查重重试 → 确认再发 | 同上 | 首次 create=true，普通重试=false，确认后=true；无真实 GitHub 写入 |
| 旧原文提示、撤权清屏、手机与暗色布局 | 同上和 `artifacts/team-ui-2026-10-20/` 截图 | 桌面与手机截图已由作者检查 |
| 源读取/保存/关联/分类与移动端来源管理 | 原有 packed browser 旅程 | 与新增团队入口同一构建，5 条全部通过 |
| 身份隔离、明确反馈、恢复/幂等与版本检查 | `test/team*.test.ts`，22 项 | 有界行为测试；另有两个隔离 Host store 的离线派工/补收/接手回报 |
| 真正 Host 准入与 Settings carrier | Core `check-issue-workbench-artifact.mjs` | 临时文件 inventory、实际 ModulePluginRuntime/InstalledPluginOperations |
| Host Settings 状态/摘要与发布确认拒绝 | 同上 | status/summary 成功，无确认 republish 在 Host 返回400 |
| GitHub READ、停用拒绝、重启再读 | 同上 | 真实读取 `zts212653/clowder-ai#1628`，远端写入0 |

本轮确实观察到并修复的失败：缺少 owner action/变更提醒、缺少分析按钮、
同一分配重开后仍停在 inactive、收件详情没有发布恢复入口、移动端固定高度弹层遮挡关闭。
不是先写实现再给从未失败的检查计作 RED。

实际 Host 的调用身份来自明确验收 fixture；这些结果证明载体接线，不能证明
用户在线会话或真实两账号旅程。当时的 Host policy 来自配套
[PR #1639](https://github.com/zts212653/clowder-ai/pull/1639)，现已撤销并关闭，从未合入。
门禁日志、最终 tgz 摘要和当前 HEAD 写入 `artifacts/team-ui-2026-10-20/acceptance.json`；
该文件是本地验收记录，PR 检查状态以 GitHub 当时 HEAD 为准。

## 尚未完成

1. **用户实例安装和工作台入口**：Core main 已支持公开 module，但本插件的配套授权策略已撤回，
   需重新核验现有公开接口与安装授权能否满足；此前载体验证属于已撤回方案的历史证据。
   独立 READ 预览尚无已安装 Host 的 owner route，显示未接入；`createTeamClient(hostRequest)`
   是已验证的绑定入口。不能拿 fixture 页面宣称用户正常入口已能联动。
2. **在线猫与真实双账号旅程**：成员 GitHub 用户名/分工、接收端配置尚缺；不能代猜账号或启用生产自动写入。
3. **完整生命周期和迁移**：用户实际授予/撤回、升级/重装、旧记录迁移与正式独立评审仍需验收。
   `hostInstallable:false`，未加入 catalog、未发布 npm，原记录不迁移或删除。

五轴风险：行为增量（研判/恢复/反馈）、持久数据（新可追溯记录，无 TTL）、
安全（独立 owner authority）、契约（消费公开 SDK，无共享修改）、外部写入（需安装配置和确认）。
Architecture cell：插件业务与公开 Host adapter。Map delta：插件原生团队运行时与界面；
不复制 Host Task 权威。未完成项继续保留在同一 canonical Task。

## 月野兔额度耗尽后的作者接续检查

接续授权：`thread_mucwsgsjtlbabfcq#0001792496061606-000036-a10cdea1`。
月野兔本轮仅留下接单消息，没有提供两个候选 HEAD 的独立 verdict。
以下是作者自检和修复证据，不替代独立审查；两个 PR 继续不合入。

发现并复现了同一授权时序缺口：native caller 只在入口和少数局部步骤检查，
GitHub 查询期间调用失效后仍可能写入；Settings `teamStatus/retry` 只检查入口，
没有将 owner authority 传到异步恢复流程。另有读取结果返回前的同类缺口。

修复将授权绑定到每次排队操作，覆盖原生调用、owner action 和 owner recovery；
写入前、返回前复检，结束后清理上下文。定时恢复继续按已保存安装策略执行，
不继承上一次失效请求。`test/team-authority.test.ts` 通过真实 runtime/module 入口
检查：查询期间失效阻止派工、读取失效、详情回执读取后失效、保存回报意图后失效、
Settings 重试失效及后续定时恢复。初始三条用例（派工、原文读取、Settings 重试）
已观察到修复前 `Missing expected rejection`，修复后转绿；其余两条补查同类边界。

PR #1639 的 grants 策略、声明交集与安装身份保留逻辑已回读；本次没有改动
Core，也没有将源码自检表述为独立放行。完整 35 步门禁与 5 条打包页面旅程通过；
其中团队行为检查为 27 项，包含本次 5 项。验证时记录的三份源码/测试 SHA256
均与提交前文件匹配。本轮日志与摘要记录在
`packages/issue-workbench/artifacts/team-authority-2026-10-20/verification.json`。
