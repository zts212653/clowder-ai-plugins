# 微信连接组件重写：账号凭据安全

授权：`thread_mwg7kandcxztqeab#0001794847733075-000352-bf448701`。本人要求砚砚、小多子、宪宪重写第三方组件，使其满足账号密码与登录凭据安全要求。沿用 Task `0001794671791059-000075-403b5a41`，不复制责任。架构已按宪宪000355/000362及小多子000356收敛为自有最小stdio进程、物理裁剪协议和应用身份绑定钥匙串。本文记录实施契约，不表示已完成重写或通过安全验收。

## 交付目标

用咱们维护、可从固定源码构建和独立审查的最小连接服务替换当前通用 Agent WeChat daemon。用户仍能扫码、选择当前好友与群、主动发起、持续接话、换猫、人工接管，并看到真实在途和未知结果。只给旧组件加一层代理、删几个接口、换产品名，都不能作为本次重写完成。

安全目标是：登录密码、扫码会话密钥、恢复凭据、数据库解密秘密等不进入模型输入、Chat、宿主可见诊断、公共接口或非微信接收方；只在本机受控保存，并在经身份验证的微信协议通信中使用。授权聊天文字仍按原约定交给本人选择的模型，不能把这一通道说成纯本地。

重写应用层与复用协议库要分开列明：已有密码学、协议编解码可以在审查后按固定版本复用，不能因新服务由家猫编写就把这些依赖宣称为已证明安全。固定源码与编译器摘要也不能替代源码审计。

## 已核事实与优先未知

- 基线工位：`/Users/yuki/Documents/AINest/clowder-ai-plugins-wechat-delegation`，`feat/wechat-delegation@2b227572e22540291592f7b4ef8b5774006985ec`。PR 232 为 draft；现有软件交付与真实微信验收边界沿用原验证记录。
- 已查运行版本为 alpha.9，候选包为 alpha.10。此次开发不替换当前安装、改变实际代理、读取真实凭据或触发微信发送。
- 上游固定 `thisnick/agent-wechat@ed976d78c1e1cc2a49ad17d1e2c0da023bbb5c8e`，MIT；当前 clowder.2 构建主要修复通讯录，未完成完整安全审计。
- 原通用服务包含媒体、通话、官方 profile 操作等与本次文字代聊无关的模块；自动链接缩略图有非腾讯 HTTP/HTTPS 下载路径。新服务不得启动该路径。
- 协议库 `AccountState` 含密钥且可序列化；新服务只能将其用于本机私有加密存储，不能直接把内部对象变成公开响应。需追完 QR、会话更新、重连、错误、持久化和退出的所有消费点。
- 当前进程网络经过 Clash/TUN。此前未取得最终出口，不能声称直连；应用域名限制也不能证明系统代理运营方、完整路由或所有依赖可信。

最先验证的未知：能否仅使用协议库完成扫码、文本同步、好友/群核验与发送，同时彻底不加载原 daemon/core 的自动下载、profile 接管和宽接口；凭据更新能否在持久化、并发和 crash 下保持单 owner、无秘密回传。

## 安全验收条件

| 条件 | 必需证据 |
| --- | --- |
| 密码与会话秘密不进宿主或模型 | 为每类秘密放置合成 canary，走实际生产 RPC/错误/事件/生成路径；宿主收到的响应、模型请求、日志、持久对话均不含该值或已知编码形式；同时审查数据流，不把有限 canary 当穷尽证明。 |
| 只开放必要能力 | 新服务提供显式的状态、账号、扫码、目录、事件、文字发送/核验/取消；未知操作、任意 URL、原始凭据导出、profile 导入、任意路径及 shell 等被拒绝。验证必须调用真正服务入口。 |
| 凭据本地保存 | 原子提交、私有目录/文件、symlink 拒绝、锁与重启恢复；加密密钥丢失或损坏时保留原件并报错，不自动生成新密钥覆盖数据。密钥与密文同机仍不代表能抵御已控制该 OS 用户的攻击者。 |
| 联网目的和对端身份受约束 | 所有 socket/HTTP 创建点的清单与调用链；恶意 host、redirect、链接预览与证书/签名失败的负向测试；隔离网络观察与最终制品核对。系统代理与 DNS 的证据边界单列。 |
| 供应链可追溯 | 固定上游代码、逐项列明复用/删除/改写部分、锁文件、构建脚本、许可、编译器和最终摘要；从干净源码构建，不接受运行时下载任意组件。 |
| 原有产品能力保留 | 生产 MemberRunner → service → 新 native 的组合测试；好友和群分别覆盖主动开口/接话、身份变化拒绝、幂等、接管先落盘后阻止新发送、取消未确认、crash 后未知不重发。 |
| 真实账号使用有独立结论 | 精确制品通过独立审查后，本人明确授权新组件登录并验真实收发/接管；不静默解密或迁移当前真实 profile，不把模拟或空白启动称作真实账号已安全验收。 |

