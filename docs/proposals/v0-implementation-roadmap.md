---
title: Clowder AI 插件系统交付路线图
status: current
created: 2026-07-14
interface_baseline: docs/plugin-development.md
feature_ids: [clowder-ai-plugins-init, P-1, F202, F288, F292]
topics: [roadmap, plugin-contract, plugin-sdk, host-broker, plugin-manager, contribution-plane, migration]
doc_kind: roadmap
---

# Clowder AI 插件系统交付路线图

本页规定插件系统的交付范围、依赖和完成条件。
[设计原则](plugin-system-principles-and-v0-design.md)定义边界，
[插件与 Host 接口基线](../plugin-development.md)定义当前接口，
[源码开发和安装指南](../plugin-projects.md)定义包侧构建、制品核验和安装方式。
Host 文档拥有其实现与验收条件，不复制一套公共 schema。

## 基础底座完成条件

一个独立 npm 插件必须能够：

1. 从插件仓发布的机器 catalog 被 `list/search/get` 确定性发现、查询并安装；
2. 通过统一 Plugin Manager 完成校验、配置、启用、禁用和卸载；安装、配置、授权、用户意图与
   runtime 健康分别投影，不能用一个 `enabled` 冒充完整状态；
3. 依赖公开 Contract；SDK 可选。能力由 manifest／YAML 声明，module 启动返回实际 handler map，
   普通消息、线程、成员、配置、私有存储与附件读取按当前接口基线使用；Host 按声明的能力分类
   分发，不另开一套运行时 contribution 注册协议，也不抹平 `mcp/skill/limb/schedule` 的协议分类；
4. 对多 feature 插件可独立启停 feature，并在拒绝或失败时只回滚该 feature、
   不泄漏注册或扰动健康 sibling；每项 SDK effect 都绑定 Host-authenticated feature
   execution lease，不能退化为共享的 plugin-level authority；
5. 在重启后恢复正确状态，并在禁用或卸载时完整撤销注册、停止执行和按声明
   保留或清理数据；
6. 第一方与第三方插件走同一 SDK、Broker、grant、trace、ledger 和生命周期路径；
7. GitHub、IM、voice/service 等业务实现、thread routing 与外部回推都在插件侧；Host 中没有
   provider-specific factory/router/handler，Hub 普通消息入口与 SDK 消息写入共享一个
   canonical admission。
8. Console 与 Agent 只投影同一份 Host inventory：catalog 真相源属于插件仓，已安装 artifact、
   config/auth/intent/live 状态与 grants 属于本机 Host；插件或 Agent 不维护第二份 inventory。

达到以上八条，才算“基础底座完成”。某个 package 发布、某组 wire row ready、
Host merge 或 loopback 单测通过，都不能单独替代该完成线。

## Host 与插件的分工

Host 拥有 Plugin Manager、安装 inventory、制品信任／摘要、配置与凭据、grants、普通资源权限、
消息 admission、调度、分型 resource registry、载体监督和持久化。
Console 与 Agent 管理同一份 inventory，不维护第二安装状态。

插件拥有 provider 协议、业务 handler、外部会话映射、线程选择、平台回推与业务恢复状态。
它们通过单份 manifest 与启动 handler map 接入对应子系统；普通消息入口使用统一 admission。
`mcp/skill/limb/schedule` 保留各自协议与权限语义，不能合并成无差别执行入口。

## 交付范围与依赖

| 范围 | 结果与完成条件 |
| --- | --- |
| Train A：Runtime | 可校验的公共契约、传输及 fail-closed 行为；真实 Host seam 与 conformance 一致 |
| Train B：基础底座 | 机器 catalog、静态声明、公共 SDK、统一 Manager／Marketplace／Agent 管理；video-analysis 证明隔离安装到卸载的纵切 |
| Train C1：业务迁移（已收尾） | 业务由独立 package 实现，保留数据及恢复边界；Host 使用单条安装／执行路径，无旧新双跑 |
| Train C2：后续能力 | 音频／managed-service、插件自带界面、Collective／Meeting 后续产品化与保留的物理硬件产品；以对应真实消费者与权限边界验证，不算作 C1 已交付 |
| 正式版 | 相关迁移、真实使用、数据处置、文档、版本和 registry 证据齐备；Host 与官方插件消费同一发布批次 |

