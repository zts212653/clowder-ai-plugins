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

成功加载账号目录后，hello增加`account-login-v1`能力；完整`accountServiceReady`仍为false，缺当前目录枚举、显式恢复与完整Node consumer。已保存凭据重开后仅为`stored`，不谎报已和服务器验证在线；新二维码成功完成协议认证才报告online。尚未添加自动重连/凭据重认证策略。

## 请求与响应

```json
{"id":1,"method":"login.start","params":{"operationId":"owner-generated-unique-id"}}
```

id是1到JavaScript最大安全整数；operationId为1–128个ASCII字母、数字或`-_.:`。每种params拒绝未知字段和重复键，信封也拒绝重复键。方法集合封闭；当前包括：

| 方法 | params | 结果 |
| --- | --- | --- |
| hello | 空对象或省略/null | 固定产品、协议、能力和本进程PID；没有内部状态 |
| status | 空对象或省略/null | serverId、accountGeneration、accountIdentity、credentialsAvailable、authenticated、connection、受限egress观测；没有AccountState |
| login.start | operationId | 新意图先持久化，再获取一个二维码；重复id只查原意图，终态不会重试 |
| login.poll | operationId | 查询一个已创建挑战；同一意图不并发轮询。批准后认证交换一次，提交账号和成功回执 |
| login.operation | operationId | 读取持久回执；仅当前待扫/待批准挑战附加易失QR投影 |
| login.cancel | operationId | 持久取消；清除当前QR与取消guard；网络已在途时不声称可以追回授权 |
| conversation.authorize | accountGeneration、accountIdentity、destination | 新鲜核当前好友/群身份后，返回账号/会话双generation的租约；不会使用缓存证明关系 |
| conversation.pause | accountGeneration，可省略destination表示全部 | 先持久暂停及取消未提交消息，拒绝并发迟到授权；保留Submitting |
| text.send | lease、operationId、text | 同一Store先记意图；在协议最终before-submit持久化Submitting；只回受限SendReceipt |
| send.receipt | operationId | 查询原发送回执，不触发网络发送 |
| send.cancel | operationId | 仅Queued可改为Cancelled；Submitting和终态保持原状 |
| sync.pull | accountGeneration、accountIdentity | 拉一页真实协议同步，在同一个私有事务保留命令、消息、事件和游标，只回受限进度 |
| events.page | accountGeneration、after（规范十进制字符串） | 每页最多100个事件，只含消息id/会话id/时间，不含协议payload |
| message.get | accountGeneration、messageId | 当前账号代次的消息投影；正文只投影最多64KiB的UTF-8文字 |
| account.disconnect | 空对象或省略/null | 停止本地账号、清除已接受凭据并持久取消活动登录/未发意图；不承诺撤销远端设备信任 |

登录结果投影：`operation {id,generation,accountGeneration,phase,accountIdentity,startedAtMs,updatedAtMs,authenticationMayHaveOccurred}`，可有`qr {pngBase64,expiresAt}`。二维码只给授权面板，不进模型消息或通用诊断；图片最多512KiB。phase为starting/pending/scanned/completing/succeeded/cancelled/interrupted/failed/expired/rejected/lan_required。完成认证前已取消或中断不能变成succeeded。

`authenticationMayHaveOccurred`在开始认证阶段落盘，表示请求可能已经到达服务端，不是实测字节计数。认证不确定、取消和重启不会清除这项；手机上是否留下了设备授权需要真实验证，不能由本地退出承诺远端撤销。

凭据和成功回执在同一事务提交；存储失败不发布账号，不回退明文/易失登录。二维码创建、认证交换、已结束意图不自动重放；只有QR轮询中协议明确分类的暂时故障可以继续查询。不同operationId是本人明确发起的新意图，不用于组件内部悄悄重试。

固定错误码：invalid_request、invalid_params、unsupported_method、not_ready、operation_busy、invalid_operation、private_state_unavailable、account_service_unavailable、observation_unavailable、invalid_frame、internal_error及permission_denied。不会回显传入URL、字段、密钥、JSON解析异常或底层网络诊断。profile/account导入、秘密导出、通用URL、任意路径和shell方法均不存在。

文字发送回执包含id、destination、accountGeneration、conversationGeneration、state、createdAt、clientMessageId、serverId。成功须目的地/客户端id匹配、业务双code成功及非零u64 serverId；仅匹配的显式拒绝为failed，其余已提交错误为needs_review。accepted只证明协议受理，不是收件人已读或同步回显核验。未知/终态不会再次发送，同id不同正文或租约拒绝。好友须新回复的全mask好友位且非官方/系统对象；群须当前成员字段或精确群的正向本人roster证明，字段稀疏不复用旧状态。

Node侧还未接线；上述是受控开发入口，不是对最终用户新增配置命令。真实账号、正式签名与升级、LAN显式路径和完整好友/群代聊接管验收仍保持开放。

## Node字节传输层

`src/native-stdio.mjs`已有私有管道transport，尚未替换NativeSupervisor/原HTTP NativeClient。它只允许上表方法，信封按安全整数id关联，允许乱序，最多16个待回请求；输入/输出每帧上限1MiB，UTF-8严格解码。后端错误只接受固定code白名单，JSON异常、未知字段/诊断和stderr不转发。协议故障/关闭会拒绝待回请求并终止传入的自有子进程，不查询外部PID或回退另一后端。

未写出前取消为`request_cancelled`；已写出的请求超时/取消为`request_unknown`且mayHaveCommitted=true，之后的晚回包不会占据另一id。超时不自动重发、不谎报远端取消；宿主应沿同一operationId核回执。明确的副作用前拒绝码不冒充已提交。二进制身份、运行代次及账号DTO校验由后续Supervisor/NativeClient消费端承担，裸字节transport不是独立身份认证或完整Node接线。

子进程exit后立即拒绝新请求，但保留待读响应直到stdout读尽或close，避免丢失退出前已经写出的最终回执。真实Node子进程检查覆盖这一退出顺序、乱序、超时晚回包、关闭、超长/坏JSON及含秘密诊断拒绝；另已让该transport连接真正编译的Rust无参进程核PID、hello/status及离线登录拒绝。该组合没有默认钥匙串条目/账号访问，也不是真实扫码或Host安装验收。

同步使用账号generation和私有checkpoint ticket拒绝迟到/重复提交；网络不持control锁，同一账号最多一个sync.pull在途，stdio总网络线程仍最多两个。未知或不能投影的命令保留在同一个加密Vault且计数披露，不进RPC；不因新游标删除它们。相同命令去重，无变化轮询不改写Vault。消息id绑定账号代次和服务端id（缺id时用命令摘要）；同id冲突保留原投影及原始新命令，增加未投影计数，不覆盖已保存正文。

群消息的senderId保持null，尚未推导发言人；正文保留协议原文字，不捏造昵称或成员身份。非文字/过大/不能解码的正文为null；原命令仍加密保留。消息不会触发任何媒体、链接或预览下载。这里只完成本机持久消息入口，完整模型消费及真实群收发验收仍待。

对协议明确分类的会话拒绝，停止当前client并持久暂停全部grants；凭据保留、authenticated=false，不自动续期/扫码，也不将一般网络故障直接当凭据失效。显式重新验证保存会话尚待实现。
