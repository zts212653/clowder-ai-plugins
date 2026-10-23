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

仓内新增目录不会自动获得 npm 发布或官方目录条目。需要官方 npm 分发时，同步核对发布 workflow 的实际包清单与 catalog 制品坐标；这些变更继续遵循下面的路径权限规则。团队 Git 仓的目录发现不依赖本仓的 npm catalog。

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

各包独立维护版本，以相应 package.json 和 npm registry 中实际发布的版本为准，不能把仓内 SDK 候选版本当成已发布版本。当前发布 workflow 由通过 validate 的 main push 触发；实际发布包、版本和 dist-tag 以 workflow 为准。源码集成时仅更新 `catalog/candidate.json`；包发布成功后用 `pnpm catalog:activate` 核验并通过独立普通 PR 更新 live `catalog/catalog.json`，不要将未发布坐标提前激活。独立插件应固定验证过的可获取 SDK 版本，并提交锁文件。行为夹具与插件 manifest 中的 `contractVersion` 仍是签字协议版本 `0.1.0`，不随 npm artifact 的 beta 后缀变化。完整插件系统改造与验收完成后，才发布正式 `0.1.0` 并推进 `latest`。K-1 shape-approved、另一方对 final HEAD 的 approval、required CI、npm scope/`NPM_TOKEN` 与 registry 精确 version+integrity 验证全部完成前，不得合入或消费本 prerelease。