## 分工与依赖

- 砚砚持整体 Task 与代码单写面，核源码、组织 TDD、实现替换服务/插件接线、构建候选及整合证据。
- 宪宪先交替换架构稿：最小可信边界、协议复用范围、状态生命周期、IPC 与网络契约、模块切分。原始请求已通过 multi-mention `77aec069-305a-4aa2-9171-4934db9f6374` 发出；架构尚未收到，不能先声称已批准。
- 小多子独立给威胁/泄密旁路与负向验收稿，之后审查准确最终 HEAD；只审不写。架构建议或旧 alpha 批准不覆盖本次实现。
- 同一 thread 协作，当前不另建需人批准的子 thread。两份独立稿不互相路由；收到后由砚砚整合，再安排需要的实施交接。真有独立写入单元时另核合法任务与工位，不在共享文件并发写。

## 实施单元

1. **凭据/网络基线与架构收敛**：完整入口清单、可复用协议的最小运行样本、安全验收矩阵、两猫独立稿。没有真实账号资料。
2. **最小连接服务**：自有生命周期与窄 DTO、秘密持久化和会话更新、扫码/目录/文本同步/发送。每项可观察行为先 RED 再 GREEN；测试使用合成凭据与隔离服务端。
3. **插件接线与原能力回归**：更新 NativeSupervisor/NativeClient 到新身份和协议，固定制品与摘要。沿用原持久策略，切换不能自动恢复暂停或重发未知消息。
4. **候选验证与独立审查**：从干净源码构建、原生入口负向测试、Host 隔离安装、完整朋友/群代聊与接管组合旅程、精确 HEAD review。修复发现后复验受影响范围。
5. **本人明确授权的运行验收**：先给可核对的制品、已证实保证与尚未覆盖项，再进入新组件登录及真实旅程；运行版本与代码交付分别记录，原 Task 在终态证据前保持开放。

## 状态和代价

新连接服务必须拥有唯一账号会话状态；凭据更新与退出有 generation/fence。旧会话返回不能重新激活已退出会话。发送意图在网络提交前持久化，未知结果不能重试；目录快照始终绑定账号身份，当前好友与群成员关系核验保留。

本次不为检查增加一组常驻代理。优先替换现有一个 native 进程，保留现有宿主/模型通道。收紧接口和删除自动媒体会减少可用功能，但本任务只承诺文字代聊；微信协议兼容性仍需验证。重写、审查及干净构建会增加交付等待，换取可逐项追溯的凭据边界；不以行数、测试数量或新进程名称度量安全。

## 当前进度与出处

- Task rev55 已记录本次授权及继续实施；未关闭原产品或单私聊测试 Task。
- 固定上游源码已通过 canonical `gh api` 取到临时隔离目录，只读审查中。当前 shell 未发现现成 Rust 工具链，正在准备同版本 1.93.1 的隔离构建工具，不借此更换项目依赖。
- 原外联核查：`meow-talk/output/wechat-delegation-alpha10/network-audit/核查结论.md`。
- 原产品与接管验证：`docs/plans/2026-11-14-wechat-delegation-verification.md`。
- 原构建与补丁：`packages/wechat-delegation/assets/native/{README.md,manifest.json,current-directory.patch}`。

Architecture cell：微信插件 native 连接服务。Map delta：将通用上游 daemon/core 替换为自有最小stdio服务；proto保留固定文字/账号/目录协议，KeyStore仅管理包装密钥，Vault仅负责私有原子密文，Store为账号/会话授权/发送记录的唯一事务owner，outbox为Store内状态机，不建立并行队列；原Node consumer尚未切换。Why：本人明确拒绝把未经充分核验的第三方账号组件作为信任基础。

### 本轮内部持久层自检（完整产品未完成）

