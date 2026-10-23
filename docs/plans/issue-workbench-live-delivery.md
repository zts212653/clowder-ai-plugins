# Issue 工作台真实交付路径

当前托付：`thread_mucwsgsjtlbabfcq#0001792581407565-000003-5f98a34a`
（2026-10-21：“在不改宿主代码的情况，我希望能够完整验证这个issue插件的能力”）。
沿用插件 PR #80 与原 Task；**不修改宿主源码，不增加专属白名单，不改生产配置**。
本记录替代此前等待宿主修改授权的路径，不再次把该决定交给用户。

终点仍是实际可用的问题工作台：人工标注与方案保留、真实猫猫研判、分类队列、
组织成员通知、接收端启动补收、明确接手与回报。自动化夹具不代替真实旅程。

## 已完成的独立集成路径

宿主源代码已按用户要求更新到 `1167a07f8e27f2a1bc7ab123565444a3ba63c018`。
插件仓新增 `pnpm --filter @clowder-ai/issue-workbench test:host`：

- 加载该宿主现有编译实现，通过真实安装器安装原样 `.tgz`；插件侧已修正
  `plugin.candidate.yaml` 不被识别的问题，使用规范 `plugin.yaml`。
- 使用独立项目目录、文件库存，以及测试进程专用 Redis（仅 Unix socket、独立
  AOF 目录）；发送端与接收端使用不同数据库，当前猫咖数据不参与实验。
- 经过真实配置服务、module 生命周期、owner-operation HTTP 路由与确认、
  原生工具、Host 消息、持久状态、已声明 schedule；浏览器点击跨过同一条动作链路。
- 用明确夹具代替登录、模型运行、GitHub 网络、调度时钟及功能测试所需 grants。
  无真实成员任务、GitHub 评论或 assignee 写入。
- 检验重建运行时、离线恢复、去重、来源撤回与 Manager 禁用；记录宿主源代码状态
  和关键 dist 文件摘要未变化。

操作与证据边界见 [HOST-TESTING.md](../../packages/issue-workbench/HOST-TESTING.md)。

## 正式安装仍未满足的条件

默认 Host 策略单独测试：本地包现在能准入，但未登记的
`dev.clowder.issue-workbench` 获得空 grants。功能测试显式提供七项测试权限，
这不是当前运行宿主的配置入口，也不表示实际生产安装已获授权。
`integration.json` 的 `hostInstallable:false` 保持不变。

只读依据为当前 Host 的 `manager/machine-catalog-provider.ts`、
`manager/official-plugin-host-policies.ts`、`runtime-composition.ts` 及生产 composition。
不靠改插件 ID、直接读取生产数据、复制内部回调凭据来绕过这项边界。

标准配置/动作已可通过既有 Manager 验证；自定义工作台的实际授权连接仍需验实物。
测试浏览器使用插件自带 HTTP 桥接夹具，不冒称已在运行猫咖里安装了自定义页面。
5198 现有真实 READ 预览继续保持独立，测试数据不覆盖其用户记录。

## 真实外部闭环

默认邀请模式只发布结构化评论，不要求给 Issue 添加 assignee；因此此前
`READ` 账号不能设置负责人不再阻塞这条邀请路径。能否发布评论仍以目标 Issue
与当前账号的实际权限为准，不能从组织成员资格推断。

真实试用需要明确允许测试的 Issue 和接收账号；用户已被询问这两个坐标。
接收者使用自己的 GitHub 登录、收件对话与猫配置，验证“通知 → 本人明确接手 →
回执 → 发送端读回”。本地模拟通过不能替代这项验收，也不授权向真实成员发送任务。

本文件记录当前路径与缺口；不授予宿主改动、生产配置修改、真实派工或合入权限。
