---
topics: [personal-chrome-companion, plugin-manifest, f202, train-c1]
doc_kind: review-request
created: 2026-09-27
---

# Review Request: W2-3 p2a — personal-chrome-companion module plugin skeleton

Review-Target-ID: p2a-personal-chrome-skeleton
Branch: feat/f202-train-c1-plugins-migration
Base SHA: `736256aa` → Head SHA: `666f7f0e`
PR: zts212653/clowder-ai-plugins#54

## What

把 `packages/personal-chrome-companion` 从"独立 npm 包 + escape-hatch 审查"
升级为**模块插件骨架**（F202 Train C1 W2-3 p2a）：

- `plugin.yaml` 模块插件 manifest（pluginId / dataDirectory / capability 声明 /
  cloud-conversation-host 声明 / icon），随包 `exports["./manifest"]` 暴露。
- 授权三操作：`list` / `revoke`（逐行）/ `status`，走 SDK 既定授权面，
  fail-closed。
- p2b 占位三方法：`append-message` / `assistant-returns.list` /
  `assistant-returns.ack`（占位实现 + 测试钉住行号语义）。
- `npm-shrinkwrap.json` 生产闭包（8 项），`@clowder-ai/*` pin 逐字节拷贝自
  enterprise-workflow 的 CI 验证字节（d51a664 既定做法）。
- catalog 条目 `official.companion.personal-chrome@0.1.0-alpha.0` +
  `catalog-check.mjs` 名单。
- release-config / fresh-consumer 两处 conformance 断言红→绿。

## SHA 链（6 commits，全部已 push 到 fork）

| SHA | 内容 |
|---|---|
| `f2adca6` | WIP checkpoint（草稿保护，不含最终产物） |
| `e76cd3b` | feat: plugin.yaml manifest + icon |
| `e692308` | chore: shrinkwrap 生产闭包 8 项 |
| `dc1b3f2` | chore: catalog 条目 + catalog-check 名单 |
| `7ca22be` | chore(release): contract-ci.yml push paths + build/publish 步，release-config.test.ts orderedPackages 插入 |
| `666f7f0` | test(fresh-consumer): companion 依赖断言改 sdk pin |

## 验证证据

- **本地全量 `pnpm gate:ci` 27/27 绿**（2026-09-27，214s，冻结工具链
  node 24.18.0）。前三次全量失败均已修：
  1. step 1 工具链 PATH（托管 wakeWhen 丢 PATH → 内联冻结 PATH 解决）；
  2. step 5 release-config 红："catalog artifact packages/personal-chrome-companion
     is missing from the publication workflow" → `7ca22be` 修，单跑 28/28 绿；
  3. step 23 fresh-consumer 红：companion `dependencies` 断言旧值 undefined →
     `666f7f0` 改为期望 `@clowder-ai/plugin-sdk: 0.2.0-beta.8`（与 weixin-mp /
     wechat-visible-reader / enterprise-workflow 的模块插件依赖形态一致），
     单跑绿。
- **包内 135 测试全绿**；release-config 单跑 28/28 绿。
- **exact-head 双 CI（Contract CI + Personal Chrome Companion CI）**：
  _待填——见下方"CI 状态"。_

## CI 状态

- `666f7f0` push 后（2026-09-27 ~16:06 UTC）**超过 10 分钟无 pull_request run
  触发**；此前 736256a 的 synchronize 均在 1 分钟内出 run。
  疑似因 `7ca22be` 改了 `.github/workflows/contract-ci.yml` 触发
  "workflows awaiting approval"（fork PR 改 workflow 文件需 maintainer 点
  Approve and run）。**请 operator 在 PR #54 页面确认/点批准后 CI 才会跑。**
- 已知风险：catalog pin 来自本地 darwin 冻结工具链 `npm pack` 字节；CI Linux
  repack 若字节不同，Contract CI 会在 catalog 校验步红——按 d51a664 既定流程
  用 CI actual repin，不算新问题。

## p2b 占位清单（本 commit 链已钉住、待 p2b 实现）

- `append-message`：向已绑定会话追加消息（当前占位，fail-closed）。
- `assistant-returns.list`：列出 assistant 返回批次（占位）。
- `assistant-returns.ack`：确认批次消费（占位）。

## 观察项（不改、只记录）

- SDK 的 module host 参考载体目前**不透传 `dataDirectory`**——SDK 参考
  carrier 未接 h2 数据目录接线；真实 Host 用自己的 carrier，不受 SDK 参考
  实现限制。manifest 里 `dataDirectory: personal-chrome-host` 声明保留，
  等 Host 侧接线时生效。

## 待对齐：pluginId 提议

提议 pluginId：`official.companion.personal-chrome`
（feature `personal-chrome-host`，dataDirectory `personal-chrome-host`）。
catalog 条目、manifest、catalog-check 名单均已按此落地；若复审要改，
三个面一起动。

## 复审锚点更新（2026-09-27 16:50 UTC，以本节为准）

PR #54 曾与 origin/main 冲突（CONFLICTING），已解并产生两个新 commit：

