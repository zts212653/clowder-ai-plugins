# Issue 工作台：独立工作区与 SDK 接入候选

[English guide](README.en.md)

Issue 工作台读取 GitHub 问题与讨论，保留版本化来源归档，提供本地分类标注、
解决方案、证据、任务与标签草稿。人工研判不依赖猫猫或组织权限。

**当前状态**：本 alpha 能独立构建、打包和运行。规范 `plugin.yaml` 已允许宿主
安装器接收原样包，但当前宿主默认不给这个插件有效能力权限；成功准入不等于在
正在运行的猫咖里可用。`integration.json` 保持 `hostInstallable:false`，直到完整
已安装旅程验收通过。该包未进入公开目录，也未加入自动 npm 发布。

不改宿主代码的集成检查见 [HOST-TESTING.md](HOST-TESTING.md)。它使用真实宿主
安装器、生命周期、配置、动作授权、消息与 Redis，明确隔离登录、GitHub、模型
调用和测试权限。隔离测试不代替正式授权、真实猫猫和双账号验收。

## 人工研判与猫猫研判

希望先亲手体验完整操作流程，可以使用[可交互隔离试用](SANDBOX.md)：持续运行真实工作台，切换两个模拟成员，查看自动分类、补充分析、请求模拟研判、邀请、明确接手和回报。模拟控制与真实业务状态分开，记录在独立目录持久保存。

打开问题，在 **研判方式** 中选择：

- **人工研判**：先展示已有自动分类及依据，无需抄写。需要时从 **问题类别** 中选一项，查看“适用／不含／例子”，再点 **保存分析**。也可展开 **补充分析（可选）**。自动建议不再复制为重复的本地标记；历史记录保留。
- **猫猫研判**：从当前猫咖名单选择 **分析猫猫**，点击 **请猫分析**。切换模式或
  选择名字不会发送任务，也不会丢弃人工草稿。重新加载后回到人工模式，已保存
  的本地记录继续保留。

猫猫名单来自宿主，可包括尚未加入研判对话的可路由成员；不可用或已移除的成员
仍保留原选择提示，刷新和发送不会擅自换猫。宿主发送前再次校验目的地。
GitHub Organization 组织成员是另一份名单，用于通知或指派人，不能冒充猫猫身份。

独立 READ 预览只负责读取来源及本地编辑。在连接已授权的宿主动作之前，它不会
枚举或唤醒真实猫猫。打开页面本身也不会发布 GitHub 评论或更改负责人。

已有分类会在问题打开时显示。没有分类的新问题保持 **待判断**；来源中精确
Feature 绑定优先。猫猫结果到达后，队列、分类筛选与详情一起更新，依据来源身份
和更新时间识别结果，不覆盖来源标签或人工本地记录。

## 统一打标与分类边界

每条问题只有一个主类别，用来回答“哪项能力受阻或需要改进”。从固定选项选择，**分类边界与例子** 展示每类的适用范围与排除项。来源、系统、类型和现象是独立信息，不与主类竞争。

例如：产品安装失败归 **安装与构建**；开发测试命令失败归 **代码与交付**；升级成功后不能对话，按明确受阻的能力归 **Agent 运行**。猫间唤醒未送达归 **猫猫协作**，单猫收到任务后调用模型失败归 **Agent 运行**。不能只看到“配置”“Windows”或“页面报错”就决定主类。

来源绑定 Feature 时优先随 Feature 处理。其余问题优先使用已保存分类，否则采用唯一自动建议；多类建议、未知旧名称或证据不足保留 **待判断**。保存后的选类会同步影响队列、总览与详情；旧自定义标记保留在历史记录中，不再是另一套分类入口。旧分类数据的判断仍是建议，本次未批量重写历史结果。

新猫猫研判任务携带同一份分类表与边界说明。在已授权宿主的原生页面中，人工保存、分类视图和派工读取同一份持久记录：人工类别优先于猫的建议，后来的猫结果不覆盖人工判断。**人工修改历史** 可读取历次保存内容。旧独立预览的数据目录不会自动迁入宿主。

## 接入后初分与规则批量派工

