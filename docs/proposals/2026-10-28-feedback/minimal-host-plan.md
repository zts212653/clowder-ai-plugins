---
feature_ids: [F235, F202]
topics: [feedback, plugins, host-boundary, diagnostics, privacy]
doc_kind: implementation-plan
created: 2026-10-28
---

# 反馈插件：最小 Host 增量方案

状态：2026-10-29 已按用户授权在插件 Draft #155 和配套 Host Draft #1732 落实本方案，通用接口仍待维护者评审。专用诊断通道及 Client 改动已移除；当前验证与真实验收边界见 [verification.md](verification.md)。通用能力诉求已提交 [Host #1734](https://github.com/zts212653/clowder-ai/issues/1734)，截至本轮核对尚无 Mind 回复。

## 用户目标与验收边界

来源：本目录 README 的原始需求，以及用户同日纠正“希望完全插件化”“Host 不足应向 Mind 提 Issue，并确认最小改动方案”。

Before：用户手写现象，维护者反复索取项目环境、日志和复现信息。
After：左栏一个插件按钮打开反馈表单，已配置 Agent 辅助形成可编辑的脱敏报告；用户确认后自动提交并取得真实 Issue 链接。无 Agent 可直接提交，无自动通路可手动创建。

必须保留标题/正文旁的复制、图片的复制/下载、可见步骤、GitHub/GitLab/组织 CLI 可配置，以及感谢反馈和详细报告有助于解决问题的文案方向。不新增主界面内容。

## 源码证据与能力判断

核验日期：2026-10-28。Host 主线 `c238b40ac92277cb8ef6dba2d9fe3d22785d8992`；插件主线 `c261cebc394462674f29d4ca51ee077a39b4229a`。

| 已核实位置 | 能力与限制 |
| --- | --- |
| plugin-contract `UiContribution` | 已有 command/slot-item；Host API/Web/shared 尚无该侧栏插槽 consumer，面板打开/资源/桥接也缺公开结果契约。 |
| Host `external-runtime/static-surface-server.ts` / `package-surface-assets.ts` | 有已验证资源、CSP、独立来源；现有 admission 为编辑器和 Companion，不能伪装成这些角色。 |
| SDK `module-host.ts` / Host `plugin-thread-host.ts` | 已有 members、threads.create、send+wake、读取/订阅与 execution_status；无须修改 AgentService 或 provider。 |
| Host `plugin-thread-host.ts` create | parent 存在则继承其项目，否则使用 Host 默认 projectRoot；SDK 不接受任意 project/cwd。 |
| Host `routes/config.ts` env-summary | 已知道当前 logger 实际日志根；公开插件 SDK 缺少最小运行信息投影，不能假设插件读完整配置即可。 |
| Host `plugin-webhook-forwarding-routes.ts` | 已有 owner-local 声明操作和生命周期控制，面板业务优先复用。 |

Architecture cell：Host 提供通用容器、身份/生命周期和项目路由；插件拥有反馈业务、材料、报告与外部平台适配。

Map delta：补 UI consumer/面板语义及必要运行上下文；不增加诊断专用模型调用、会话系统或数据库。

当前接口：SDK `runtimeInfo.get()`、普通线程 `projectRef` 输入/投影，以及版本化 `PluginUiPanel` 命令结果。后两者是模块接口与结果语义，不新增 manifest contribution 种类。面板 HTML 由已校验安装包的模块返回，复用现有安装完整性、owner 调度和隔离策略；没有单独扩展 Companion/编辑器静态服务。Host 不解析反馈步骤、材料、报告或平台配置。

Why：让第二个普通插件也可复用这些能力；后续改反馈 recipe、平台或报告模板不再要求发版 Host。

## Host 改动白名单

| 工作单元 | 必要性 | 实施位置与边界 |
| --- | --- | --- |
| H1 通用 UI 插槽/面板 | 保留左栏入口必需 | 承接现有 ui 声明；明确合法 group、面板静态资源和打开结果契约。复用资源校验和隔离；接入 WorldRail/ActivityBar，不硬编码 feedback。与导航 #1489 的位置和排序策略对齐。 |
| H2 只读 runtime-info | 可靠自动发现当前 Host 日志来源必需，优先复用等价公共能力 | 现有运行信息来源做最小投影：版本、运行形态、系统事实、授权的有效日志来源。来源由 Host 注入，不能信任页面正文；不返回凭据/整份环境变量/完整配置，不在 Host 采集日志或分析。 |
| H3 普通项目引用 | 无已有项目线程仍要选择项目时必需 | 有 parent 直接沿用现有 create；无 parent 时为普通 threads.create 补经 Host 验证的项目引用/选择上下文，复用既有受保护路径规则。新公开字段同时修改 contract/SDK/Host，不私造 feedback seam。 |

H1 面板桥仅允许本安装声明的操作及必要的文本/PNG 剪贴板、打开链接；业务读写沿既有 owner-local webhook 调度。不同插件不能相互调用，停用/替换后旧面板不能继续操作。

不能把“已有项目线程”这条可复用路径，包装成“任意项目选择已经支持”。若暂时不补 H2/H3，完整自动采证/任意项目旅程仍未完成，界面必须显示真实缺口。

