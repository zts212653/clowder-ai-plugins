# meow-club 成员分工与手工验收

更新：2026-10-26。责任：砚砚 / gpt-6-astra。原 Task：`0001791620604302-000089-54218821`；[PR #80](https://github.com/zts212653/clowder-ai-plugins/pull/80)。
需求来源：`thread_mucwsgsjtlbabfcq` 中 `0001792777023468-000013-6f31ca3f`、`0001792777327931-000021-c6069708`、`0001792981241979-000136-cb9677b7`。
接续审查：`0001792984460300-000162-0094a79d`（Argon，原 HEAD `1c753aa7fab34b39d7f4c2a7737736b46fdfdcf1`）。

## 本轮实现契约

工作台仍是独立插件：分析原文与讨论 → 提取特征 → 人工/猫决策分类 → 按系统及成员职责推荐 → 主人确认派工或启用自动派工。GitHub Assignees 是团队可见的认领事实；普通 Host 用独立通用 GitHub 接收器接收认领、取消通知。完整收件链的既有证据见 [公开认领验收](issue-workbench-public-claims-2026-10-26.md)。通知不等于已授权开发；本人在普通 Host 对话中接续授权即可，不要求接收方安装工作台。

`YukinaXSer` 只代表 co-creator 本人。本轮真实外部派工仍只允许本人 fork 的 [测试 Issue #1](https://github.com/YukinaXSer/clowder-ai/issues/1) 与本人账号；其他成员仅用于本地推荐、排除验证。

### 成员资料

GitHub 组织仍是成员资格来源；配置不会增加组织成员。环境与职责取自用户要求。

| 账号 | 环境 | 职责 | 同级权重 |
| --- | --- | --- | --- |
| `zts212653` | macOS | 架构师、审核者 | 1 |
| `mindfn` | macOS | 架构师、审核者 | 1 |
| `whutzefengxie-ops` | Windows | 核心架构/功能方案；也参与普通 Windows 问题 | 1 |
| `EdgarR1170` | Windows | 普通成员 | 1 |
| `bkkzz` | Windows | 普通成员 | 1 |
| `liu-zhengdong` | macOS | 普通成员 | 1 |
| `YukinaXSer` | macOS | 普通成员、本人测试接收人 | 2 |

用户口述 `ts212653`，实时组织名单仅有 `zts212653`。本轮实验按实际账号 `zts212653` 配置架构职责，不生成虚拟别名，也不向该成员派出测试单。本人对普通 Mac 的精确比例未指定；`2:1` 是本轮可调整的实现默认值，用于落实“本人多分些”，不声称是用户原话。

配置入口为插件 Settings 的 `memberProfiles`。字段为 `login`、`system`（`macos` / `windows`）、`role`（`architect-reviewer` / `core-planner` / `member`）、`weight`（1–20 整数）。`routingRules` 继续只承载 Feature/类别分工；它不能绕过成员环境。团队记录与派工下拉框显示资料，未配置成员明确标注并排除。

### 结构化判定与派工顺序

- `IssueInvestigation.affectedSystems`、`routingFocus` 保存人工修正；猫用相同结构化字段提交。旧记录没有字段仍可读取。
- 优先级：已保存人工值 > 当前原文版本的猫结果 > 原文提取。显式 `affectedSystems: []` 是人工待判断；不等于退回自动模式。职责为普通问题、框架架构、核心功能方案。
- 原文变化时旧人工依据需重新确认；未保存的页面修正不能触发派工。
- 所有人工、自动、重试/重新发布入口统一限制单一已知系统。待判断、其他系统、跨平台均需先明确处理范围，不静默给单系统成员。
- 系统兼容后：职责优先 → 合格提交者 → Feature / 类别分工 → 普通成员加权。同级多成员允许分配，不要求恰好一位。
- 普通 Mac 由两位普通 Mac 成员分配；Windows 核心方案负责人也参加普通 Windows 池。架构师职责、明确 Feature/类别、普通加权各用独立计数池；作者优先和人工改选不消耗普通配额；主人确认推荐人选与自动派工一致计数，已有认领不重复计数。
- 同级选择最小“已确认派工数 / 权重”，相同则权重大者优先，再按账号稳定排序。GitHub readback 确认负责人后提交计数；评论失败保留已认领计数，失败指派不计数，重试使用同一持久记录一次计数。
- 计数范围是一个插件实例的持久记录；不宣称跨宿主全局负载均衡。保留已有其他负责人，不为 Closed 问题派工。

## 独立实验入口

先打开 [独立 Hub](http://localhost:5142/) 建立实验会话，再打开 [Issue 工作台](http://localhost:3142/api/plugins/dev.clowder.issue-workbench/workbench/installed.html)。完整 Host、Redis `6358`、数据目录和配置均独立。原工作实例无需重新部署。

实验仅开放 `YukinaXSer/clowder-ai`，自动分类、自动派工与工作台旧收件关闭；通用 GitHub 接收器开启。实验收件对话为 [本人测试收件](http://localhost:5142/thread/thread_mvkpxzwvqanuqkru)。运行租期至 2026-10-26 21:28（Asia/Shanghai）；到期保留数据。

## 手工验证推荐与拦截（不向其他成员通知）

打开测试 Issue #1，在右侧“分类分析”修改下面两项并点“保存分析”。先将测试问题类别选为“代码与交付”并保存，作为本轮明确的分类；类别仍待判断时，普通加权推荐会等待分类。每次只查看推荐、下拉框和排除说明，**不点“确认指派”给其他成员**。

| 人工系统 / 派工职责 | 预期结果 |
| --- | --- |
| macOS / 普通问题 | 本人是合格提交者，推荐本人；Windows 账号禁用 |
| Windows / 普通问题 | Mac 提交者本人不再优先；Windows 三人可选，Mac 账号禁用 |
| macOS / 框架与架构 | `zts212653`、`mindfn` 的同级职责池优先；Windows 排除 |
| Windows / 核心功能方案 | 推荐 `whutzefengxie-ops`；Mac 架构师也不可选 |
| 待判断 / 任意 | 明确要求先判断系统，派工按钮不可用 |
| macOS 与 Windows / 任意 | 要求拆分或确认单一处理范围，派工按钮不可用 |
| 其他系统 / 任意 | 显示暂无适配成员，派工按钮不可用 |

修改但不保存时，派工暂不可用。保存并刷新页面后选择应保留。测试后保存回 **macOS / 普通问题**。

加权分配不能用“本人自提的六个问题”伪造，因为作者优先不消耗普通池。自动回归使用外部作者、无 Feature 特定分工、干净持久计数六个样本，期望本人对应的 2 权重成员四次、1 权重成员两次；还覆盖失败、未知评论结果和重启。手工页面显示该规则与权重，不能凭单次推荐声称比例验收。

## 手工验证本人认领与普通 Host 通知

1. 在 GitHub 测试 #1 确认 Open、无负责人；工作台显示“未认领”。系统保存为 macOS，职责为普通问题。
2. 派工方式选“设置 GitHub 负责人”，选择本人 `yukinaxser`。点“指派任务”，确认仓库、编号、接收人，再点“确认指派”。
3. GitHub Assignees、工作台列表及详情都应显示本人已认领。派工评论本身不代替 Assignee。
4. 打开普通实验收件对话，等待通用 GitHub 接收器同步；应收到对应 Issue 的认领通知与猫回复。必要时在独立 Hub 的 GitHub 插件收件状态中重试同步。
5. 可停用 Issue 工作台，保留通用 GitHub 插件运行；在 GitHub 原生页面取消本人 Assignee，再同步，应在相同普通对话收到取消通知。工作台不参与这一接收过程。
6. 恢复工作台并更新来源，认领标记恢复“未认领”。重复同步不重复通知。不要关闭/删除测试 Issue 或实验数据。

如要测试实际开发，由本人在普通收件对话明确发出接手指令并确认开发范围；本轮路由与通知验收不冒充已修复实际 Issue。

## 验证记录

本轮实现前的失败证据、包测试与独立宿主证据分别保存在插件 `packages/issue-workbench/artifacts/member-routing-2026-10-26/` 与实验宿主 `.cat-cafe/lab-evidence/member-routing-2026-10-26/`。当前仍由原 Task 持责，未合入、未发布。

实现提交为 `7b8dabef230fce23db402cee30fad833dcf854a5` 与 `d9acb36ab5e239828c8eaf01e3084e2d72a48865`；下列结果均覆盖最终代码 `d9acb36`，随后仅补本文证据。

- RED：六个初始反例确认旧实现跨系统指派、丢弃人工待判断、缺少职责及权重。修正测试调用入口后保留完整 `red.log`。另一个实际使用反例 `manual-weight-red.log` 证明主人确认推荐也需要推进计数；修后通过。
- `pnpm gate:ci`：全仓 **36/36，通过，507 秒**。沿用仓库精确 Node 24.18.0 / npm 11.16.0，不改门禁、测试阈值或依赖锁文件。
- Issue 包：5 个导出同步、29 个来源/接口、23 个 UI、1 个数据检查、94 个团队行为测试均通过；类型与私有依赖边界检查通过。13 个新增路由行为用例覆盖自动/人工、身份格式、职责、人工优先、系统未知、配置变化、重新发布、持久配额及默认人工确认。
- 打包浏览器 **7/7** 通过；真实隔离 Host composition **13 个检查点** 通过；双模拟成员/独立进程与 Redis 重启 **2/2** 通过。后两者显式模拟 GitHub/猫身份，不冒充真实多人联调。
- 完整实验宿主实装制品：`sha512-tZWZ1AbMjNmDYywEma7+0yNZiPwfGPHdRWv/LNBVhL8jLYjaUe0kjXHLx9wC/5UH1HlRXCVeN/pw4vm068H98A==`。原插件实例和本地持久记录保留，运行状态 `running`，生命周期 revision 33。通用 GitHub 接收器保持原已审 alpha.28 制品、revision 19、`running`。
- 真实页面七种系统/职责场景、保存后刷新、未保存拦截均通过，无 pageerror。补走“代码与交付 → Windows 普通分配”：三位指定 Windows 成员按 1:1:1 推荐；Mac 作者被排除。已回到 **macOS / 普通问题 / 推荐本人**，派工按钮可用。
- 当前组织实读为 10 位成员；只配置用户指定的七位，另三位显示环境/职责未配置并排除。原 `ts212653` 拼写差异、可调整的 2:1 默认比重及单实例计数范围均在上文公开。
- 本轮 GitHub 写入 **0**。最终 `gh issue view` 回读测试 #1 为 `OPEN`、`assignees: []`、`updatedAt=2026-10-26T02:57:37Z`。原工作实例 3003/3004/6399 与实验 5142/3142/6358 分属独立进程，未修改或重启原工作实例。
- 验收脚本最初缺少 Origin、随后未等实验会话 Cookie，分别被 Host 403 拒绝；原失败记录保留。修正脚本为页面同源请求并等待正常会话建立后通过，未绕过 Host 授权。

关键证据：插件目录 `gate.log`、`package-test.log`、`team-final.log`、`ui-green.log`、`browser.log`、`host/host-verification.json`、`sandbox.log`；实验宿主目录 `installation.json`、`browser.json`、`assignment-view.json`、`windows-routing.png`、`ready-for-owner-routing.png`、`final-plugins.json`、`github-final.json`。

此前独立 Host 公开认领/撤销与真实猫回复的证据继续有效，通用接收器本轮未改。本轮不声称实际开发已经启动，也未向其他成员发测试通知。下一步由原 reviewer 对本次 OS/职责/权重与完整操作动线增量复审；远端 CI 与 review 需核对新 HEAD。

## 2026-10-26 用户派工试用反馈

用户反馈未明确选人仍能派工、邀请后无法补负责人，以及需要退回改派入口。本轮修复与证据见 [派工恢复验收](../evidence/issue-workbench-owner-recovery-2026-10-26.md)。新派工先明确选人；历史邀请保留且可新建认领；接收人通过 GitHub 说明原因并移除自己，协调人刷新后重新派工。旧记录的状态不再覆盖实时 GitHub 认领。此时测试 Issue 已由本人主动认领，旧“未认领”快照只属于前轮验收；本轮不撤销用户的现有认领。
