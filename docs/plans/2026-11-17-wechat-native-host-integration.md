# 微信新连接服务接入完整宿主旅程

来源：原 Task `0001794671791059-000075-403b5a41`、安全重写授权 `thread_mwg7kandcxztqeab#0001794847733075-000352-bf448701`、[完整重写要求](2026-11-17-wechat-native-security-rewrite.md)。本计划细化未完成的 consumer，不改变原好友/群主动开口、接话、切猫和随时接管目标，不作为阶段发布或完成声明。

Before：本人依赖宽接口第三方 daemon，自己分辨组件、授权和在途状态；出错后难以知道能否恢复。After：在同一插件卡片准备并验证自有组件、扫码或明确恢复、选择当前对象和猫、一次授权后正常代聊，接管立即生效，未知不重发，恢复有具体入口。人保留账号、目标、模型数据范围、是否恢复及真实运行许可；不抄 token、命令或文件路径。

## 已核现场与权威

工位 `clowder-ai-plugins-wechat-delegation / feat/wechat-delegation`，PR 232 draft。显式恢复 `d83aa2b` 获000428、Host/Supervisor `8f512d7` 获000440、认证/消息基线/查证 `ab8dfa4` 获000448准确HEAD typed approved，均只覆盖各自内部实现切片。NativeSupervisor/NativeLinkClient/Runtime现已消费自有私有stdio组件，旧HTTP客户端与daemon资产已移除。当前运行的旧插件尚未替换，真实账号未操作，不能把内部检查当完整产品验收。

面板沿既有设计提供原认证记录、取消、明确恢复已保存会话、同步状态及本地停发/发送端确认的分立投影；隔离浏览器已覆盖取消/刷新不重建、群主动开口/接管/未知、恢复连接不恢复代聊、桌面/手机和暗色。`b236ced`的强制runtime签名和实物防注入已获000453 approved。钥匙串修复现以独立有界进程、原生系统对话框及持久意图接入；单一init.phase在首次发布前持久推进，仅有证据的首次初始化可恢复，不按缺失密文猜空库。真实系统对话框/跨进程升级、显式LAN及最终总体验收仍待；无DeveloperID/公证。

- WeChat/协议进程拥有原始账号秘密、消息同步游标、加密消息、关系证明、发送意图及最终提交。Native Store 是唯一账号事务 owner。
- Host 的 DelegationService 拥有用户策略、policy/global epoch、模型会话选择、对人可见的运行记录和停止意图；不得复制一套到 native 再声称两边都是用户意图真相。
- NativeSupervisor 拥有精确子进程及资源；LinkClient 只做受限 DTO/私有管道适配，不拥有另一套策略。
- Runtime 负责两者编排、当前 owner HTTP 鉴权、操作与恢复；MemberRunner 只接已授权聊天文字，无账号秘密/Native lease/MCP 发送面。
- `PluginMemberSessionsHost` 的 create/prepare/revoke 需当前 authenticated owner operation，见 `packages/plugin-sdk/src/member-sessions.ts`。后台安全暂停不能假借该权限。revoke 仅 sessionId，故旧撤销必须在新的同槽 prepare 前结束，不能让迟到撤销误伤新授权。

## 必须先覆盖的组合反例

1. A 的 native 核验尚在途；人接管；C 明确重新开启。迟到 A 或旧停止请求不能把 C 变成无效但显示 active 的策略，也不能重新激活 A。
2. 两个开启请求读到同一个旧 epoch：只允许胜出的请求申请 native grant，失败者不能晚些撤销胜出者或让其 lease 失效。
3. 模型交还本人、保持安静、异常、到期等退出 active 的路径，同样须阻止 native 尚未提交的消息；不能只接按钮。
4. Host 已交给 native 的文本在握手中跨过用户 expiresAt：native 最终提交点仍须拒绝。grant 记录保留，不把到期等同删数据。
5. 进程重启后 instance 不同、账号相同：旧策略不恢复，旧未知发送仍阻止同账号同会话重新开启，不能因 policyId 含新 serverId 绕过。
6. 账号恢复保留消息流；换账号/新库/新流时旧事件 cursor 不可直接套用。首次同步的历史（包括发送方时钟在未来的消息）不能被当成新消息回复。
7. ACK 丢失、QR/恢复/目录操作未完成：始终追原 operationId；原生暂时返回 unknown operation 时不能悄悄新建意图或再次认证。

