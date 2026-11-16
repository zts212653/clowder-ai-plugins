# 微信文字协议子集（实施中）

这是账号安全重写的协议基础，尚未接入用户正在运行的插件。已有可运行的有界stdio入口，只开放hello/status，明确返回账号服务未就绪；钥匙串保险库、持久发送日志、同步消费和插件替换仍待实现与验收，不能将这个基础进程当成完成的账号连接服务。

来源与授权：本人 `thread_mwg7kandcxztqeab#0001794847733075-000352-bf448701`；架构来源为宪宪 `000355` / `000362`，独立威胁稿为小多子 `000356`。完整产品与安全终态要求见 `docs/plans/2026-11-17-wechat-native-security-rewrite.md`。

## 代码来源与当前边界

`proto/` 是从 MIT 上游 `thisnick/agent-wechat@ed976d78c1e1cc2a49ad17d1e2c0da023bbb5c8e` 物理裁出的代码。逐文件原始与派生 SHA-256、排除文件/模块在 `UPSTREAM.json`；完整修改在 `protocol.patch`。保留原许可及固定公钥数据；程序验证公钥匹配不等于这些公钥的微信官方来源已经获得独立证明，该项仍由宪宪取证。

未编入原 daemon、HTTP API、账号 profile、存储、音视频、媒体/CDN、贴纸、图片/压缩包解析、官方桌面微信导入。保留扫码、会话、同步、纯文字和好友/群目录协议及其相关回归。密钥算法与消息格式沿用上游；不能把移植称为完整密码学审计。

新的 `transport.rs` 集中生产建连和 HTTP 客户端构造。HTTP 仍使用原锁定的成熟 reqwest 解析，移除 TLS 栈，仅允许固定 MMTLS POST、禁跳转、禁代理继承；不手写 HTTP 响应解析。DNS 结果先过滤本机/私网/元数据地址，再固定给本次连接，防止第二次解析绕过。网络请求还须经过15条文字/账号/目录业务路径白名单。没有通用 URL 接口。

当前保留系统 Fake-IP 路由，并在观察记录中如实标注；不能据此声称实际出口直连腾讯。长链记录 socket 实际读写字节；短链仅记录准备的加密请求体、读到的响应体，不把它们冒称内核流量或服务端实收。握手签名及Finished均验证后才记录实际选中的pin版本和区域，这仍不证明pin的官方来源。DNS 解析本身仍由系统阻塞 resolver 提供，不声称整个解析过程有严格截止保证。

扫码尝试类型不再实现 Serialize/Deserialize；快照导出只在内部测试编译。不用的官方 profile 数据库密码与原始认证快照在认证归约后清零丢弃。最终保险库仍必须保护剩余的实际会话秘密。

当前不会自动处理服务端要求的 LAN 登录挑战：明确返回 `LanApprovalRequired`，不打开监听器。该情形的显式授权及实际兼容路径仍待完成，不能把常规 QR 单元检查当成所有账号都可登录的证明。

## 可复跑检查

工具链为 Rust/Cargo 1.93.1；在仓库根目录运行：

```sh
cargo test --locked --manifest-path packages/wechat-delegation/native/Cargo.toml
cargo fmt --all --check --manifest-path packages/wechat-delegation/native/Cargo.toml
node packages/wechat-delegation/native/scripts/verify-source.mjs
# 有固定上游源码时，另核完整来源与补丁重建：
node packages/wechat-delegation/native/scripts/verify-source.mjs /path/to/agent-wechat/packages/native-client-rust/crates/wechat-protocol
```

依赖缓存齐备时可加 `--offline`。复用原 Cargo.lock 中已有版本；首次无锁解析曾因本机 registry 将 tokio 1.54.0 标为 yanked 而拒绝解析，复制并保留原锁后可构建。此事不证明恶意；最终制品前仍需核查撤回原因和替换策略，不能将当前依赖集合声称为已完成安全验收。

可信 RED：原版接口探针可以编译头像/CDN API；原版通用路径校验仍放行 `mmemojiupload`，新负向检查明确失败。当前派生库以编译失败文档检查拒绝媒体、通话、原始快照出口及扫码尝试序列化。

伪服务端测试运行真正的握手实现：成功进行 ECDH 并发送有效加密记录，但使用非内置私钥签名，客户端必须在 `MMTLS signature verification` 终止；除无凭据 ClientHello 外不发送字节。隔离副本忽略验签失败时，同一测试因没有在验签阶段终止而失败；这验证了检查的检测力，不表示观察过真实账号泄漏。

原始检查输出在共享工作区 `meow-talk/output/wechat-delegation-security-rewrite/protocol/`。尚无此新协议组件的完整独立审查结论、正式 native 制品、实际安装或真实微信验收。

stdio入口的2项局部检查及实际编译进程的组合检查已通过：未知方法/字段、重复键、超长或截断帧不回显输入内容；正常关闭stdin后进程退出，无任何账号授权或网络活动。这些是实现后的组合验证，不虚报为在旧组件上观察到的RED。进程在创建工作线程前清除环境、禁止core dump，并在macOS请求拒绝调试附加；完整分发签名及钥匙串ACL的效果仍需独立验证。

本目录是内部实施材料，尚无新增用户操作入口或可发布能力；capability tips不适用。完整产品旅程目前没走通，Task不关闭，不向本人提供此进程作为安装候选。
