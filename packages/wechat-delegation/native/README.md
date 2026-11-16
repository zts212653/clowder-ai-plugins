# 微信文字协议子集（实施中）

这是账号安全重写的内部实施代码，尚未接入用户正在运行的插件。无参只开放hello/status；显式私有目录已接扫码、文字发送/接管、入站同步及当前目录，仍以accountServiceReady=false报告完整服务未就绪。显式会话恢复、完整Node/Host接线、正式制品和真实验收仍缺，不能将此进程当成完成的账号连接服务。入口契约见[IPC.md](IPC.md)。

来源与授权：本人 `thread_mwg7kandcxztqeab#0001794847733075-000352-bf448701`；架构来源为宪宪 `000355` / `000362`，独立威胁稿为小多子 `000356`。完整产品与安全终态要求见 `docs/plans/2026-11-17-wechat-native-security-rewrite.md`。`b3028a9`的内部持久层与依赖更新已获小多子`000397`准确HEAD独立批准，未覆盖尚缺的执行器/真实旅程。

## 代码来源与当前边界

`proto/` 是从 MIT 上游 `thisnick/agent-wechat@ed976d78c1e1cc2a49ad17d1e2c0da023bbb5c8e` 物理裁出的代码。逐文件原始与派生 SHA-256、排除文件/模块在 `UPSTREAM.json`；完整修改在 `protocol.patch`。保留原许可及固定公钥数据。两把MMTLS验签公钥值现已与本机腾讯签名制品匹配，砚砚独立复跑确认；六把业务层公钥来源仍未确认，不能称全部官方已证。详见[KEY-PROVENANCE.md](KEY-PROVENANCE.md)。

未编入原 daemon、HTTP API、账号 profile、存储、音视频、媒体/CDN、贴纸、图片/压缩包解析、官方桌面微信导入。保留扫码、会话、同步、纯文字和好友/群目录协议及其相关回归。密钥算法与消息格式沿用上游；不能把移植称为完整密码学审计。

新的 `transport.rs` 集中生产建连和 HTTP 客户端构造。HTTP 仍使用原锁定的成熟 reqwest 解析，移除 TLS 栈，仅允许固定 MMTLS POST、禁跳转、禁代理继承；不手写 HTTP 响应解析。DNS 结果先过滤本机/私网/元数据地址，再固定给本次连接，防止第二次解析绕过。网络请求还须经过15条文字/账号/目录业务路径白名单。没有通用 URL 接口。

当前保留系统 Fake-IP 路由，并在观察记录中如实标注；不能据此声称实际出口直连腾讯。长链记录 socket 实际读写字节；短链仅记录准备的加密请求体、读到的响应体，不把它们冒称内核流量或服务端实收。握手签名及Finished均验证后才记录实际选中的pin版本和区域，这仍不证明pin的官方来源。DNS 解析本身仍由系统阻塞 resolver 提供，不声称整个解析过程有严格截止保证。

扫码尝试类型不再实现 Serialize/Deserialize；快照导出只在内部测试编译。不用的官方 profile 数据库密码与原始认证快照在认证归约后清零丢弃。最终保险库仍必须保护剩余的实际会话秘密。

当前不会自动处理服务端要求的 LAN 登录挑战：协议返回 `LanApprovalRequired`，账号服务记为`lan_required`，不打开监听器。该情形的显式授权及实际兼容路径仍待完成，不能把常规QR隔离检查当成所有账号都可登录的证明。

## 可复跑检查

工具链为 Rust/Cargo 1.93.1；在仓库根目录运行：

```sh
cargo test --locked --manifest-path packages/wechat-delegation/native/Cargo.toml
cargo fmt --all --check --manifest-path packages/wechat-delegation/native/Cargo.toml
node packages/wechat-delegation/native/scripts/verify-source.mjs
# 有固定上游源码时，另核完整来源与补丁重建：
node packages/wechat-delegation/native/scripts/verify-source.mjs /path/to/agent-wechat/packages/native-client-rust/crates/wechat-protocol
```

依赖缓存齐备时可加 `--offline`。初次构建复用原Cargo.lock，曾遇tokio 1.54.0 yanked；本轮已核上游安全公告并将直接pin和锁文件升级至1.54.1，下载包摘要与官方registry一致，其他包版本未变。适用范围和复跑证据见[DEPENDENCY-NOTES.md](DEPENDENCY-NOTES.md)。这仅处置了已识别的问题，不代表整个依赖集合已完成安全验收。

可信 RED：原版接口探针可以编译头像/CDN API；原版通用路径校验仍放行 `mmemojiupload`，新负向检查明确失败。当前派生库以编译失败文档检查拒绝媒体、通话、原始快照出口及扫码尝试序列化。