## 工作单元与顺序

### 1. 发送端期限及 Host 停止观测

改 `native/link/src/outbox.rs`、`messaging.rs`、`ipc.rs`：显式授权把可选 expiresAt 写进 grant，最终 check_lease 校时；旧快照缺字段默认无期限但重启已暂停。不要靠 JS 定时器保护已经在握手中的消息。先以已排队、期限在最终提交前经过的检查观察 RED，再 GREEN。

改 `src/service.mjs`：成功 CAS 后、释放 serial 边界前发出同步的停止观测。覆盖 global epoch 推进和 active 退出，重复 ownerStop 无新变化则无新观测；观察者只发起/登记异步控制，不等网络。恢复 Native lease 随 policy 快照复制到 run，绝不在发送时从全局表取“最新 lease”。跨 instance 的未知阻塞按真实 accountIdentity/accountId/conversationId 检查。

验证：真实 Service 的持久状态先变、停止观测先于后续 serial 任务；silent/needs_owner/异常/接管均通知；重复 canonical owner message 不重停后来的授权；不同 serverId 仍拦同会话未知；每个 run 保留自己的 lease。

### 2. 私有流的类型消费端和进程监督

新 LinkClient 对 hello、status、认证、目录、事件、消息、lease/receipt 作封闭字段/范围验证。未知/秘密字段、身份错配只返回固定错误，不转发原对象/诊断。QR 仅 owner 面板；MemberRunner 白名单内容维持不变。submit 验证本 run 的 lease 后同步写管道，写前无 await；已写超时/abort保持 unknown。

使用当前 pinned 子进程 PID/产品/协议/版本/能力核 handshake，运行 instance id 每次启动变化，持久 store/stream source ref 则稳定，二者不混用。当前 Store.serverId 持久，不能直接拿它冒充新进程身份。Supervisor 仅启动已验字节的自有子进程，不查外部 PID、不选另一个 backend、不继承 secret/代理/证书环境。去掉 HTTP token/端口和旧 daemon 资产，安装不偷偷启动。

需要区分原生 API 可用与完整产品/真实账号安全已验收；不要用一个 ready/enabled 包打天下。未换完整 consumer 前不发新安装包。

验证：实际子进程乱序/退出/丢 ACK、假 PID/版本/能力、带秘密 DTO、原生退出立即投影；native 真实无参拒绝与合成 private-store 服务组合分开记。普通存储故障保留原件，不能降级易失或静默开新库。

### 3. 策略开启、停止与恢复顺序

Runtime 按真实 policy 串行化开启/换猫的整个过程，包括 preflight、模型 prepare、native grant、Host CAS 及失败清理；停止不排在长网络后面。开启在 Service.serial 中检查 UI 确认的 policy/global epoch，并取得同步控制票据，然后把网络 promise 包起来离开 serial。停止观测先在同一 serial 中登记 barrier/epoch 并发出 native pause；新开启等已登记停止完成，旧开启被 epoch 拒绝。避免把 Host epoch 再持久成第二套 native 策略。

显式 owner 操作中的模型 revoke 也登记到开启 barrier，先于后来同槽 prepare 完成；后台边界暂停只 abort 已有工作和降低 native 权限，不能调用无 owner 权限的 prepare/revoke。旧失败开启的清理必须在自己的开启队列内完成，不能晚到新授权之后。停止本地 ACK 不等 native status/网络 ACK；底层未确认单独显示，必要时关闭自有组件以阻止新发送，旧在途仍不伪报取消。

验证：两个并发开启、核验期间接管、停止 ACK 延迟后再开启、同 sessionId 的旧 revoke 延迟、无 owner 的消息订阅停止、进程退出及 preStop/stop 权限撤销顺序。控制失败不能报告远端已停，不能重发未知。

### 4. 认证操作、消息基线和历史查证

Runtime 持久认证 nonce/类型/来源，异步拥有真实 start/resume/poll promise。页面可查、取消；本地 requesting 只表示意图，不伪造 native 成功。查询只追相同 id，未知/中断不换 key。显式恢复和新扫码在产品中分开，旧 backend 的未完成意图标中断并保留，旧真实 profile 不读取或迁移。

