---
feature_ids: []
topics: [repo-sync, git, version-update]
doc_kind: plan
created: 2026-10-12
---

# 两种同步模式实施合同

来源：用户确认开发过程同步与按 tag 的内部定制版本更新共存，沿用原 worktree / PR #1586 完整交付并验证。

Architecture cell: 外置 repo-sync 执行器。
Map delta: none。
Why: 增加同一工具的同步策略，不接入应用 Host、数据库或 Agent。

- continuous 为兼容默认值：原始对象、逐笔 PR、Issue 映射与整个 tree 一致性保持原合同。
- version 为显式选择：登记 U0/I0、选择并冻结 tag 对象和目标 commit，只生成一个内部内容更新候选及 PR。不搬运 Issue，不重放上游 commit message，不把来源 commit 的祖先可达性当作版本模式的核验条件。
- internalPaths 是内部拥有的文件或目录；mergePaths 是共同修改的文件。只支持相对精确路径及目录前缀，拒绝危险/重叠规则。其余文件的基线必须与 U0 相同。规则与模式进入绑定身份，不能在已接管台账上偷偷更换。
- 候选从目标 tag 文件树构建，保留内部拥有的文件，mergePaths 使用 U0/I0/目标的三方合并。上游新增内部保留路径、二进制或删除/修改等冲突明确暂停；文本冲突可在本地界面人工解决后重试。未发布交付可撤销并重新核对基线，已发布分支不能丢弃恢复状态。
- 内部新增定制提交必须是上次内部版本的后继，且仅改允许路径；在开始新版本更新前核验并冻结实际 HEAD。交付进行期间 HEAD 变化阻断，不自动合并未知并发。
- 标签只通过 Git 读取；重新核对 tag 对象/commit，移动标签或非连续版本暂停。候选以内部基线为唯一 parent，源码原始对象不重写，不推 main。
- 平台人工创建/审核内部同步 PR；正常合入后核验冻结候选的完整 tree、内部历史与真实 merge base/head，再原子记录 tag → 外部 SHA → 内部 SHA 并完成。恢复不重复创建候选或推进游标。
- 配置选择与文件规则在本地私有目录保存。失败详情只展示本地路径/合成证据，公开 PR 不附真实地址、文本或日志。

验证：先新增真实 Git 用例观察 RED；覆盖保留目录和已有文件、无冲突合并、冲突解决、同名路径、tag 移动、回退、内部漂移、恢复、检查失败、合入结果被修改及绑定更换。然后跑全部 repo-sync Node 测试和两种模式浏览器旅程。执行 `pnpm exec biome check packages/repo-sync`，必要时使用本机已安装的等价 Biome 二进制。启动新的隔离版本演示入口，保留用户在 5187 的已有进度。

## 交付位置修正

用户要求将独立功能移至 clowder-ai-plugins。packages/repo-sync 是当前实现位置，核心仓 PR #1586 只保留迁移来源，正式代码审查和后续实施由插件仓 PR 承接。安装、授权和 Host Broker 仍由核心仓负责，本插件声明现有 MCP contribution，不新增或修改公共契约。