明确移除当前 Host 候选中的 `plugin-diagnostics`、诊断 provider/destination、Host 日志 collector、`diagnosticTextOnly` 及 Claude/Codex 特殊启动分支；通用日志读取函数可移入插件。不改角色/账号配置、原生 HOME、生产实例或历史。

## 插件实现链路

1. **发现与表单。** 声明侧栏入口和包内面板，插件渲染自己的步骤、字段、图片和按钮。能力不足的旧 Host 在 Settings 显示不兼容，不能启用后没有入口。
2. **材料与授权。** 使用 Host 的当前线程/项目引用和 members 列表，展示用户实际选择；插件版本化 recipe 定义日志类别、时间窗、读取限额和脱敏规则。读取当前安装或用户授权项目，排除密钥、认证库、完整环境、SQLite 和原生会话库，不自行猜路径遍历磁盘。
3. **普通诊断线程。** 持久记录 run generation；`threads.create({parentThreadId, participants, title})`，或未来经验证 project 引用；发送一次带现有 idempotencyKey 的诊断请求并 `wake:{catId}`。复用 Host 已配置 Client、权限和运行规则。
4. **采证与分析。** 插件采集工具提供有界脱敏证据，prompt 指导 Agent 按现象→时间→版本/环境→日志→初步判断分析，证据不足明确标记；不创建 Issue、不默认修复。正常工具与权限仍沿用 Client，prompt 不是只读沙箱。
5. **真实状态与候选报告。** 订阅消息和 execution_status；由原请求消息、Host 注入的发送者、executionId 关联当前轮。要求结构化报告，校验 schema、当前 generation 和来源，再二次脱敏、渲染 Markdown；执行完成但缺有效报告显示待补充/失败。用户可编辑。
6. **上传与兜底。** 复用插件现有 Provider/Transport/Profile、附件 vault 和 CAS 提交日志。报告/目标/实际发送图片改变就撤销旧确认；自动创建后回读实际 Issue，展示真实 URL。手动仅复制标题/正文/PNG 或下载图片并打开配置页面，不冒称已提交。

普通线程可能加载项目规则、成员私有上下文并保留原生历史，不能沿用旧特殊通道的“工具禁用/无私有上下文/无原生持久化”承诺。本方案保证上传前的报告与图片确认；不把最终报告脱敏等同于普通 Client 的全部模型上下文已隔离。

## 状态与恢复

插件拥有草稿、采证任务和提交日志；Host 拥有普通线程、成员调用与安装生命周期。

- 可见阶段：填写 → 采集/分析 → 审阅 → 提交/完成。当前细分状态取自真实任务与执行回执，不靠计时器模拟进度。
- 关闭面板不删除草稿或线程；重开回读持久记录和真实执行状态。run 中止/重启使旧 generation 失效，晚到候选不能覆盖新报告。
- `threads.create` 没有业务幂等键，响应丢失时记录待核对，不盲目重建/重复发送；发送使用既有消息幂等机制。
- 用户“停止等待”只使当前候选失效并退订；未经既有取消 API 不宣称已终止 Client。插件停用按 Host 生命周期退订，用户历史继续保留。
- 自动创建结果不确定沿现有 unknown/reconcile，不盲目重传；手动创建状态是页面已打开或用户自报链接，不能当作远端已核验事实。

## 验证与交付顺序

1. 向 Mind 提通用能力 Issue，确认现有替代接口、合法插槽及 H2/H3 所属契约；反馈专用大改不作为前置要求。
2. 公共 contract/SDK 与 Host 小范围扩展先明确版本和最小示例；第二个普通插件也能打开面板，Host 没有反馈业务分支。
3. 反馈插件迁移普通线程，保留自动提交/直接提交/手动兜底和全部已确认 UI 细节；新行为按 TDD 验证，代码只在 feature worktree 修改。
4. 关键验证：停用/升级失效、跨安装拒绝、资源完整性、parent 项目继承/无 parent 项目选择、不同安装日志隔离、blocked/failed/settled、重复/迟到消息、重开恢复和实际附件确认。
5. 最终运行 packed artifact 的 Settings 安装→侧栏→真实 Client→脱敏报告→提交或手动交接旅程；静态/替身测试不能代替真实调用和内网验收。测试实例按项目台账维护，不绑定用户原生 HOME 或改历史来凑验收。

本轮已有复用证据：Host `f202-c1-plugin-host-threads.test.js` 和 `f202-c1-plugin-host-messaging.test.js` 共 **25 项通过**；相关三份 Host 线程/消息源文件相对上述主线无差异。使用工作树现有构建、内存存储及 Agent 替身，不是本方案新接口的完成证据，也未真实调用模型。

文档改动验证：`git diff --check` 应无空白错误。后续插件行为验证使用本仓已存在的 `pnpm --filter @clowder-ai/feedback typecheck`、`pnpm --filter @clowder-ai/feedback test`；Host 新契约检查按最终落点补精准命令，不预先把现有专用诊断测试当新方案验收。

交付顺序保持：公共能力可用 → 插件适配 → 完整旅程验收。旧候选分支与持久数据保留，回退代码不删除草稿、配置、原生历史或平台回执；两份 Draft 不因本计划自动关闭/合入。