| SHA | 内容 |
|---|---|
| `262f721` | Merge remote-tracking branch 'origin/main'（解四文件冲突，见下） |
| `303f0ec` | ci(companion): typecheck 前先 build contract / SDK 依赖（修 CI 红） |

**冲突解决（262f721，四文件）**：
- `.github/workflows/contract-ci.yml`：push paths union 加 `packages/xiangqi/**`；保留 Local gate 单步 + 追加 origin 的 Xiangqi 两步。
- `scripts/fresh-consumer-install.test.mjs`：ours + 7 处锚点插入；关键修复 = consumer install 参数数组补 `xiangqiTarball`。
- `pnpm-lock.yaml`：ours + pnpm install 重生成。
- `migration/f202-train-c1-inventory.json`：补 xiangqi 分类条目。

**CI 红根因与修复（303f0ec）**：head 262f721 上 Personal Chrome Companion
CI 的 "Companion typecheck" 红（job 108660291714）——workflow 在 fresh
checkout 直接 typecheck companion，但 workspace 链接的 plugin-contract /
plugin-sdk 无 `dist/`（exports.types 指向 `dist/*.d.ts`）→ TS2307 连锁。
本地 gate:ci 绿系本地 dist 已构建 + gate:ci 不覆盖 companion。修复 =
workflow 加 "Build contract and SDK dependencies" 步（镜像
feishu-meeting-intake 模式）；先红后绿验证过。

**本地证据（303f0ec 树上）**：`pnpm gate:ci` 全量绿（1-22 包级 +
23 fresh-consumer + 24 inventory 9/9 + 25 catalog:check + 26 registry:check
+ 27 pack:gate）。

**Exact-head 双 CI 绿（head `303f0ec`）**：

| Workflow | Run | Job | 结果 |
|---|---|---|---|
| Personal Chrome Companion CI | 36334021263 | 108661299509 | pass, 2m42s |
| Contract CI（含 exact-HEAD 断言步） | 36334021308 | 108661345476 | pass, 10m33s |

（Publish to npm job = skipping，仅 main push 触发，属预期。）

## 复审锚点更新（2026-09-28，SDK beta.9 切片 + 真实入口测试提升，以本节为准）

**背景**：sol 在 exact-HEAD 复审中指出 SDK module host 参考载体不透传
`dataDirectory`（上方"观察项"），插件在真实载体上 `start()` 直接抛
`FeaturePermissionError(PERMISSION)`——R1。codex 在 SDK 0.2.0-beta.9
修复该载体缺口（`6c022987cba19e646f8523f422c38d16826f9c50`，PR #54）。

**beta.9 切片收口坐标**：
- sol 独立复审 approved（thread 消息 `…000934`）；astra canonical 终验通过
  （`…000937`）；任务 `…000892` done，#54 写锁回归 kimi。
- SDK 0.2.0-beta.9 canonical sha256
  `8579f442d0a68c37d12a0e887685012d7d386939b621c0a3a7bad42e082a98b7`；
  beta.8→beta.9 成员集不变，仅 8 个冻结允许文件变化；contract 保持
  beta.25 字节不变。

**R1/R2 复现证据（beta.8 上实测红，本地 probe，2026-09-27）**：
- R1：真实 `create(plugin.yaml).start(host)` 在 beta.8 抛
  `FeaturePermissionError: feature has no data directory`（exit=1 复现）。
- R2（负例，codex SDK 测试覆盖，包内不重复）：无 grant 的 binding 不得
  泄露 Host 路径。

**本切片改动（父 commit = `6c022987`）**：
- 新增 `test/personal-chrome-real-entry.test.ts`（node:test，随
  `pnpm test` 自动拾取）：占位三方法的 own-function + contract 官方
  validator 检查（Host h3 启用预检对齐）；真实模块入口
  `create(manifest).start(host)` 全链路——授权 list/status/test 可调用、
  三个 h3 方法在 actions 表内为 own function 且结果过 validator、
  `stop()` 干净退出。
- 包内 137/137 绿（含 2 条新增）；typecheck（build + test 双 tsconfig）干净。
- 本地 probe（`p2a-real-entry-check.mts`）已删除，使命由正式测试接管。

**Review 范围建议（本切片增量）**：
1. 新测试的 host stub 是否与 SDK `ModulePluginHostShape` 真型对齐
   （typed，非 `as never`）。
2. 断言覆盖面是否够钉住 h3 预检（own-function + validator 双检查，
   placeholder 与真实载体两侧）。

## Review 范围建议

1. plugin.yaml 声明与 SDK module host 契约是否对齐（capability /
   cloud-conversation-host / dataDirectory）。
2. 授权三操作的 fail-closed 边界（list/revoke/status 的输入校验矩阵）。
3. shrinkwrap 8 项闭包是否完备、pin 是否与兄弟包一致。
4. 两处 conformance 断言改动是否合理（release-config orderedPackages 插入
   位置；fresh-consumer 依赖断言改 sdk pin 的方向）。
5. 7ca22be 对 contract-ci.yml 的改动是否最小（push paths + build/publish 步）。

[小狸/k3🐾]
