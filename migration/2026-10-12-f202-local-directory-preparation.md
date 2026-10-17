---
feature_ids: [F202]
topics: [plugins, dependencies, local-directory, migration]
doc_kind: implementation-guide
created: 2026-10-12
tips_exempt: Developer-only source preparation; no new Host capability or operator UI action.
---

# C1 仓内目录的保留版本准备

Settings 选择的是已构建的插件目录。根 workspace 的 `link-workspace-packages` 会把旧 SDK 声明解析到当前 SDK；这不是包声明的运行闭包。发布包的原 `npm-shrinkwrap.json` 已钉住各自版本，不能为了目录安装统一升级或重写它们。

正常根 workspace 依赖安装的 `postinstall` 会自动恢复以下准备；若安装时显式使用 `--ignore-scripts`，交付者须在目标包构建后执行同一命令：

```sh
pnpm prepare:local-directories
```

该命令只准备声明 SDK beta.12、beta.15、beta.19 的十二个目录。它从仓内已有 SHA256/SRI 认证的原归档恢复对应 SDK/contract，放入该目录的 `.clowder-local-directory/dependencies/`，调整该包的运行依赖链接，并生成描述实际物理图的 package-local `pnpm-lock.yaml`。其余生产依赖继续使用原 workspace lock 的精确坐标和现有物理成员。

准备不改 package.json、production shrinkwrap、根 workspace lock、共享 SDK/contract 或插件业务。SDK 与 contract 配对分别是 12/29、15/30、19/35。每次运行都从认证归档重新校对已有缓存，不能用可改写的缓存 receipt 自证；独立 package-local lock、非链接依赖目录和未知链接目标会拒绝覆盖。首次写入前逐组件核对 namespace、dependency、archive 根及 alias 父链，现有组件必须是包内真实目录；父级 symlink 或非目录直接拒绝，不清理或覆盖。

这些生成目录和锁仅用于现有 Host owner-local source resolver，不是 registry 发布物或 consumer override。可选目录仍是 `packages/<plugin>` 本身。后续 workspace 安装会先恢复 workspace 链接，再由根 `postinstall` 恢复保留版本图；显式禁用 lifecycle scripts 的安装仍须执行准备。该接线使普通依赖重装不会悄悄撤销已准备的目录。准备后再冻结准确物理图交 Host 验收。不要在已冻结的验收批次中运行安装、构建或准备命令。

十三项脚本回归涵盖版本配对、重复准备、声明/根锁不变、缓存及 receipt 同时改写、独立目录保护，以及各写入父链和已有 archive 根的 symlink/非目录拒绝且外部目标不变。还需按实际目录运行 Host source inspection、分发/安装和对应插件旅程；脚本通过不能代替它们。首次实物核验为十一目录 source PASS，钉钉因原供应商 `dingtalk-stream` 的版本 `v2.1.6-beta.1` 与锁坐标 `2.1.6-beta.1` 写法差异被 Host 拒绝；Host `f1a89ac` 规范化该拼写后，同十二个目录 source 坐标全部通过。第三方成员、声明与锁均未改，两批证据分别保留。

已有 archive/空目录 consumer/旧版本证据保留各自范围。原 C1 整项仍按两仓可合入、可发布及迁移后实际可用验收，不增加额外泛化审计。

## C1 完成后的兼容边界（operator 1266）

SDK 包版本是插件携带的库版本，Host 产品版本不是该依赖的替代坐标。Host 按公开契约和能力满足插件需求，目录安装仍按插件声明的 exact 或 semver range 校对实际依赖与 source lock；不能以 Host 较新为由把 SDK20 冒充 SDK15。此次修复保留原插件与 SDK/contract 的版本和归档字节。

本轮完成后的维护线必须保持旧插件所用公开接口及其行为。废弃先标记 `deprecated`，给出替代方式、迁移说明和跨版本窗口；经过若干版本不自动获得删除权。仍承诺兼容的维护线保留旧接口，真正移除须进入明确的破坏性版本并说明迁移边界。源码中早期“1.0 前预期 breaking”的说明仅记录此前开发阶段，不能用来推翻这一完成后的承诺。

兼容性验证须包含旧 SDK/contract 的原插件在新 Host 上的安装及相关操作，不能只验证共同升级后的组合。依赖坐标递归校验、实际目录分发/Manager 安装、模块启用与真实供应商收发分开记证；缺少账号时，已安装且等待配置不等于真实业务收发通过。
