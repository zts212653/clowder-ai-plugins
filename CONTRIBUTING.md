# Contributing

## Catalog artifact toolchain（重生成 catalog hash 前必读）

`catalog/candidate.json` 里每个候选 artifact 的 `shasum`/`integrity` 元组是**打包字节的哈希**，只在精确工具链下可复现：**Node 24.18.0 + npm 11.16.0**（CI 通过 `ARTIFACT_NODE_VERSION`/`ARTIFACT_NPM_VERSION` 钉死；仓库根 `.nvmrc` 已固定 `24.18.0`）。homebrew 等其他 Node 版本打出的 tarball 字节不同，hash 必然对不上。凡改动任何包的 `src`/`README`/`plugin.yaml`（改变 tarball 字节），重生成该包 `versions[0].artifact.*` 元组前必须先切到存放在**持久目录**里的工具链（例如 `export PATH=/Users/<you>/workspace/github-lab/f202-toolchain/node-v24.18.0-darwin-arm64/bin:$PATH` 并设置 `CLOWDER_ARTIFACT_NPM_CLI`），用 `node scripts/pack-publish-artifact.mjs packages/<name> <dest>` 取新元组，然后 `pnpm catalog:check` 必须 ok。不要把唯一工具链安装在 `/tmp`：macOS 会清理该目录，导致后续验证缺文件或退回系统 npm。不要改各包 `engines` 字段去强制这一点——那会影响消费者。

插件、SDK 与 Contract 已分别在 `packages/` 中维护。新增插件或修改已有插件，先按[插件开发指南](docs/plugin-development.md)完成源码目录与实际制品验证。

## 交付前核验（宣布新 HEAD 前必读）

推送前在仓根跑 `pnpm gate:ci`：它按 Contract CI 的顺序本地复跑从工具链检查到 `pack:gate` 的全部检查（workflow 直接调用同一脚本，不会漂移），任一步失败会停在那一步并打印步骤名。注意第 1 步要求当前 shell 的 Node/npm/zlib 与 workflow 钉死的 artifact 工具链一致。

CI 的 `assert-pr-head` 闸只在**有 run 存在**时才拦得住「推错仓」——推错 remote 的 push 根本不产生 PR run，闸不会红。因此每次向 reviewer 交付新 exact HEAD 前，必须在本机手工跑一遍：

```
node scripts/assert-pr-head.mjs <owner/repo> <pr-number> <新HEAD-sha>
# EXIT=0 且 gh run list --repo <owner/repo> --branch <分支> 显示新 run 已出现，才可宣布
```

宣布的 HEAD 字符串必须与本机 `git rev-parse HEAD` 一致。少这一步，「CI 绿」可能是旧 HEAD 的绿。

## 提交插件

发布完成后还须交付独立的 live catalog PR；发布操作者持有这一步责任，交接须给出明确 owner 与 PR／阻塞原因。`pnpm catalog:activation-check` 是上架完成检查，已接入发布 job 末尾及独立的每日／手动 Catalog Activation Audit。它失败时先区分 npm 发布失败与目录待激活，不要重新发布已存在的 immutable 版本。手工 npm 恢复后立即手动运行 audit，按 `docs/plugin-projects.md` 的三步流程闭环。

每个插件独立目录、独立 `package.json` 与 `plugin.yaml`。PR 说明用途、稳定 pluginId、版本、维护者、配置要求、依赖变动和实际安装/启停结果；没有配置或账号要求的插件不要增加无意义的用户步骤。

仓内新增目录不会自动获得 npm 发布或官方目录条目。需要官方 npm 分发时，同步核对发布 workflow 的实际包清单与 catalog 制品坐标；这些变更继续遵循下面的风险审查约定。团队 Git 仓的目录发现不依赖本仓的 npm catalog。

## 路径责任与风险审查

本仓不要求指定个人或“另一方”批准 PR。`CODEOWNERS` 用于标识维护者和发出可选审查请求，不是合入审批门槛；需要独立审查时，按实际风险选择一位合适的非作者 reviewer，不限定其 GitHub 账号或所属一方。

| 路径 | 责任与合入规则 |
|---|---|
| contract、schema、fixtures、release workflow、`CODEOWNERS`、根依赖输入 | 作者提供变更与验证依据；按契约、发布、安全或治理风险选择非作者独立审查，覆盖最终实质内容 |
| SDK、runtime、probe、普通插件及 catalog 更新 | required CI 绿后可由作者自治合入；实际涉及契约、安全或发布边界时按相应风险审查，不因路径命中 CODEOWNERS 额外等指定人批准 |
| `foreground-cat`、家庭形象资产与资产许可证 | 家里主责，按实际风险审查；不可逆许可证决定仍需 CVO 明确签字 |

独立审查证据可以来自非作者维护者或猫的审查回执，须绑定最终实质内容；共享 GitHub 账号下的猫不需要伪造账号自批。历史计划里的“双签”或“另一方 CODEOWNER approval”不再构成现行合入前提，以本节为准。

`main` ruleset 应保持：

- 所有变更经 PR；`required_approving_review_count=0`、`require_code_owner_review=false`，不强制指定个人或 CODEOWNER approval；
- `dismiss_stale_reviews_on_push=true`、`require_last_push_approval=false`；需要独立审查的改动核对审查是否覆盖最终实质内容；
- required status context 为 `Typecheck + Conformance`（workflow：`Contract CI`），且该 workflow 对所有 pull request 上报；
- 不把管理员 bypass 当常规合入路径。

各包独立维护版本，以相应 package.json 和 npm registry 中实际发布的版本为准，不能把仓内 SDK 候选版本当成已发布版本。当前发布 workflow 由通过 validate 的 main push 触发；实际发布包、版本和 dist-tag 以 workflow 为准。源码集成时仅更新 `catalog/candidate.json`；包发布成功后用 `pnpm catalog:activate` 核验并通过独立普通 PR 更新 live `catalog/catalog.json`，不要将未发布坐标提前激活。候选中存在无关待发布版本、而单个插件已经审查并以自包含制品发布时，可改用 `pnpm catalog:activate:plugin -- <pluginId>`；该路径只验证所选插件的 registry 身份与归档字节，不替代整批 Contract、SDK 和插件发布对账。独立插件应固定验证过的可获取 SDK 版本，并提交锁文件。行为夹具与插件 manifest 中的 `contractVersion` 仍是签字协议版本 `0.1.0`，不随 npm artifact 的 beta 后缀变化。完整插件系统改造与验收完成后，才发布正式 `0.1.0` 并推进 `latest`。K-1 shape-approved、按实际风险选定的非作者审查、required CI、npm scope/`NPM_TOKEN` 与 registry 精确 version+integrity 验证全部完成前，不得合入或消费本 prerelease。