伪服务端测试运行真正的握手实现：成功进行 ECDH 并发送有效加密记录，但使用非内置私钥签名，客户端必须在 `MMTLS signature verification` 终止；除无凭据 ClientHello 外不发送字节。隔离副本忽略验签失败时，同一测试因没有在验签阶段终止而失败；这验证了检查的检测力，不表示观察过真实账号泄漏。

协议检查输出在共享工作区 `meow-talk/output/wechat-delegation-security-rewrite/protocol/`。`74c18cf`的协议/stdio基础已获小多子在`000382`的准确HEAD独立批准；批准范围不覆盖后续保险库/执行器、正式制品、实际安装或真实微信验收。

stdio入口的2项局部检查及实际编译进程的组合检查已通过：未知方法/字段、重复键、超长或截断帧不回显输入内容；正常关闭stdin后进程退出，无任何账号授权或网络活动。这些是实现后的组合验证，不虚报为在旧组件上观察到的RED。进程在创建工作线程前清除环境、禁止core dump，并在macOS请求拒绝调试附加；完整分发签名及钥匙串ACL的效果仍需独立验证。

本目录是内部实施材料，尚无新增用户操作入口或可发布能力；capability tips不适用。完整产品旅程目前没走通，Task不关闭，不向本人提供此进程作为安装候选。

## 凭据与发送持久层（未接入运行入口）

`link/src/keychain.{rs,c}`将随机32字节包装密钥保存在固定service的macOS文件钥匙串条目中，以创建进程本身为唯一受信应用；不扩大到所有应用，不更新已有条目的密钥/ACL，不改搜索列表，也不回退到同目录密钥文件。所有调用禁用交互；锁定、缺项或应用身份变化时向上返回固定错误。默认钥匙串只在显式打开账号服务时使用；本次测试从未调用该默认入口，全部使用新建的私有合成钥匙串。