消息流给 Host 一个 opaque source ref；cursor 按来源持久，不只按常量 accountId。同账号 resume 沿原流，新库/新登录流隔离。授权回复前完成初始 catch-up 并记录事件序号基线，旧历史不因发送方未来时间而触发模型。持续消息用原事件/消息引用去重；有同步 reset 时暂停授权、重建基线并等本人明确交回，不能自动回复回灌历史。

按服务端 id 查询 canonical 消息，核账号、会话、方向、正文和受理回执关联。没有可信 server id 的未知发送不靠相同正文猜测送达；保留 needs_review 与本人 confirm_seen，不重发。

验证：初始历史/未来时间、ACK 后 cursor 未提交崩溃、恢复/换账号/换库、重复事件、reset、朋友与群主动开口/接话/切猫、未知与到期。Host/Model/错误/持久记录跑真实全组合秘密 canary。

### 5. 卡片修复、制品与实际验收

沿已接受面板设计补 setup/auth/health/repair 和明确恢复入口，读既有设计/需要时走 console-dev。不得把终端命令、argv 或找文件的任务交给本人。Keychain 锁定、初始化中断/缺钥、签名或版本升级、LAN challenge 均要可理解的动作，原件保留；无凭据迁移或新数据边界的隐式 fallback。特别是现有 vault.id 不足以区分从未完成初始化与旧数据丢失，恢复前先取得持久阶段证据，不能删除标记重建。

从 release 原始构建记录核 Rust/Cargo、C 编译器、SDK、OpenSSL 来源/摘要及部署最低系统版本；实际 debug 构建仅链接系统动态库，OpenSSL 为锁内静态 vendored 3.6.3，但该事实不等于最终 release 的分发/安全验收。用最终归档在空白 consumer 运行物理入口/关键模式，SRI/manifest/catalog 同字节，独立 review 绑定最终 HEAD。真实账号登录、收发/接管仍需本人在准确披露后明确授权；merge/publish/close 不由本计划授权。

## 代价与未决

保留一个自有 native 子进程，撤掉通用 daemon，不为每只猫挂代理。初次 catch-up 和逐项关系核验会让首次开启等更久，换来旧消息不误回复和收件人正确；UI显示进度而非要求人猜。私有管道与有界 DTO 不增加额外常驻组件。开启队列只约束同一策略，停止不等待网络；未知停止可暂时阻止重新开启，防止迟到 pause 误伤新授权。真实外部故障保留具体恢复入口，不把所有暂时失败都升级给人。

技术未决由本 Task 继续取证：LAN 显式许可与兼容、初始化/升级恢复、流基线与最终签名制品。六把业务 key 的来源仍未知；两把 MMTLS 验签 pin 已匹配腾讯签名制品。最终 claim 应按实际层级分别验证，不把“全 key 未确认”或“测试绿”替代完整对端与数据流论证。真正需要本人判断的权限/生产数据/正式发布，待具体产物与 Decision Packet 齐备再交本人，不预先反问技术 A/B。

## 仓库内已核检查

行为改动先跑相应精准 RED/GREEN。包回归：`node --test packages/wechat-delegation/test/*.test.mjs`。构建：`node packages/wechat-delegation/scripts/build.mjs`。包 lint：在包目录 `npm run lint`；新文件另 `node --check <file>`。Rust：`cargo test --offline --locked --manifest-path packages/wechat-delegation/native/Cargo.toml`、`cargo fmt --all --check --manifest-path packages/wechat-delegation/native/Cargo.toml`；来源：`node packages/wechat-delegation/native/scripts/verify-source.mjs <固定上游协议目录>`。最后 `git diff --check`。当前仓无通用 formatter，不能照搬其他仓的 pnpm check。最终采用已有 packed/fresh-consumer 与 Host 隔离旅程脚本，按最终修改范围执行，不拿旧 alpha.10 的归档证据覆盖新服务。

Architecture cell：同一微信插件 Host consumer 与原自有连接服务。Map delta：HTTP→私有 stdio、精确 instance/source 身份、持久停止观测及开启 barrier；Host 策略/模型选择与 native 账号/发送事务的 owner 不变。Why：将已接受的发送端安全契约带进真实 operator 旅程，避免接口局部正确但组合后恢复或接管失效。
