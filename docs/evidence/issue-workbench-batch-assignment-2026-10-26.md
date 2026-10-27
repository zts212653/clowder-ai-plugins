# 一次性 Open 批量派工验收

用户原文：`thread_mucwsgsjtlbabfcq#0001793029470179-000018-8a39ac4a`。接续 PR80 `65b131b`，本轮新增统一看板，不将旧 reviewer approved 当成新增代码结论。

## 真实旅程

顶部“批量派工”读取所有已启用仓库的 Open 快照；缺分类可请已配置猫逐条补齐，仍不派工。看板展示每条分类/系统/职责/分数/推荐及成员分布，允许改人和跳过。既有负责人保留。核对后明确确认才持久执行，刷新/重启恢复；已完成项不重复发。批次提交人标识 system，真实 GitHub 身份与 owner 审计保留，派工说明/记录/收件不再附加提交者验收建议。

既有七人 OS 硬筛选与职责、同系统提交者、Feature/类别、普通池权重优先级保留；批内虚拟配额只影响预览，写入回读成功才提交实际配额。编辑/确认绑定 revision，整体权限/成员/来源/策略预检后，每条写入仍通过原安全边界。已进入批次的问题不被后台自动派工抢发；停止/跳过仍保留这项主人选择，可再准备新批或单条确认。没有向真实成员执行批量测试。

## 验证与留存

插件工位 `packages/issue-workbench/artifacts/batch-assignment-2026-10-26/`：

- `red.log`：新增批次 owner action 尚不存在时，5 组行为用例失败；`ui-red.log`：缺少看板组件时失败。
- `green.log` / `package-test.log`：准备零写入、组织分工/加权、修改与跳过、全量预检、原文/成员变化、权限拒绝、猫分析不自动派工、重复确认、未知发布、停止与后台派工隔离、system 通知、120 条规模下组织读取合并。最终包级团队测试 104 项、UI 31 项，来源/同步/数据测试全部通过。
- `lint.log`：类型与来源边界通过。`browser.log`：打包后的新批次完整交互，以及原单条派工/邀请/收件两条旅程，3 项通过。
- 新旅程用 7 条隔离 fixture 验证可派工、Windows 无成员、手调、跳过、已认领、待分析、跨平台；修改人选并跳过后只有两条实际 fixture 写入。关闭/重启/重开不重复；desktop/mobile 截图为 `board-desktop.png`、`board-mobile.png`、`completed.png`。
- `pack.json` 与 tarball：归档 integrity `sha512-9PCHMkXkKIzCIqZHQgyKX0Eb+bI3xwVDwbBlHPyCE8SaMvLcPV7lSOSi6WFmWhG5jDD2EOVjqm4cY3O1dGyIVA==`。
- `gate.log`（全仓 gate）与 `host.log`（隔离 Host 组合测试）为执行日志，最终结果在完成后追加，不在运行中预记通过。

独立实验宿主 `/Users/yuki/Documents/AINest/cat-cafe-issue-workbench-lab/.cat-cafe/lab-evidence/batch-assignment-2026-10-26/`：

- `installation.json`：同一插件实例更新为上述 integrity、lifecycleRevision 45、running，未修改已有配置。
- `browser.json` 与 `installed-board.png` / `installed-board-mobile.png`：本人实际打开已安装 Host 入口 → 批量派工 → 准备完整已启用来源快照（当前本人 fork 1 条）→ 刷新重开保持同一批次；窄屏无横向溢出，pageerror 为 0。
- 真实页面仅调用 coordination/summary/getAssignmentBatch/planAssignments，无 confirm/retry 或 GitHub 写入。`github-before.json` / `github-final.json` 独立回读现有 Issue 状态和负责人，保留用户真实操作。
- 入口 `http://localhost:3142/api/plugins/dev.clowder.issue-workbench/workbench/installed.html`，完整 Hub `http://localhost:5142/`，独立 Redis 6358。托管 launchd 租期截至 2026-10-27 08:10:53 Asia/Shanghai；未改动原宿主。

证据边界：大批量执行和异常路径在真实打包 UI + 隔离 provider/持久测试存储完成；真实 GitHub/Host 验证只准备/恢复当前已启用来源看板，未向组织成员发起正式批量指派。真实评论作者继续使用登录账号；system 是业务发起标识。

Architecture cell：Issue Workbench team；新增持久批次协调对象，复用 DispatchRecord/分类/Host 调度。共享重复成员选项避免 Host 单值中重复存储名单；无新外部依赖、Host 授权扩张或生产数据修改。

## 收尾核验

- 全仓 `gate:ci` 的 1–31 项通过；32 项发现 README.en 正文混入中文按钮名，改为英文正文与 inline code 后，依照 `ci-gate.mjs` 原始步骤定义重新执行 32–36 全部通过（`gate-resume.log`）。这是分段全过，不是单次无失败全绿。后续刷新/升级增量另跑完整包 lint/test 和受影响浏览器、Host 验证。
- 120 条规模刷新原来逐条发起读取，`refresh-red.log` 复现后统一使用完整 Open 目录，仅对目录中缺少的旧条目单查。
- 实际升级旧归档时发现未去重草稿格式缺少顶层 options，`failure.txt/png` 与 `upgrade-red.log` 保留。显式兼容读取保留草稿，下次 owner 写入时才规范化；最终包真实 Host 已完成旧草稿读取 → 重新核对 → 重开恢复，无错误、无 GitHub 写入。
- 打包浏览器并行运行曾与测试内 build 竞争 dist，`browser-final.log` 保留该失败。构建现已统一前置到包级 `test:browser`，所有测试文件只读取同一已完成制品，避免单个测试清理其他测试正在打包的目录。此为测试入口修正，不改变运行时代码。
- 最终归档 `host-final.log` 通过完整隔离 Host 组合验证（13 项检查）；首次缺少 Chromium 默认安装路径的失败保留在 `host.log`，后续明确使用本机 Chrome。
- 独立 reviewer 小多子（cat-gpy5qnmg / gemini-4-argon-high）对运行时代码终点 `41ea6bf91ebbe3e84fb223e80edfc610965690a9` approved，0 findings。回执 `local-review:0001793032459532-000035-4dc61033:approved`；主范围回执 `local-review:0001793032314907-000031-2613cd14:approved`。均绑定本次原始消息。审查范围为源码、测试与作者实页产物核验，非 reviewer 本人 DOM 操作。
- 最终收尾提交仅文档与上述测试入口位置调整；`src/`、manifest、对外 owner actions 与 reviewed runtime 完全一致，以 git diff 检查 continuity。PR 保持未合入；远端 CI 状态以实时 GitHub 回读为准。

最终 `pnpm test:browser` 8/8 通过（`browser-all-final.log`）；测试入口修正后归档的 JS/CSS、模块及其他 dist 文件与已验归档逐字节相同；只有两份 HTML 的构建 SHA 从提交前的旧值更新为 reviewed runtime 41ea6bf（`runtime-continuity.json`）。最终归档的重新安装保留实例、配置与草稿。