插件设置的 **initialClassification** 默认关闭。启用并配置分析猫、分析对话及仓库后，首次接入会读取该仓库 Open 和 Closed 历史，排除 PR，启动一次持久化分类批次。重启、刷新和配置重试续跑原批次；不把静态样本当作本次猫分析。Closed 可分类，但不能自动派工。

**automaticAssignment** 是另一个独立开关。启用后按成员自提、Feature 分工、当前有效类别的顺序处理未分派 Open 问题；可以直接使用人工保存的类别，无需重新调用猫。新保存的类别会在后续扫描生效，既有负责人不会被改写。每轮最多推进十条有目标的分派；冲突和来源变化保留记录，不确定发布先查重。人工派工仍可逐条明确确认。

页面由插件自己的打包产物提供，现有宿主的已认证入口为
`/api/plugins/dev.clowder.issue-workbench/workbench/installed.html`。
此入口已在隔离宿主验证；实际猫咖仍须先解决有效权限授予，直接访问未获授权的安装不会变成可用实例。

## 收到任务后怎样开工

接收方配置自己的 `inboxThreadId`、`inboxCatId` 和 `receiveAssignments`，使用本人 GitHub 登录。进入 **团队记录 → 我的收件**，打开一条当前分配，点击 **接下此任务**。接单记录保存在本猫咖，重启可恢复。

接单后点击 **复制开工指令**、**打开收件对话**，核对并发送。该真实用户消息由猫接成正式任务；插件接单操作自身不冒充用户聊天、不创建执行权限。处理进度以收件对话为准，启用 `shareProgress` 后猫可用 `issue_team_report` 发布成员回执。被撤回或改派的旧记录不能继续接单。

## 问题来源与操作系统

自动结果新增两个独立维度，分类总览可按它们组合筛选：

- **问题来源**：内源、外部、共性或待判断。`codeagent`、`codehub`（忽略大小写，支持空格/连字符变体）是内部专属线索；开源版、社区版等明确描述是外部线索；明确内外版本均复现或共性描述才判共性。线索冲突或不足保留待判断，不从 GitHub 托管位置推断来源。
- **操作系统**：Windows、macOS、其他系统，可同时命中多项。其他系统包含明确提到的 Linux/Ubuntu、Android/iOS 等；没有系统证据表示待判断。正常对照环境、否定描述、未勾选的模板项不计入受影响系统。

规则先用标题及已有研判的匹配版本正文；打开问题后复用正文读取结果补全。界面展示依据与读取范围，Feature 绑定也不遮挡这两个维度。没有正文的列表判断是暂定值，不承诺覆盖完整自然语言；歧义项可请猫结合原文分析，主类别可直接选类修正，来源和系统的补充依据可写入分析备注。已有人工分类与历史记录不会被自动覆盖，也不会改 GitHub 标签。

## 批量分类与恢复

进入 **团队记录 → 自动研判**，选择仓库和猫，点击 **读取待研判问题**。
插件完整分页读取 Open Issues（排除 PR），保存暂停的队列，此时不调用猫猫。
核对数量与自动派工设置，再点击 **启动队列**。

同一队列最多等待一条研判。宿主声明的定时任务推进队列；重启后恢复原请求，
不重复投递。队列包含准备时观察到的问题，新问题需要另建批次。
**暂停队列** 保留在途结果，但停止新投递和自动派工；**停止队列** 结束当前批次。
分类完成仍允许恢复之前待发布的自动派工，**停止后续派工** 可以终止这些重试。
关闭抽屉、切换单个问题的研判模式，不会停止已明确启动的批量队列。

目的猫和线程不会静默替换。来源改变、路由不可用时保留可检查的状态；已关闭的问题
在开始分析前跳过。**研判记录** 分别展示分析与派工状态，分类完成不代表已经
分配、接手或修复。独立 READ 预览没有这条已授权的宿主能力链路。

## 组织成员、邀请与负责人

在插件设置中填写 `teamOrganization`，可以使用组织名或组织链接，例如
`meow-club` 或 `https://github.com/meow-club`。插件通过本机已登录的 GitHub CLI
读取组织成员及全部结果页。本机账号必须是组织有效成员，并具备读取成员所需的
GitHub 权限（经典/OAuth 的 `read:org`，或细粒度凭据的 Members: read）。
插件设置不另存凭据。这里连接的是 Organization，不是 GitHub Team。

