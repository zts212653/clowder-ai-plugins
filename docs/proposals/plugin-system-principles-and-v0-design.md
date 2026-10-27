---
title: Clowder 插件体系设计原则
status: current
created: 2026-07-12
interface_baseline: docs/plugin-development.md
feature_ids: [P-1, F202, F237, F240]
topics: [plugin-contract, plugin-sdk, host-broker, plugin-manager, contribution-plane]
doc_kind: governing-design
---

# Clowder 插件体系设计原则

插件承载业务实现，Host 保留身份、资源真相与通用控制面。
[插件与 Host 接口基线](../plugin-development.md)定义当前公开接口、身份、取消与生命周期；
[项目指南](../plugin-projects.md)说明开发和安装，[实施路线图](v0-implementation-roadmap.md)说明交付范围与验收条件。

## 实现边界

- 插件用普通 `threads`／`messaging` 访问 Host 资源；线程选择、外部会话映射与幂等业务记录归插件
  `storage`。安装实例、feature 和调用者事实由 Host 注入，业务绑定不增加线程可见性限制。
- 纪要等业务的 cursor、待发送通知和重试记录归包内私有队列／持久状态；通过普通
  `messaging.send(threadId, draft)` 投递，业务元数据随消息内容／meta 传递。
- 单份 manifest 声明能力，module 启动返回 handler map；作者使用同一个 `storage`、`log` 和必需的
  `messaging.get`。Host→Plugin 用统一 delivery 承载 message／execution_status；双向附件使用
  `streams.read`，reader 结束只释放本次读取，附件保留由 owner 决定。
- 安装、初始化、启用、停止、配置刷新和卸载按接口基线执行。插件管理自建 helper 的 start／stop；
  Host 管理 carrier、安装与启停。action 图像、轮询结果与 receipt 用于本次展示，业务恢复状态归插件
  持久存储；用户配置及声明凭据目标由 Host 正常持久化。

## 设计原则

| # | 原则 | 为什么 |
|---|---|---|
| P1 | **Inside-out 最小开放**：从"内核愿意暴露什么"出发，最小集起步逐步增加 | 内核保有灵魂（身份/记忆/会话真相单一来源）；面越小承诺越少、演进越自由 |
| P2 | **单一接口面**：SDK 是现有接口改造合理后的暴露子集，不造平行层、不为当前内部 API 包兼容 adapter | v1 冻结前，内核与第一方插件一起发版；现有接口不合理就直接改，两套并存才会制造兼容地狱 |
| P3 | **当前阶段数据兼容优先**：这次重构不承诺现有内部接口兼容，但本地持久化数据必须 migration；v1 冻结后，公开契约才新增独立兼容义务 | 客户端代码整体升级、数据持续存续；同时避免把“接口永不兼容”误写成长期原则 |
| P4 | **按能力域整体收敛，不留尾巴**：开放哪个域，该域接口一次调整到位，不 followup | 社区插件开放前是唯一自由重构窗口；半改的域 = 写进契约的技术债 |
| P5 | **hook 点位先审数据形状**：开点位 = 内部结构升格为公开契约 | hook 会把当下结构的不合理冻结进插件生态 |
| P6 | **宿主编排取代插件点对点绑定**：插件不得持有另一插件实例或私有 API；组合经宿主普通消息与声明能力编排（当前接口以本文前述基线为准） | 避免插件网状耦合；组合由宿主管理并可追踪，第三方 hook 的隔离／超时语义按真实需求定义 |
| P7 | **壳无关**：契约不规定实现载体 | 抽象对了，Electron/Tauri 是插件自己的实现细节 |
| P8 | **数据归属分明**：config/secrets/storage 三分；插件数据 namespace 隔离；身份/记忆/会话真相只在内核，全局记忆写入走蒸馏晋升。**闭环后 memory 候选域的唯一改造场是 #1047**：namespace 强制注入、宿主中介的受限检索等需求只作为输入提给 #1047 的接口抽象，不满足就推动那边调整，不绕开自建；该原则不承诺当前 v0 memory API | 插件不成为真相第二来源；桌宠"真"的来源在内核；记忆接口双轨会立刻违反 P15 |
| P9 | **桌面单用户检查**：每条安全约束先问“威胁在单用户桌面存在吗”；核心边界是跨插件隔离，而不是阻止用户查看自己的数据 | 不制造 SaaS 式虚空防御；但仍防 renderer/XSS/日志/截图意外泄露，用户显式查看自己的 secret ≠ 向所有前端或插件广播明文 |
| P10 | **推断不执行**：origin × epistemicStatus 两轴原生长在 envelope；inference 只能触发建议/确认 | 来源与推断必须区分，推断不能自动取得执行权限 |
| P11 | **一切插件行为可追溯**：call/callback/事件投递全部留痕（future hook 同规则） | trace 语义必须长在接口签名里，事后补加等于重做 |
| P12 | **动作有账，失败显式**：动作幂等入结算账本；职责回调必须应答；媒体或展示增补失败应显式降级、保留原消息；插件失败（含崩溃/资源耗尽）不拖垮内核、不静默吞 | 语义决定接口形状（callId/ack/超时字段）；"桌宠崩了 Clowder 不崩"是硬承诺 |
| P13 | **用户主权**：装/卸/启/停/授权/撤销/数据清除全部用户可见可操作；插件不能自启、不能自我续权、不能绕控制面 | proposal-first 的正面原则化；没有它前 12 条管住接口管不住行为 |
| P14 | **第一方不走后门**：语音/GitHub/IM/前台猫全走同一套 SDK；第一方由官方仓审核，第三方由安装者治理，调用通道一致 | SDK 撑不起自家插件就撑不起第三方；走捷径会让 SDK 退化成二等公民 |
| P15 | **契约只有一个机器可读真相源**：schema、类型、双向协议与 conformance fixtures 同包发布；内核和插件 SDK 都消费它，不复制定义 | 两仓协作不能变成两份 schema；文档可分仓解释，契约结构不能双写漂移 |


## 范围与验证

公开接口、数据保留和生命周期见[接口基线](../plugin-development.md)，构建与安装验证见
[开发指南](../plugin-projects.md)；官方已激活版本以 [catalog](../../catalog/catalog.json) 为准，未发布源码候选见 [candidate](../../catalog/candidate.json)。目录在包发布并核验后通过普通 PR 更新。
公开方法的类型、schema、实际消费者和开发者说明必须一致；制品还须验证生产依赖、公开入口与安装后的生命周期。
普通 CI、发布与实际用户体验分别核验，不能相互替代。

C2 的音频／managed-service 和插件自带界面仍是后续范围。记忆、任意可执行插件信任与公共 hook 等能力
按各自真实消费者、权限和数据边界定义，不能从设计原则推断为当前已支持的 API。