原始使用路径仍是本人在插件中扫码→选指定好友/群→主动开口及接话→人工接管→明确恢复。**完整旅程没走通**：新stdio入口仍只有hello/status且accountServiceReady=false，登录/目录/sync/发送执行器与Node接线尚缺。当前KeyStore/Vault/Store/outbox是原授权内的必要实现，内审不代表分批交付、主号安全批准或Task关闭；后续沿同一owner扩展。

已在真正实现上验证：应用ACL绑定包装密钥、同二进制的新进程恢复、相同C后端异身份程序拒读、钥匙串锁定和重复项不覆盖、搜索列表不变；磁盘只写AEAD密文，缺钥/损坏/缺文件保留原件，互斥、权限、symlink/hardlink/FIFO拒绝，失败提交保持旧版，不确定提交使当前owner停止；账号更新先持久化，退出后迟到writer不能复活；好友/群接管取消未发、保留在途，幂等payload冲突拒绝，重启未知不重发且全部scope暂停。cfg(test)中模拟提交失败，不声称已做断电验证。

五轴：behavior=新增内部持久层，运行consumer未切换；data=只新建合成隔离数据，无真实迁移/删除；security=应用钥匙串ACL、私有原子密文、generation及发送门禁；contract=原HTTP/插件入口未改，未来窄stdio接线仍需验证；irreversible=无。新增C shim直接使用系统Security/CoreFoundation，只引用锁内已有anyhow/cc/OpenSSL，没有新registry版本。文件钥匙串与数据保护钥匙串的区别、分发签名/升级授权、恢复交互和实际C编译器/SDK溯源保留为正式制品要求。

日志及可信RED摘录：`meow-talk/output/wechat-delegation-security-rewrite/vault/{tests.log,tdd-evidence.md}`。当前Cargo全workspace验证通过11项持久层主测试（另有1项ignored子测试由父测试实际拉起）、2项IPC、1项实际stdio进程、96项协议、6项compile-fail；rustfmt和26文件上游补丁逐字节重建通过，官方key核验仍false。没有新增产品界面/用户能力，因此内部dogfood以真实Keychain/文件/子进程合成旅程验证，不能替代未走通的产品验收。仓库根无新增媒体工件。

### 继承的Tokio撤回项已定向处置

原锁1.54.0撤回原因已回读维护者安全公告及修复源码，不再作为‘原因待核’。已精确固定1.54.1，仅改变该包版本/摘要；实际下载摘要与官方registry一致，完整Cargo检查和offline/locked构建通过。source-audit的范围、适用性未知及原始来源见`packages/wechat-delegation/native/DEPENDENCY-NOTES.md`，不能把版本更新说成已经复现/排除所有内存缺陷或整个账号安全已通过。小多子的000391仍是2a967c3持久层内部审查；新依赖delta须一并交准确最终HEAD核验。当前安装未替换。

### 内审与公钥证据的最新回流

已完整消费小多子`0001794852719314-000397-cbc66a85`的typed approval，准确批准`b3028a984e6155bed3f4797dbe47ab3d4058cc61`内部持久层及Tokio更新，no open items；没有把批准扩大到整张产品PR、未实现的执行器或真实主号验收。其独立执行文件/状态机及IPC/进程检查；受限环境的真实Keychain行为核作者原始日志，范围见原verdict。

宪宪虽触发额度限制，第二版取证已落共享目录。砚砚读回并独立复跑MMTLS记录提取、核应用签名/资源封印：MMTLS5/1000两把公钥值与腾讯mac4.2.0制品一致；六把业务层key仍未确认。精确层级与本轮未重跑的反汇编/全包阴性扫描边界见`native/KEY-PROVENANCE.md`，旧“八把全未确认”不再是当前完整描述；整个`officialKeyOriginVerified`仍false。

本次仅回流已审实现状态和只读证据，代码/锁/构建输入与`b3028a9`一致；不为机械登记重新召回reviewer。下一项仍由砚砚实施真正登录/目录/sync/发送执行器与Node窄stdio接线；当前main进程只hello/status且not_ready，不能关闭Task或发布。工位沿原`feat/wechat-delegation`保留续做。

### 当前续做：账号登录已接到stdio，完整产品仍未完成