团队面板显示组织与人数；**团队记录 → 刷新组织成员** 重新读取成员和主页链接。
只能看到公开成员、读取失败或分页不完整时，不把这份名单当作完整授权名单，
已有研判和历史保留，并显示可重试的错误。发送、指派、发布和收取之前都会复验成员。

旧的 `teamGroupName` / `teamMembers` 不再是成员权限来源。重新配置组织不会删除
旧记录；读取失败也不会退回旧名单。仓库协作者、分工规则和问题正文中的名字都
不能自行增加组织成员。绑定旧策略的派工意图需要重新分析或确认。

组织成员自己提出的问题优先本人；作者以 GitHub `user.login` 为准，不解析正文
中的提及作为作者。其他问题先匹配 Feature 分工，再匹配分类分工；只有唯一匹配
才自动选择。已有不同负责人、来源改变或分工歧义会停止自动派工，等待人工判断。

在问题的成员选择区，可以直接派工，也可以先让猫猫分析：

- **设置 GitHub 负责人**：默认派工方式。确认后写入 Issue 的 Assignees，需要当前仓库的指派权限。
- **通知成员接手**：可单独选择。二次确认后发布结构化任务评论，提及成员，不修改
  GitHub assignee。邀请使用实际评论接口权限，不探测设置负责人的权限。

Open 问题的列表与详情显示“未认领”或“已认领 · @负责人”，多人时显示全部负责人。
认领以 GitHub Assignees 为准，不把邀请、猫猫研判或本地草稿算作已认领。旧缓存
尚未读取负责人时显示“认领状态待更新”，更新来源会补齐；派工后回读 GitHub 并立即
更新页面。GitHub 上改派或移除负责人后，更新来源即可同步。已有不同负责人仍受保护。

直接派工有独立记录，不虚构优先级分数，也不计入猫猫分析数量。基于分析派工时，
确认绑定当前记录版本，公开分数和理由，旧确认不能重放。一次人工派工不改变
自动派工开关，失败的一次性派工不会授权后台自动重试。

需要自动派工时，明确启用 `automaticAssignment`，并保存 `dispatchMode=invitation`
或负责人模式。旧安装未设置模式时保留原负责人行为。未启用自动派工时，猫猫只
推荐成员供 owner 确认，不能绕过开关。成员自提的问题会建议邀请提出者参与合入前
验收；这是建议，不表示已经验收，也不替代审查或合入门禁。

## 接收、接手与进度回执

接收成员使用自己的 GitHub CLI 账号，在自己兼容且已获授权的宿主中配置相同组织、
允许仓库、`inboxThreadId` 和 `inboxCatId`，并开启 `receiveAssignments`。
发送者不猜测另一台猫咖的猫 ID。单纯登录 GitHub 不会启动插件监听。

启用时及每 60 秒的声明任务都会补收已有 Open 分配和有效邀请，包含离线积压。
持久记录和 GitHub 事件/评论身份用于去重、区分重新分配与普通重启。
**邀请已发布** 或宿主消息已投递，都不等于接收者已接手或正在执行；读取或清除通知
不丢失工作记录。只有当前组织成员发出的、内容未被编辑的协议评论才被识别为任务，
普通提及不是任务。

接收者必须明确提交接手、处理中、受阻或待验收说明；另行开启 `shareProgress`
才会将进度和显式给出的 GitHub 证据链接发回问题。接收者自己的陈述不是宿主执行
验证结论。评论结果不确定时，不盲目再次 POST；owner 检查原问题后，可针对当前
版本明确确认重新发布。这不会偷偷改变负责人。

来源改变、邀请删除或编辑、问题关闭或改为其他负责人会停用当前投递，保留历史。
关闭或重新分配会通知原接收对话；重新打开时恢复投递，不误判为重启重复。
从组织移除成员会停止后续写入和收取，不删除历史，也不自动取消 GitHub 负责人。
旧分析保留；来源指纹现在包含经过平台确认的作者，因此旧记录的新派工需要重新
分析。分析与反馈统计是描述性统计，不是训练后的权重、实测准确率或自动验收。

## 多来源调查与人工记录