选择文件钥匙串ACL是针对当前未配置access-group provisioning的CLI边界，不冒充数据保护钥匙串、Secure Enclave或不可导出硬件密钥。Apple [TN3137](https://developer.apple.com/documentation/technotes/tn3137-on-mac-keychains.md)区分了两类钥匙串；正式签名、升级后的授权和恢复入口仍须验证，不能从一次本机探针推导分发终态。C shim以系统Security/CoreFoundation编译，复用锁内cc、OpenSSL和anyhow，没有引入新的registry包版本；最终构建溯源还须记录实际C编译器/SDK。

`vault.rs`使用AES-256-GCM及每次随机nonce；密文头绑定独立的vault身份。0700根目录、0600普通单链接文件、末级symlink拒绝、持有目录FD的openat和flock限制落盘入口。原子提交先写独占临时密文、同步文件（macOS另用F_FULLFSYNC）、rename，再同步目录。初始化先写不可静默重建的身份标记；缺钥、损坏、缺密文均保留原件并报错。提交持久性不确定时，当前owner停止读写，由显式重开核查实际状态。没有TTL或隐式删除；单快照上限32MiB，超限报错，不清理历史。上述检查不声称抵御已控制同UID/root、能够回放或替换整个目录的攻击者，也不是突然断电实测。

`store.rs`是账号凭据和发送状态的唯一事务owner，向协议库提供数据型AccountPersistence回调：先加密持久化再发布状态，比较previous和账号generation，拒绝旧回调在退出后重新激活账号。未使用的数据库密码及原认证快照禁止落入此store。`outbox.rs`是同一store内的发送记录与会话授权，无第二套独立队列/凭据writer。

显式授权后的会话generation和账号generation共同保护发送；接管持久化后取消queued，已进入submitting的保留真实在途状态。最终before-submit guard必须调用begin_submission，不能在握手或await前调用并把它当网络提交证明。重启把submitting标为needs_review、取消未发队列并暂停全部会话，不重发未知结果。持久库本身不执行网络。当前AccountService的messaging模块已将此guard接到真实协议文字入口，并新鲜核好友/群关系；宿主运行版本仍未替换。

本次检查覆盖真实后端跨进程恢复、用同一C后端的异身份程序拒读、钥匙串锁定保持密文、重复项不覆盖和搜索列表不变；隔离文件测试覆盖篡改/缺失/替换、权限、hardlink/FIFO、互斥、失败提交与不确定提交；账号和好友/群发送门禁覆盖更新、退出、接管、幂等与重启。测试及RED摘录见`meow-talk/output/wechat-delegation-security-rewrite/vault/`。这些检查不替代完整秘密投影、Host→新进程接线、实际网络观察或本人授权后的真实账号验收。

## 登录服务接线（实施中）

登录意图和结果写进同一个加密Store；QR图片、identifier、notify key和一次性批准材料只在协议适配器内短暂持有，不能序列化成宿主响应。回执保留，不用TTL删除；重启把未完成意图标为Interrupted，不自动重试。只有匹配当前ticket的Completing操作才能原子提交账号和Succeeded回执。取消/断开先使持久意图失效，网络返回后仍核同一ticket，迟到结果不能复活账号。

协议层新增LoginGuard，扫码创建、轮询与认证交换在业务提交前检查取消和期限，包括认证redirect后的下一请求。服务只允许明确分类的QR轮询暂时失败继续查询；认证交换不自动重放。已进入认证阶段再取消/掉线时，`authenticationMayHaveOccurred`如实保留可能已有服务端授权，不冒充已撤销手机上的设备登录。

stdio只将login.start/poll、conversation.authorize和text.send交给最多两个工作线程，状态/取消/断开由入口线程执行；实际流测试已复现串行长轮询阻塞取消，改动后取消先返回，迟到认证结果被丢弃。关闭stdin使进行中的操作中断。RawValue保留params原文后按窄结构解码，拒绝重复键、未知字段及凭据导入；错误不回显输入或底层诊断。

本轮生产NativeLoginPeer已调用真实协议方法；自动化登录旅程中的远端由测试专用LoginPeer替身提供合成响应，用于验证真实Store/AccountService/RPC/stdio组合。协议取消checkpoint另有直接检查。没有运行真实微信登录或声称已实测网络中途取消。真实子进程仅跑无参离线入口和启动参数/目录拒绝，不读取默认钥匙串条目；钥匙串回归仍用新建私有合成库。日志与RED边界在共享`meow-talk/output/wechat-delegation-security-rewrite/login/`。

## 文字执行接线（实施中）

`link/src/messaging.rs`调用同一NativeClient账号owner的scoped request；未创建第二份凭据或并行发送队列。意图先落盘，最终协议提交点持control锁后进入Store的begin_submission，与pause共用顺序；身份核验/握手/网络期间不持control锁。暂停也推进本进程授权epoch，禁止核验途中的旧授权迟到复活；重启继续用持久grants暂停和unknown不重发。

结果只有通过目的地/client id与业务code验证、带规范非零u64 serverId才为accepted；匹配的明确拒绝为failed，其余在途结果为needs_review。accepted不宣称对方已读或canonical同步回显。完整方法和字段见IPC.md。生产路径采用NativeTextPeer；组合测试用替身控制远端回执，不能冒充真实微信网络发送检查。

应用层身份判定来源为同一固定MIT上游wechat-core/src/metadata.rs（完整mask及字段控制）、peer_classification.rs（系统/公众号排除）及本包既有current-directory.patch（群成员正向证明）。只复用这些小范围解释，无core/profile/SQLite依赖；许可仍保留于proto/LICENSE，协议26文件来源checker不覆盖新应用代码的语义正确性。

## 入站同步接线（实施中）

`inbox.rs`在同一Vault State中新增默认空的inboxes字段，保留按账号代次隔离的私有游标/命令、文字投影和有序事件。cursor、全部收到的command和可读投影同事务提交；失败时均不发布，未知命令加密保留且披露未投影数，没有TTL/删除。消息摘要去重、冲突不覆盖旧正文，无变化轮询不增加checkpoint或改写Vault；32MiB快照上限及显式恢复需求继续保留。

`sync_service.rs`用相同NativeClient account owner调用真实sync，私有ticket核账号与checkpoint，网络不持control锁；断开/EOF后迟到结果不能提交。只投影受限message/event字段，群发言人保持未解析，非文字与不支持正文不交给模型。明确session rejection通过同一处理入口暂停授权/停止client但保留凭据，文字核验与发送路径一并采用；无自动重试/续期。生产入口已经接线，自动化远端仍是替身，不声称真实微信同步或手机断网/接管实测。

## 当前目录接线（实施中）

目录从零拉取联系人ID，再独立发现群候选，逐项复用文字发送的verified_target核好友/成员关系。旧入站群id只作候选，头像/原始metadata不回传；名字字段最多512字节。未核实及群发现不完整分别披露，不能用缓存推断关系。

同一Vault保存刷新意图、终态及最终当前缓存，中间进度只在进程内推进；重启/退出/EOF记interrupted，不自动续跑。新刷新替换当前外部目录缓存，但保留旧意图回执；聊天/发送/控制历史没有TTL或删除。每次metadata查询免写整个Vault，完成时一次发布。自动化远端仍为替身，不是实际微信目录或Host安装验收。