原工位、原Task续做。本轮加入Store内的持久login意图/回执和ticket fence，AccountService及真实NativeLoginPeer，窄RPC和显式私有目录启动；无参仍离线检查，整体accountServiceReady=false。接口详见`native/IPC.md`。没有改当前安装包、读取默认钥匙串条目、真实扫码或微信请求，所有自动化旅程仅用合成数据；真实OS钥匙串回归用自有临时私有库，不能混称为主号实测。

真实的Store→AccountService→RPC→stdio组合检查先复现缺失接线，再看到串行长轮询会阻塞取消的超时，已改为最多两个网络工作线程，取消/查询/断开保留在入口线程。取消或EOF后，迟到的认证状态不能写入账号；原意图重启保留为Interrupted，终态id不会自动生成新QR或重放认证。AccountState/一次性批准材料不Serialize成宿主DTO，完整输入字段、重复键和秘密导入负向检查通过；认证可能已在途时保留authenticationMayHaveOccurred，不把取消冒充远端设备信任撤销。

协议client.rs新增LoginGuard及三个guarded调用，提交checkpoint和redirect后的下一请求都检查取消/期限；已观察取消检查初始未实现的RED再修绿。物理裁剪范围不扩大，已同步protocol.patch及UPSTREAM摘要并从固定上游逐字节重建26文件。Cargo只增加锁内base64直接引用及serde_json raw_value特性，没有新registry版本。

Architecture cell不变；Map delta为同一Store内login记录和同一native服务的AccountService/stdio执行，不新增第二套账号writer。LoginPeer仅封装协议调用及易失挑战，替身仅测试构造；控制锁不跨网络，持久ticket与易失guard分别防迟到提交/重启复活及后续出站，不是相互兜底。五轴：behavior=开发中登录与IPC；data=加密状态的加法字段/合成数据，无真实迁移删除；security=秘密投影/取消及进程边界；contract=新stdio子集，Node consumer未切换；irreversible=无。

原始完整旅程仍没走通，断点在新Node consumer、当前好友/群目录、sync及实际文字发送执行器；正式制品签名/升级授权、LAN显式验证、业务层key来源及本人授权的真实验收仍待。此为实现内审，不能作为分批发布或Task关闭。内部dogfood由真实文件/钥匙串/协议checkpoint/字节流组合与受影响检查支撑；网络登录成功旅程使用替身，不能冒充真实账号验证。

登录/stdio实现`174b96c488faa240b437476d2844caa5b15c85e9`已获小多子`0001794854775528-000405-5440e437`的typed approved、no open items，范围仅该内部实现。随后继续了Node字节transport，使用真实Node子进程验证乱序、超时/取消后的未知状态、错误/超长响应拒绝；也连接实际Rust无参进程验证PID与离线拒绝。另复现exit先于stdout读尽导致最终回执丢失的RED，改为exit拒新请求、stdout读尽/close收尾后修绿。全包73项Node检查通过。transport还未被Supervisor/NativeClient接入，不能把字节层实物称完整Host替换；新Node代码需独立review，旧174b96c批准不覆盖它。

### 首轮已落地：启动端凭据目录和环境边界

`NativeSupervisor` 在启动任何组件前，以 `O_DIRECTORY | O_NOFOLLOW` 打开实例根、凭据目录和配置目录，检查当前 UID 并通过该文件句柄设置0700；拒绝末级符号链接，避免 chmod 修改链接目标。配置根和凭据目录不能指向另一个目录。原账号资料不删除，缓存修复仍保留原资料。

子进程环境不再继承 `SSL_CERT_FILE` / `SSL_CERT_DIR`，原本不继承的 HTTP/HTTPS/ALL_PROXY 及小写形式保持不继承。此举不控制内核级 TUN；不能据此声称网络直连。当前 native 只支持 macOS ARM64，此次也不扩展支持平台。

可信 RED：生产 supervisor 配合实际合成子进程，报告继承了两项 SSL_CERT 覆盖；三个被 symlink 替换的目录均出现 Missing expected rejection。GREEN：同一生产入口拒绝上述三个目录，未创建子进程，原目标目录没有组件写入；子进程不见上述代理/证书变量。相关原生监督11项检查和全包68项检查通过，lint及 `git diff --check` 通过。全包包含生产成员回复→HTTP发送的组合回归和最终归档的空白离线consumer。

该切片不是新连接服务，不改变当前安装的制品，不作为重写或账号安全验收完成。正式独立审查仍需覆盖准确提交。

