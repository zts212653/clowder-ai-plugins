# 可交互隔离试用

这个入口用于亲手体验 Issue 插件。界面和业务来自原样打包制品；登录、权限、猫结果、GitHub 和调度时钟为模拟。不会调用真实模型、给成员发任务或写真实 GitHub，也不会安装到正在运行的猫咖。

## 使用顺序

1. 在 **发送端 · bob** 选择问题，先看自动分类；需要时展开“补充分析（可选）”并保存。切换视图和刷新后，已保存内容保留。
2. 选择 **猫猫研判 → 请猫分析**。默认自动返回明确标注的模拟结果，可填写反馈，也可在团队记录中运行分类队列。
3. 用 **通知成员接手 → 确认发送邀请** 邀请 alice。模拟评论会保留，发布通知不会替对方接手。
4. 切换 **接收端 · alice**。在“模拟接收猫回报”填写自己的说明并发送回执；切回发送端，刷新团队结果查看。回报走真实插件的 native tool，只替换调用者为模拟猫。
5. 展开 **模拟设置与故障恢复**，试猫连接失败、超时等待、GitHub 离线、关闭/重开来源及插件禁用。恢复成功后可补交待处理结果。该控制栏不会伪造业务状态。

两端工作台分别保留未保存的页面草稿；刷新前仍需点击保存。已保存的方案、分类、邀请、回执、线程与消息使用独立文件/Redis AOF 持久化，服务正常重启后恢复，不设数据 TTL。模拟页面服务可能因预览租约到期停止，数据不随服务到期删除。

额外内源合成仓可用于跨源关联、分类分析与派工；它没有真实平台连接。页面底部可核对模拟评论及数据位置。

## 从源码启动

这是插件仓中的试用工具，不是生产安装功能。需要已安装本仓依赖、已编译的 Clowder AI checkout、`redis-server`，以及 CONTRIBUTING 指定的构建工具链。不会构建或修改 Host。

```sh
ISSUE_WORKBENCH_HOST_ROOT=/absolute/path/to/clowder-ai \
ISSUE_WORKBENCH_SANDBOX_DATA=/absolute/path/to/new-empty-sandbox-data \
PORT=5200 pnpm --filter @clowder-ai/issue-workbench preview:sandbox
```

初次启动仅构建和打包插件。也可用 `ISSUE_WORKBENCH_HOST_ARCHIVE` 指向已有 `.tgz`。
数据目录必须为空或由本工具创建；不会接管未知目录。后续重启复用已钉住的原包，不将新 UI 混接到旧运行时。更换制品可使用新的空白目录；也可先停止并备份这个隔离目录，再明确设置 `ISSUE_WORKBENCH_SANDBOX_UPGRADE=1` 和新 `ISSUE_WORKBENCH_HOST_ARCHIVE`。后者通过原 Host 的本地包替换保留两端实例、配置与状态，两端准入成功后才更新制品钉住值。升级失败会报错；不要手改钉住值绕过检查。

工具仅监听本机回环地址；Redis 禁止 TCP，使用独占 Unix socket 和不同数据库隔离两个成员。停止时向该工具进程发送 SIGTERM/CTRL-C，会关闭其服务和 Redis，保留数据与宿主不变检查报告。不要同时用两个进程操作同一个试用目录。

自动回归需指定 Host 和 archive，再执行 `pnpm --filter @clowder-ai/issue-workbench test:sandbox`；浏览器检查可通过 `PLAYWRIGHT_CHROMIUM_EXECUTABLE` 选择现有 Chrome。覆盖手写方案、模拟分析、双端显式回执、持久恢复、失败/等待及访问撤销。

该环境证明可操作流程与业务状态，不证明真实模型质量、真实双账号 GitHub 交流或当前生产 Host 的授权/自定义页面安装支持。正式安装状态仍为 `hostInstallable:false`。