C1 业务迁移的源码范围已收尾；对应新 Host 与新插件仍须完成成对分发和实际安装验收。已激活版本与摘要以 [catalog](../../catalog/catalog.json) 为准，源码候选见 [candidate](../../catalog/candidate.json)，各包 manifest 定义实际能力。包发布并核验后才通过普通 PR 激活目录。
[初始选择](../../catalog/initial-plugins.json)保存选择与启用意图，不证明所选包已发布或可从官方目录安装。
Collective 与 Meeting 的源码及本地候选不属于当前官方目录，其后续产品化归入 C2／独立后续，不能作为未关闭的 C1 尾项。
构建及安装按[开发指南](../plugin-projects.md)验证。Dot 仍由 Host 提供，留待单独迁移。

Plugins 提供可复现的准确制品，Host 消费同一字节完成安装、配置、启用、使用、重启、禁用和卸载。
开发验证使用隔离数据；生产默认路径切换与数据迁移必须符合 Host 的验收和操作权限。
发行后 Host 固定 registry 可解析的版本与摘要，而不是可变分支或 dist-tag。

## 必须保持的不变量

- Contract 是 schema、生成类型、capability 表与 conformance 的单一机器真相；SDK 与 Host 消费同一份。
- 公开 surface 与三部分接口基线一致；新增能力同步实现、类型、真实消费者和文档，不维护平行公共入口。
- 每次 effect 绑定 Host 注入的实例／feature／实际 activation 与 grants；撤销后旧 client 不因 sibling 存活而继续执行。
- 消息的 actor/source 从 Host context 与 identity registry 派生；业务 metadata 不升级权限。
- 每个迁移项的配置、凭据、消息、映射与业务 cursor 有清楚归属及恢复策略；用户数据默认持久保留，清除需显式选择。
- 一个能力只有一条实际业务执行路径；失败、停用、卸载与回滚均不得产生双跑。
- catalog 与实际 tarball 的声明、入口、依赖、版本和摘要一致；已发布版本的字节不可覆盖。
- 安装与配置意图、runtime 健康、操作 receipt 和真实业务连通分别表达，不相互冒充。

## 正式版发布条件

正式版使用将要发布的准确制品验证，不能用工作区或旧预发行结果替代：

1. GitHub、至少一个 IM provider、飞书／既有 standalone 插件完成安装到卸载的真实旅程；
   完整正式版的 voice-suite（ASR + TTS）验收依赖 C2 对应能力，不宣称为 C1 已支持。
2. GitHub 覆盖调度、持久状态、工具与身份；IM 覆盖入站、普通消息投递、身份与外部回推；
   voice-suite 覆盖其服务／artifact 和界面能力。共同覆盖发布范围内的 surface。
3. 开发文档覆盖声明、接口、生命周期、权限、凭据、消息、数据迁移与回滚；至少一个示例能从空目录构建运行，
   示例通过相应类型与 conformance 检查。
4. Contract、SDK、Host pin、catalog 和官方包约束来自同一批制品；版本、provenance、digest、npm integrity
   与回滚坐标准确，并满足 [CONTRIBUTING](../../CONTRIBUTING.md) 的 CODEOWNER 与发布规则。
5. 真实使用、数据隔离与文档条件满足后才发布正式版本并推进 `latest`；未满足时保留预发行状态。

## 后续扩展

foreground cat／windows／presence、记忆、任意可执行插件信任和 network/filesystem sandbox 等能力，
按自己的实际消费者、权限与数据边界交付。当前普通 threads 已属于接口基线；不能把历史设计中的排期或
示例签名当作新能力已经实现的证明，也不提前开放任意 hook 或 UI code execution。
