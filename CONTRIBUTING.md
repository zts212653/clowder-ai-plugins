# Contributing

当前阶段：**插件契约 v0 讨论**（Issue #1）。

- 现在：欢迎在 issue 中参与契约与分工讨论
- 契约 v0 冻结后：开放插件实现 PR（monorepo，每插件一目录 + 独立 manifest）
- 节奏：v0 draft → M0（壳+传输验证）→ M1（权限+认识论语义验证）→ 冻结 v1 兼容承诺

## 路径级权限矩阵

| 路径 | 责任与合入规则 |
|---|---|
| contract、schema、fixtures、release workflow、`CODEOWNERS`、根依赖输入 | PR 作者提供一方 provenance；最后一次 push 后由另一方 CODEOWNER approve |
| `mindfn` 主导的 SDK、runtime、probe、普通插件 | 不碰上行受保护路径时，required CI 绿后可由作者自治合入 |
| `foreground-cat`、家庭形象资产与资产许可证 | 家里主责，另一方复核；不可逆许可证决定另需 CVO 明确签字 |

GitHub 对同一条 CODEOWNERS 规则只要求其中任一 owner 的 approval，且 PR 作者不能 approve 自己。因此这里的“双签”不是把全局 approval 数机械设为 2，而是：**author provenance + other-party CODEOWNER approval**。

`main` ruleset 应保持：

- 所有变更经 PR；全局 `required_approving_review_count=0`，仅命中 CODEOWNERS 的路径要求 code-owner review；
- 新 commit 撤销 stale approvals，因此受保护路径必须由另一方 CODEOWNER 对 final push 重新批准；`require_last_push_approval=false`，避免给未受保护的普通插件路径强加全局 approval；
- required status context 为 `Typecheck + Conformance`（workflow：`Contract CI`），且该 workflow 对所有 pull request 上报；
- 不把管理员 bypass 当常规合入路径。

包清单处于 `0.1.0`、`private: false` 的 public-ready 状态，只用于让满足 gate 的 `main` 合并触发发布。K-1 shape-approved、另一方对 final HEAD 的 approval、required CI、npm scope/`NPM_TOKEN` 与 registry 精确 version+integrity 验证全部完成前，C-1 仍是 candidate，不得发布或消费。
