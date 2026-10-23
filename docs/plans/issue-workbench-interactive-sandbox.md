# Issue 插件可交互隔离试用

授权：message:0001792585713186-000021-dbd0a5bd；沿用原 Task 与 PR80。

- demo_kind: journey_validation
- delivery_lane: internal_product_gate
- 判题：用户能否亲手完成方案保存、模拟猫研判、双端邀请/明确接手/回报，并在失败或重启后继续。
- visual_source_of_truth: 现有打包 TeamWorkbench、CoordinationWorkbench、team.module.css；原工作台不重做。
- native_elements: 原样打包 UI、字段、业务运行时、Host 安装/配置/owner route/native tool/Redis。
- stylized_elements: 可折叠模拟控制栏、两端切换、猫响应和网络设置、模拟接收猫回报。
- truth_label: 始终显示“隔离模拟：账号、GitHub、猫结果与授权为测试替身；不连接生产猫咖”。

信号路径：用户真实输入 → 打包页面 → 隔离 Host 路由 → 真实插件业务与持久存储 → 模拟外部回应 → 同一页面读回。
关键画面：发送端的邀请与接收端明确接手回执互相对应；切换角色不冒充真实成员。

数据保留于独立目录，Redis 使用私有 Unix socket 和 AOF，线程/消息/插件状态不设 TTL。
发送和接收使用独立项目及数据库；GitHub CLI 替身拒绝未知操作，不回落真实网络。
宿主源码、编译实现、当前配置、5198 已有 READ 预览及用户数据不修改。

验收：陌生方案文字保存/刷新/进程重启；猫成功/失败/等待与恢复；分类队列；邀请到接收端显式接手与回报；来源关闭、网络失联、禁用及恢复；移动布局与页面错误检查。
这一授权模拟交付不代表实际生产安装验收完成。无真实模型费用、无真实 GitHub 写入或成员派工。
