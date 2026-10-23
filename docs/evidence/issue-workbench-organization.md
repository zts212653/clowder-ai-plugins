# Issue 工作台：GitHub Organization 人员关联

用户要求：`thread_mucwsgsjtlbabfcq#0001792547645594-000008-95c47697`。
验收对象：用户给出的 [meow-club](https://github.com/meow-club)。

## 本次完整路径

在插件设置填写 `teamOrganization=meow-club` 或组织主页链接 → 当前 gh 登录身份验证
active membership → 分页读取组织成员 → 团队面板显示组织/人数 → 团队记录展示并刷新
人员 → 研判后的人员选择使用同一来源 → 派工前重查成员与仓库权限。

真实组织读取/展示已走通：本机账号是该组织的 active 成员，生产打包 provider
读取 10 位成员，本地 5198 展示/刷新/重新载入名单。成员用户名不入库到本公开报告。
桌面/390px/暗色截图与行为记录保存在 `packages/issue-workbench/artifacts/organization-2026-10-21/`。
本地演示的 Issue、猫研判和派工使用隔离数据，标明模拟；真实 GitHub 写操作为 0。
原任务的真实 Host 授权与双账号猫猫旅程仍没走通，本次不扩大为 Core 修改。

## 校验

- 红：provider 不具备组织接口；旧名单导致指派错误用户；组织读取失败仍派工；打包页面缺组织信息。
- 绿：44 条团队检查（含完整分页/大小写/非法输入/权限失败/组织切换/移除成员/旧名单不回退）。
- 打包页面：组织人数/成员刷新，读失败清掉旧选项并保留研判，确认派工/重载/反馈/回执恢复。
- 类型检查和打包构建通过。完整托管命令耗时 426 秒，35 项仓库门禁和 6 条打包浏览器/READ 旅程全部通过；114 个输入文件摘要回读一致后才更新本文档。既有 Feishu pack 豁免不变。
- 完整命令、exit code、输入摘要见 `artifacts/organization-2026-10-21/verification.json`；原始输出为 `full-gate.log`、`browser.log`，回读为 `readback.json`。
- 旧名单设置不删除，但不再产生人员资格；历史研判/派工和手工记录不迁移、不清空。
- 无新增运行依赖、Host/SDK/Contract 修改、真实派工或公开评论。

## 风险与边界

behavior：成员来源变更；data：保留记录、无 TTL；security：名单不是仓库权限，副作用前重读；
contract：插件内部 provider 与候选配置变更，无共享 SDK/Host 契约修改；irreversible：本轮无。
插件仍为 `hostInstallable:false`。沿用用户要求独立完成的方式，本报告为作者自验，
不等于独立批准；不合入 PR #80。

接口依据：[GitHub 官方 organization members 文档](https://docs.github.com/en/rest/orgs/members#list-organization-members)。
核对时间：2026-10-21。只采用接口明示的成员可见性/分页/权限条件，未外推为仓库可指派权限。