### 独立安全稿的采纳与证据修正

来源：小多子 `thread_mwg7kandcxztqeab#0001794847816729-000356-9cb2ff4a`。采纳其凭据投影、日志脱敏、无关路由/自动媒体移除、主机与服务端身份校验、环境继承、源码构建绑定和实际网络观察建议。

两处证据标准需限缩，不能照搬为安全证明：

- 二进制字符串或符号扫描只作辅助。release strip/LTO可能移除名字，文档/许可也可能含非腾讯域名；既不能由名字缺席证明无外联，也不能由一个域名字符串证明它是可达网络目的地。以实际依赖图、可达调用、真实入口负向测试和联网观察联合判断。
- `AccountState` 的内部状态导出方法确实存在，但不能由库方法存在推断某条HTTP密钥导出route已挂载；需要分别核对。库暴露面与服务可达面都要列明。

Rust/Cargo/标准库1.93.1现已安装在任务临时目录，官方组件摘要逐一核对，`rustc --version` 与 `cargo --version` 已验证。没有修改全局工具链或用户HOME。

### 已收到架构稿，进入协议与进程实现

宪宪原稿 `000355` 及补充 `000362` 已读回；采纳自有最小进程、stdio传输、物理裁出协议子集、钥匙串保管包装密钥的方向。三处修正已由她在 `000375` 接受：继续使用固定版本的成熟HTTP解析；钥匙串不可用时默认报错并保留原件，不能静默退化为易失登录；本机同步披露保留，LAN挑战默认不监听，须本人显式许可才可开放。

`native/proto/` 现在是可独立构建的协议子集，不引入旧core/api/store/profile/daemon、媒体/CDN、贴纸、通话、图片或压缩包解析模块。原密码学和wire格式保留；导出原始快照仅编入内部测试，扫码尝试不再可序列化。新的transport集中生产socket和HTTP构造，DNS过滤后固定到该请求，业务路径限制为已核对的15条文字/账号/目录操作。保留系统Fake-IP的适用性说明，并在握手验签及Finished验证后记录实际pin版本/区域。

`native/link/` 已有可编译、实际可运行的有界stdio入口；只开放hello/status，明确返回 `accountServiceReady=false`。重复键、未知字段/方法和非法帧使用固定错误，不回显内容；入口关闭stdin后退出。创建工作线程前清除环境、禁止core dump，macOS请求禁止调试附加。**尚无钥匙串、登录/发送执行器、发送日志、同步消费、通讯录服务或插件替换，整体使用旅程仍未走通；不向本人发布这个基础进程当安装候选。**

自证：协议库96项检查、6项compile-fail检查通过；stdio的2项局部检查及实际编译进程组合检查通过；`cargo fmt --all --check`通过。来源检查核26文件摘要，并在固定上游文件基础上实际应用 `protocol.patch`，逐文件重建当前源码一致；符号/字符串扫描仍只作辅助。日志在 `meow-talk/output/wechat-delegation-security-rewrite/protocol/`。

可信失败证据分别记录：原版6个不需要的接口/序列化能力探针均可编译；旧路径校验的负向检查因 `mmemojiupload` 被放行而失败；伪造ECDH+非内置私钥签名的服务端被真实握手在验签阶段拒绝，且ClientHello后零写出。隔离副本忽略验签失败时，同一检查因未在验签阶段终止而失败，不把超时说成发生了凭据泄漏。新增stdio检查属于实现后的组合验证，不伪报为旧版RED。裁剪时缺失原模块引用及工具格式化参数问题是开发环境/编译修正，未当产品RED。

重要未决：宪宪只读核官方mac应用包后，未能独立匹配上游8把公钥（`000375`；证据 `meow-talk/output/wechat-delegation-alpha10/key-provenance/结论.md`）。这不是非官方的证明；当前最多可声称‘对端通过内置公钥验签，公钥官方来源未确认’，不能声称‘只向微信官方发送凭据’。已路由她继续只读追应用层默认配置（`000378`），不读运行中内存或真实profile。新workspace首次无锁解析还发现本机registry将tokio1.54.0标为yanked；保持原锁可构建，最终制品前须核撤回原因与替换策略，不把当前依赖集合描述为已完成安全审计。