`mountCoordination(element, host)` 提供聚合轻量队列、独立来源偏好、手动关联和
本地分类分析记录。工作台负责分析和派工，不在本地仓管理修复、分支或补丁验证。
既有修复与验证数据保留在只读历史记录中；保存分析不会清空它们。
来源开放/关闭与派工状态保持独立。内部证据不复制到公开任务，来源正文不自动加载远程图片。

在 **管理来源** 中启用已经绑定的来源、设置显示名。原有分支和基线数据继续保留，
不再作为分析流程的填写项。来源绑定由宿主提供；预览不提供任意 URL/token 表单，
也不代替插件的团队设置。

在 **关联问题** 中输入标题片段、`#编号` 或来源名，空格可组合条件，例如
`公开 #88` 或 `重复 加载`。从全部可读问题中搜索，先显示最多 30 条，继续缩小条件
可定位其余结果。选择条目或使用方向键和回车，再填写关联依据并保存。
改变查询会清除原选择。关联只保存在本地，不更改来源平台。

`IssueCoordinationService` 接收已授权的来源绑定和 owner 独立存储。提供方、实例、
仓库的稳定身份必须在改名或凭据轮换后保留；不同租户或有效授权范围不能共用
存储/缓存根。即使读取缓存也要复验授权。内部适配器必须给出稳定问题 ID 与
完整/部分读取事实；类似 GitHub 的接口形状不等于 GitHub API 兼容。

构建后的合成试用：

```sh
ISSUE_COORDINATION_DATA_DIR=/absolute/isolated/issue-coordination PORT=5196 pnpm preview:coordination
```

打开 `http://localhost:5196`，两个来源明确标为合成数据。可查看自动分类、补充分析、关联对应问题，
保存后重载恢复。这个 loopback Host 只用于验收；正式连接
仍须真实 owner 授权。

设置 `ISSUE_COORDINATION_GITHUB=1` 会把公开夹具替换成 `zts212653/clowder-ai`
的 GitHub READ 适配器，使用 PATH 中已登录的 `gh` 和完整分页读取，缓存保存在
专用目录，无需端口 3192，也不连接内部服务。`?legacy=1` 打开原单来源工作台；
旧浏览器方案和标签批次保持原样。正式 SDK 切换需要显式迁移，本增量不迁移旧数据。

## 查看初始分类

队列、分类卡片和详情分别显示绿色 Open/开放与紫色 Closed/已关闭状态；未知来源
显示中性标签。队列的全部/Open/Closed 计数跟随当前来源、分类和搜索条件，切换
来源状态不丢失分析草稿。来源关闭不表示已派工或被接手。

使用 **按类别查看**，或点击 GitHub 预览顶部的 **分类结果**。
`http://localhost:5196/?legacy=1&classifications=1` 可直接打开总览。
2026-10-20 的首次全量批次观察了 813 个问题：288 个开放、525 个关闭；其中
105 个问题已绑定 32 个 Feature，保持原绑定，其余 708 个有主要候选分类（含
4 个信息不足的待澄清项）。这是历史批次数量，不是当前实时统计。

总览提供分类计数、标题/编号搜索、状态过滤和 Feature 子组；初次显示 40 条，
**显示更多问题** 从同一筛选集合继续读取 40 条。选中问题后直接展示自动分类与依据。
仅需修改时展开 **调整分类（可选）**，再 **保存分析**；不需要先复制候选或填写修复表单。
自动结果不覆盖已有人工标签，读取结果不写入 GitHub。

批次文件为 [data/first-classification.v1.json](data/first-classification.v1.json)，
随安装包发布，仅在匹配的公开仓库绑定上加载。其他来源可以提供 `classifications`，
但必须匹配提供方、实例、稳定仓库 ID 和当前可读的问题。撤权来源及衍生建议会隐藏。
来源时间变化提示重新核对，这不是连续内容哈希验证。精确 `feature:F<number>`
来源标签优先；单独的 feature 标签或标题中的 Feature 编号不是绑定。

该批次是 GPT-6-astra 对未绑定标题的首次语义分类，部分歧义项另查正文。类型和
环境依据显式标签或标题；本轮没有提取症状。它没有实测准确率，也没有预先人工
接受。历史 12 项 `initial-classification.v0.json` 不变，空字段表示尚未提取证据。
合成试用没有这份真实公开分类。浏览器 bundle 不内嵌种子；宿主可以通过
`mountCoordination` 的第三个参数 `{ showClassifications: true }` 打开总览。

