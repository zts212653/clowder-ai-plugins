# 微信代聊与人工接管（安全重写开发中）

[English guide](README.en.md)
本机桌面微信检测使用独立自有只读探针，与持有账号凭据的服务分离。连接卡分别显示桌面状态与插件连接；可在未准备账号组件时检查安装、运行、签名和权限。只有受支持版本且明确的应用菜单证据才显示已登录，权限不足或不认识的界面保持无法确认。系统辅助功能权限仅由本人勾选后请求；真实系统权限归属及正向菜单识别仍待现场验证。检测不导入桌面会话，不触发扫码、恢复或发送。

插件的协议连接会建立独立的电脑端会话；能否与现有Mac或其他电脑微信同时在线尚未验证，不能由桌面检测或代码里的客户端身份推断。扫码入口保留这项未知说明，不将“已识别桌面”当成“已沿用桌面会话”。


目标是在 Clowder AI 中由本人选择普通微信好友或群、选择猫与说话风格，允许主动开口和接话，并随时交还本人。不是 iLink Bot、桌面 OCR 或只会回应群内提及的替代方案。

**当前分支尚不能作为新安装版验收。** 自有原生服务、私有管道消费端、发送端期限与接管、持久认证意图、同步基线/重置和精确发送查证已实现。面板已提供明确恢复/取消、同步状态、钥匙串系统授权和有证据的首次初始化恢复；显式LAN许可已接入，真实系统交互、最终完整验收仍在继续。`accountServiceReady=false`。正在运行的旧插件未被替换，未操作真实微信账号，也未合并或发布本候选。

## 当前实现与安全边界

- 自有 `clowder-wechat-link` 取代原 Agent WeChat 通用 HTTP daemon。协议仅保留固定 MIT 来源的文字、登录、目录及同步子集，没有通用 URL、shell、账号秘密导出或旧桌面 profile 导入。来源、修改及已排除模块见 [native/README.md](native/README.md) 与 [native/UPSTREAM.json](native/UPSTREAM.json)。
- 凭据和消息在同一加密 Vault 持久化，密钥由 macOS 文件钥匙串保管，当前 ACL 绑定自有应用；不是 Secure Enclave 或 Data Protection Keychain 的声明。文件身份、权限、锁与不确定提交会检查并保留原件。钥匙串授权只在本人明确操作后由独立进程调用系统窗口，密码不进入Host/模型/argv；首次初始化须有持久阶段证明或已经解密的精确空内容，不能靠删除标记或换库掩盖故障。真实系统对话框、跨进程授权和升级兼容仍待本人在场核验。
- 子进程只在本人的已认证操作中准备；使用精确摘要核验和私有 stdin/stdout，没有本机 HTTP 端口或 token。不传入本人的环境变量，原生入口再次清空环境；不读取旧 `native-profile`。本候选仅有 macOS Apple Silicon 制品，当前构建最低系统版本为 macOS 26.5。
- Host 持有用户策略和模型选择；原生服务持有账号、关系核验和最终发送。每轮固定账号、对象与授权快照；接管和到期在实际发送点再次生效。工作线程在入口取得准入票据，排队的旧登录/授权也不能在后到的控制动作后复活。
- 同会话开启串行执行，接管先持久记录本地停止，重新开启等待已登记的原生停止与旧模型撤销。隐式交还、保持安静、到期和异常也会暂停发送端；后台安全暂停不冒用本人权限撤销模型会话。插件关闭释放本地资源，迟到模型结果不能再访问已撤销的 Host 存储或提交发送。
- 模型仅通过 Host 受限成员会话收到本人填写的人设、目标和获准聊天文字；无账号凭据、Keychain/Vault、二维码、收件人改权或直接发送工具。外部聊天文字按不可信数据处理。验证码、支付、链接等明确边界会转交本人；文字规则不是识别所有骗局的保证。
- 已提交、受理、未知与真正核验送达分别记录。未知或 ACK 丢失不自动重发，同账号同会话的未知记录不能因子进程重启而绕过。聊天、控制与发送历史无默认 TTL。

完整接线计划：[Host integration](https://github.com/YukinaXSer/clowder-ai-plugins/blob/feat/wechat-delegation/docs/plans/2026-11-17-wechat-native-host-integration.md)。内部接口：[IPC.md](native/IPC.md)。具体签名、构建字节、依赖及许可：[assets/native/README.md](assets/native/README.md)。两把 MMTLS 验签 pin 已与本机腾讯签名制品匹配；六把业务 key 来源仍未确认，不能把局部核验称为总体验收，见 [KEY-PROVENANCE.md](native/KEY-PROVENANCE.md)。

## 验证范围

Node 检查覆盖 Host 控制顺序、私有流和封闭 DTO、通讯录、模型权限及隔离打包入口。Supervisor 使用可执行的合成对端验证新建/重开、进程身份、精确停止和目录安全；真正内置二进制只跑无参离线入口和缺失状态下的修复拒绝，不打开默认钥匙串。发布制品必须启用hardened runtime；实物检查拒绝DYLD动态库注入。Rust 检查覆盖真实 Vault/Store/服务/IPC 组合；认证与微信远端用合成适配器，Keychain 检查使用新建私有合成钥匙串，系统授权检查仅用已有受信且已解锁的合成条目，不弹真实窗口。

这些检查不证明本人已扫码、真实好友/群已经收到消息、真实主号兼容或平台认可。本人的真实登录、收发和接管验收仍须在具体候选与准确披露齐备后明确授权。

开发检查（仓库根目录）：

```sh
node --test packages/wechat-delegation/test/*.test.mjs
node packages/wechat-delegation/scripts/build.mjs
cargo test --locked --manifest-path packages/wechat-delegation/native/Cargo.toml
```

包与原生协议代码按 MIT 许可；依赖和保留的来源许可随自有原生制品提供。本候选仍为 draft，不提供替换当前运行插件的操作步骤。