Architecture cell：微信插件自有连接服务及其协议子集。Map delta：已新增 native Rust workspace、proto库与有界stdio进程入口；尚未切换任何运行consumer。Why：把登录秘密的可达代码面与网络出口从通用第三方daemon收回到可审查的专用实现。此处是内部实现与审查记录，不是分批验收、Feature close或发布许可；整体Task继续开放。

### 发送执行续做：最终提交与接管共用同一Store

Node transport b6a61ec已获小多子000409 typed approved，no open items，仅对应内部传输层。本轮继续AccountService内文字执行，NativeTextPeer调用同一账号owner的request_blocking与send_text_guarded，不另建账号writer。会话显式授权及每次新发送均新鲜核好友全mask/群成员身份；未验证身份不进入文字提交。conversation.pause与最终before-submit均持control锁后单向进Store，接管先落盘；网络期间不持control锁。授权也记录进程内epoch，核验途中接管/退出后，迟到授权不能复活。

已观察4项RED：未实现服务拒绝授权/发送、核验gate未进入、RPC没有conversation.authorize接线；最小实现后修绿。另补实际字节stdio发送等待期间pause先回执、好友稀疏mask/群正向证明、回执关联错配与负向拒绝、重复在途请求、重启后查原回执等组合验证。网络文字与身份服务端用测试替身，生产适配调用真实协议；未冒称真实账号发送或协议服务器故障注入。完整Cargo通过30项link主检查（另有父测实际拉起的restart子进程）、2项编译进程、97项协议、6项compile-fail；Node73项通过，26文件来源重建与fmt/locked build通过。证据login/text-{tests.log,node-tests.log,tdd-evidence.md}。

Architecture cell仍为原自有连接服务；Map delta为同一AccountService新增文字执行和窄授权/暂停/发送/查询/取消RPC，持久outbox仅补提交前终止及明确拒绝结果，不建第二队列。五轴：behavior=新文字发送入口/接管，data=原加密outbox与合成旅程，无迁移删除，security=新鲜身份/双generation/最终提交，contract=封闭stdio扩5方法及permission_denied，irreversible=无。

accountServiceReady仍false：当前目录枚举、入站sync/消息及canonical回显、新NativeClient/Supervisor/Host完整替换仍缺。正式签名升级、LAN路径、业务key来源和本人授权真实验收沿原范围继续。没有修改安装版、真实profile或默认Keychain条目，也未发布/merge或关闭Task。

### 入站同步与状态诚实续做

文字执行5ee58a3已获小多子000413准确HEAD typed approved，no open items。本轮继续同一账号/Store的sync：inbox按账号代次加密保留命令、游标、投影和有序事件，游标与数据同一次commit；迟到ticket、旧账号及失败提交不发布数据。未知/冲突命令保留私有原件并计数，不当完整解析成功；消息id去重，群senderId保持未知、非文字body为null、不触发下载。空白无变化poll不改写Vault，避免每次查询重写整个快照。

实际观察RED：初始Store ticket未实现的2项失败、sync RPC未接线checkpoint为空、会话被明确拒绝后仍authenticated=true、空白poll错误推进checkpoint；均在相同检查修绿。补充真实rename失败的文件旅程验证游标/消息不发布、101+条事件分页、群/发出/外部账号及冲突保留、并发sync忙与断开迟到拒绝。38项link主检查（含新建隔离私有Keychain及父测跨进程restart）、2项编译进程、97项协议、6项compile-fail；Node73、fmt/locked构建/26来源重建检查证据见login/sync-*。网络远端替身及真实无参进程边界保持诚实。

会话拒绝问题按同一根因覆盖sync、好友/群核验、会话授权及文字发送：停止client、持久暂停grants、保留凭据，已在途的回执继续needs_review，不重发；一般网络超时不冒充明确失效。新schema字段默认空，原合成快照兼容、无生产迁移。Architecture cell仍是自有连接服务，Map delta为同一Store的inboxes和同一AccountService的sync执行，未新增账号writer/守护进程；五轴为入站行为、加法私有数据、账号/游标fence及秘密投影、stdio扩三方法，无不可逆操作。

完整旅程仍未完成：当前目录枚举、显式已保存会话恢复、Node NativeClient/Supervisor/Host组合及最终制品仍缺。accountServiceReady仍false，未替换运行版本、真实登录或发送、merge/发布或关闭Task。原正式签名升级/LAN/业务key来源/本人授权真实验收要求不变。