## 三栏布局

拖动两个分隔条可调整队列和研判栏，同时保留正文空间。聚焦分隔条后，左右键
每次移动 20px，按住 Shift 为 50px；Home/End 到边界，双击或 Enter 恢复默认。
宽度在当前浏览器持久保存；存储不可用时仍能在当前会话调整。

布局跟随工作区容器：大于 1100px 显示三栏，721–1100px 保留队列及当前正文/研判，
720px 及以下切换单栏。调整尺寸不丢失草稿，各栏独立滚动。
行为由插件 `src/layout/` 维护，`scripts/columns-adapter.mjs` 在重现冻结 Core
导出时补充渲染/CSS 接点。来源提交和输入哈希不变，输出哈希记录于 `sync-state.json`。

## 宿主嵌入与包内容

使用宿主已认证的请求函数连接团队工作台；浏览器不能提供调用猫身份或有效策略：

```ts
import { createTeamClient, mountCoordination } from '@clowder-ai/issue-workbench/browser';
const team = createTeamClient(hostRequest, pluginSettingsUrl);
mountCoordination(element, coordinationHost, { team });
```

客户端使用 `/api/plugins/dev.clowder.issue-workbench/actions/teamWorkbench/*`。
模块必须先通过宿主支持的安装与授权路径运行；`analysisThreadId` 选择 owner
研判目的对话，`analysisCatId` 提供默认猫。选择目的猫不是提供调用身份。
原生对话请求保留自己的线程与已配置猫；未保存的表单值不是有效路由策略。
预览的 `teamAction` 是隔离测试接点，不是认证机制。统计记录历史分析、明确反馈、
分数/分类与已发布派工数量，不代表当前工作负载。

主要交付内容：

- `dist/index.js`：注入式 READ 查询、刷新服务、持久来源归档、模型和标签草稿操作。
- `dist/browser.js` / `dist/browser.css`：自带 React 的工作台，无私有 Core 导入或全局 React。
- `dist/team-plugin.js`：使用公开 SDK `0.2.0-beta.21` 的团队模块。
- `dist/index.html` / `demo.js`：离线合成演示。
- `plugin.yaml`、`integration.json`、`sync-state.json`：声明、接入状态和冻结导出摘要。

来源引擎本身不取得凭据或启动任意 CLI；宿主提供受管理且对仓库授权的 READ 查询。
团队模块单独通过已登录的 `gh` 执行显式协议操作。浏览器应用 ports 不是 SDK
权限，宿主仍需保证 owner/仓库边界、生命周期和认证。401 原样返回，不调用私有
会话接口来修补认证。

```ts
import { createGhIssueSourceReader, FileIssueSourceStore, IssueSourceService }
  from '@clowder-ai/issue-workbench';
const reader = createGhIssueSourceReader(hostAuthorizedReadQuery);
const sources = new IssueSourceService(new FileIssueSourceStore(hostRetainedDataDirectory), reader);
```

仅导入或构造不会调用网络。单来源嵌入示例：

```ts
import { mountWorkbench } from '@clowder-ai/issue-workbench/browser';
import '@clowder-ai/issue-workbench/style.css';
const view = mountWorkbench(element, {
  repo: 'owner/repository', dataScope: 'stable-owner-scope',
  storage: browserStorage, request: authorizedSourceTransport,
  confirm: hostConfirmationDialog, openSettings: openHostAccountSettings,
  draftAssignees: ['selected participant'],
});
view.unmount();
```

每次挂载的 owner/仓库范围不可变，切换之前先卸载。来源 transport 只接受绑定仓库
的目录、详情和刷新路径；它是适配接点，不是新的公开宿主 HTTP 契约。
讨论分页固定在同一归档版本；全仓刷新超过将来的 SDK 请求时限时，需要操作引用，
而不是扩大超时限制。

来源归档持久保存在明确目录；预览人工记录按 owner 和仓库分域。合成演示使用
浏览器 localStorage，不是最终宿主持久化，也不会读取或迁移旧 Core origin。
独立 READ 中任务和标签变更仍是草稿；另行授权的团队模块才写评论或负责人。
两者都不会自动接受修复，远端变化不覆盖本地决定。

## 开发与验证

