# Issue Workbench：不改宿主的集成验证

来源：`thread_mucwsgsjtlbabfcq#0001792581407565-000003-5f98a34a`，2026-10-21。
本次仅修改插件仓。宿主 checkout 为 `1167a07f8e27f2a1bc7ab123565444a3ba63c018`；
测试未修改其源码、现有编译实现或当前运行猫咖。

## 红 → 绿

旧 PR HEAD `32f4ecf83dd2d1fb796bdf20ca03578a8493315c` 制品的真实安装失败：
`INVALID_PACKAGE_ARCHIVE` / `PACKAGE_AUTHORITY_MISMATCH`，原因是只包含
`plugin.candidate.yaml`，缺少规范 manifest。先观察该失败，再在插件侧改用
`plugin.yaml` 并同步打包清单与测试。新测试直接消费原样 tarball，不重写包或载体。

规范 manifest 也使本包进入仓库现有安装文档门禁；第一次完整运行在第 31/35 步
发现缺少独立英文说明。已补齐中文默认 README、英文平行说明、互链与打包清单，
并在实际 tarball 检查三份使用/测试文档。修复后的 7 项 package-inventory 检查通过。

真实 Host composition 下的隔离旅程已通过：

1. 默认策略准入精确包，但有效权限为空；此结果单独保留。
2. 显式测试权限下安装、配置、启用、九项原生工具和 schedule 注册。
3. 未登录 owner 请求被拒绝；公开邀请缺少二次确认被拒绝。
4. 研判请求经过 Host 消息和唤醒边界，重放去重，提交结果并保存人工反馈。
5. 分类队列准备、启动、暂停、恢复，通过真实声明的 schedule action 收口。
6. 打包浏览器保存/重载人工方案，点击真实 owner route 发起研判并收到结果。
7. 邀请评论仅发布一次，不改变负责人；接收端独立库存/数据库启动补收。
8. 接收通知不等于接手；接收账号显式提交 accepted 回执，协议解析读回一致。
9. 重建 Host 运行时后保留数据；离线恢复不重发通知；关闭来源后拒绝旧回执。
10. 清除仓库授权及 Manager 禁用后，原生访问和 schedule 停止，未产生额外评论。

## 证据与适用范围

可重跑入口和 prerequisites：
[HOST-TESTING.md](../../packages/issue-workbench/HOST-TESTING.md)。
本地运行记录：`packages/issue-workbench/artifacts/installed-host-2026-10-21/`。
每轮保存 exact archive integrity、Host HEAD、关键编译模块 SHA-256、源码/运行时
前后不变检查、详细日志与浏览器截图。最终全门禁及输入冻结记录位于同目录
`verification.json`，最终 Host 复跑位于 `final-run/`；以实际生成结果为准。

真实组件：安装器、库存、配置、生命周期、module carrier、owner operation
路由和确认、消息、Redis 私有存储、声明 schedule 及精确打包 UI。
夹具：owner 登录、猫名单和调用身份、确定性研判、GitHub CLI 网络、READ 数据源、
测试 grants、schedule runner；Thread/Message 使用宿主内存实现并在运行时重建间保留。
没有启动真实模型，没有发布真实 GitHub 评论，没有向实际成员派工。

默认生产 grants、自定义工作台实际授权连接、真实模型研判与双账号交流尚未完成。
保持 `hostInstallable:false`；这份隔离集成证据不是全部已安装功能的完成声明。
本次为作者验证，未新增独立审查或合入声明。
