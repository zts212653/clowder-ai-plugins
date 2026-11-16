# 内部stdio契约（未作为完整插件候选发布）

协议1，每帧为UTF-8 JSON加换行，输入上限1MiB；响应按id关联，允许乱序。网络操作最多两个工作线程，超额返回`operation_busy`，没有无界任务队列。取消、查询和本地断开由读入口处理，不等网络线程。

## 启动

```sh
clowder-wechat-link
clowder-wechat-link --data-dir /absolute/private/vault
clowder-wechat-link --data-dir /absolute/private/vault --initialize
```

无参为离线检查模式，不打开默认钥匙串，不启动账号网络功能。目录模式仅支持当前macOS构建；root/setuid拒绝。目录须由宿主预先创建为当前UID的0700目录；Vault持FD校验子文件、互斥和身份后才向KeyStore求钥匙。密钥不在argv、环境或IPC出现。

`--initialize`是明确的新库初始化，已经有身份或密文时拒绝，不能把它当修复/覆盖参数。钥匙串失败和中断的原件保留；本轮尚未交付其恢复UI，不可删除标记静默重试。没有旧profile导入/迁移或自动开新数据目录的fallback。

成功加载账号目录后，hello增加`account-login-v1`能力；完整`accountServiceReady`仍为false，缺目录/sync/发送执行器及Node consumer。已保存凭据重开后仅为`stored`，不谎报已和服务器验证在线；新二维码成功完成协议认证才报告online。尚未添加自动重连/凭据重认证策略。

## 请求与响应

```json
{"id":1,"method":"login.start","params":{"operationId":"owner-generated-unique-id"}}
```

id是1到JavaScript最大安全整数；operationId为1–128个ASCII字母、数字或`-_.:`。每种params拒绝未知字段和重复键，信封也拒绝重复键。只有下列方法：

| 方法 | params | 结果 |
| --- | --- | --- |
| hello | 空对象或省略/null | 固定产品、协议、能力和本进程PID；没有内部状态 |
| status | 空对象或省略/null | serverId、accountGeneration、accountIdentity、credentialsAvailable、authenticated、connection、受限egress观测；没有AccountState |
| login.start | operationId | 新意图先持久化，再获取一个二维码；重复id只查原意图，终态不会重试 |
| login.poll | operationId | 查询一个已创建挑战；同一意图不并发轮询。批准后认证交换一次，提交账号和成功回执 |
| login.operation | operationId | 读取持久回执；仅当前待扫/待批准挑战附加易失QR投影 |
| login.cancel | operationId | 持久取消；清除当前QR与取消guard；网络已在途时不声称可以追回授权 |
| account.disconnect | 空对象或省略/null | 停止本地账号、清除已接受凭据并持久取消活动登录/未发意图；不承诺撤销远端设备信任 |

登录结果投影：`operation {id,generation,accountGeneration,phase,accountIdentity,startedAtMs,updatedAtMs,authenticationMayHaveOccurred}`，可有`qr {pngBase64,expiresAt}`。二维码只给授权面板，不进模型消息或通用诊断；图片最多512KiB。phase为starting/pending/scanned/completing/succeeded/cancelled/interrupted/failed/expired/rejected/lan_required。完成认证前已取消或中断不能变成succeeded。

`authenticationMayHaveOccurred`在开始认证阶段落盘，表示请求可能已经到达服务端，不是实测字节计数。认证不确定、取消和重启不会清除这项；手机上是否留下了设备授权需要真实验证，不能由本地退出承诺远端撤销。

凭据和成功回执在同一事务提交；存储失败不发布账号，不回退明文/易失登录。二维码创建、认证交换、已结束意图不自动重放；只有QR轮询中协议明确分类的暂时故障可以继续查询。不同operationId是本人明确发起的新意图，不用于组件内部悄悄重试。

固定错误码：invalid_request、invalid_params、unsupported_method、not_ready、operation_busy、invalid_operation、private_state_unavailable、account_service_unavailable、observation_unavailable、invalid_frame及internal_error。不会回显传入URL、字段、密钥、JSON解析异常或底层网络诊断。profile/account导入、秘密导出、通用URL、任意路径和shell方法均不存在。

Node侧还未接线；上述是受控开发入口，不是对最终用户新增配置命令。真实账号、正式签名与升级、LAN显式路径和完整好友/群代聊接管验收仍保持开放。