“分类分析与派工”界面通过 `scripts/triage-adapter.mjs` 和同目录的显式变更表复现；
保留原 Core 来源 SHA 与输入哈希，只更新六个受影响文件的输出回执。39 个映射文件
均从原冻结版本校验，不要求修改宿主，也不表示 SDK 切换已完成。

使用仓库固定制品工具链 Node 24.18.0、npm 11.16.0 和 pnpm 9。从仓根执行：

```sh
pnpm install --frozen-lockfile
pnpm --filter @clowder-ai/plugin-contract build
pnpm --filter @clowder-ai/issue-workbench check:manifest
pnpm --filter @clowder-ai/issue-workbench lint
pnpm --filter @clowder-ai/issue-workbench test
pnpm --filter @clowder-ai/issue-workbench build
pnpm --filter @clowder-ai/issue-workbench test:artifact
pnpm --filter @clowder-ai/issue-workbench exec playwright install chromium
pnpm --filter @clowder-ai/issue-workbench test:browser
ISSUE_WORKBENCH_HOST_ROOT=/absolute/path/to/clowder-ai pnpm --filter @clowder-ai/issue-workbench test:host
node scripts/pack-publish-artifact.mjs packages/issue-workbench /tmp/issue-workbench-pack
pnpm --filter @clowder-ai/issue-workbench preview
```

`preview` 默认只监听 `127.0.0.1:5196`，可用 `PORT` 指定；使用合成观察，不连接
GitHub 或现有 Core 服务。浏览器验收提取并服务真实 tgz；制品测试在 monorepo
之外安装并验证公开导出与持久化。可通过 `PLAYWRIGHT_CHROMIUM_EXECUTABLE` 指定
已安装的 Chrome。`test:coordination` 验证多来源旅程。提交前仍需仓根完整 `gate:ci`。

## 冻结来源与 SDK 切换

团队扩展由插件 `src/team/` 维护。既有业务/UI 导出固定在
`031244712b8b62d1dc017ed379efd09b15dd4fc6`；`scripts/source-map.mjs` 是明确白名单，
排除快照、凭据、设置夹具、Host 路由/guard 和无关文件。插件持有构建、ports、
导出适配和验证，不维护永久双向文件同步。**本次要求不改宿主，此历史导出流程不
授予任何宿主修改权限，冻结来源保持不变。**

只有另行获准的来源优化才按固定流程操作：先提交映射来源并冻结 40 位 SHA，
协调公开上游改动，不 reset、force push 或覆盖社区贡献；再执行：

```sh
pnpm --filter @clowder-ai/issue-workbench sync:core --check --source /absolute/core-checkout --ref SOURCE_SHA
pnpm --filter @clowder-ai/issue-workbench sync:core --write --source /absolute/core-checkout --ref SOURCE_SHA
```

`--check` 只读，有更新时失败；`--write` 先验所有输入和目标，拒绝未提交来源、
接点变化、符号链接、未拥有文件及相对上次回执的公开修改。回执最后写，相同重跑
不碰文件，不自动推送或发布。随后再次检查、运行验证并在原 PR 记录双方 SHA 与
制品摘要。`sync:verify` 在公开 CI 离线校验输出，不声称能访问未公开来源。
独立修改必须先协调或调整明确适配器，没有强制覆盖开关。中断写入会使哈希检查
失败，须按 diff/前次提交恢复生成文件；不涉及用户数据。

正式切换还需精确 SDK/contract 与兼容 Host、安装授权和工作台连接、保留数据迁移、
升级重装撤权，以及真实猫猫任务/结果/人工验收。规范 `plugin.yaml` 只解决准入，
不自行完成归属切换。其余适配完成后再将 `sync-policy.json.mode` 改为 `plugin-native`，
导出器会拒绝后续 Core 导出；迁移验收后再退役旧业务副本。

历史 [Core PR #1639](https://github.com/zts212653/clowder-ai/pull/1639) 已按用户要求
于 2026-10-20 撤回且未合入，其 Issue 专属权限策略、测试和脚本已撤销。依赖该策略
的早期测试只是历史证据。本次仅沿插件 PR #80 接入现有公开宿主能力，不恢复该改动。
生产权限、实际工作台连接、安全数据迁移、真实猫猫与双账号验收仍待完成。
