# 内部stdio契约（未作为完整插件候选发布）

协议1，每帧为UTF-8 JSON加换行，输入上限1MiB；响应按id关联，允许乱序。网络操作最多两个工作线程，超额返回`operation_busy`，没有无界任务队列。取消、查询和本地断开由读入口处理，不等网络线程。

读入口在派发网络线程前取得不出IPC的Admission（同一Store句柄、账号代次、本进程控制epoch）；创建登录、恢复认证与新授权必须在自己的control临界区校验该票据后才建意图/开始核验。这样旧请求即使尚未获得CPU，也不能在后到的接管/取消/断开后偷偷取得新epoch。取消查不到原意图仍推进本机准入隔离，但继续返回unknown/invalid_operation，不伪造认证已发生或成功取消的回执。原意图查询和终态幂等读取不产生新网络。

## 启动

```sh
clowder-wechat-link
clowder-wechat-link --data-dir /absolute/private/vault
clowder-wechat-link --data-dir /absolute/private/vault --initialize
```

无参为离线检查模式，不打开默认钥匙串，不启动账号网络功能。目录模式仅支持当前macOS构建；root/setuid拒绝。目录须由宿主预先创建为当前UID的0700目录；Vault持FD校验子文件、互斥和身份后才向KeyStore求钥匙。密钥不在argv、环境或IPC出现。

`--initialize`是明确的新库初始化，已经有身份或密文时拒绝，不能把它当修复/覆盖参数。钥匙串失败和中断的原件保留，恢复必须走下面的显式入口，不可删除标记静默重试。没有旧profile导入/迁移或自动开新数据目录的fallback。

显式owner面板还可启动两个独立的一次性进程形态，均不启动账号服务、不认证微信：`--data-dir <现有目录> --reauthorize`仅在本次读取前后开启/关闭系统交互，以系统原生对话框解锁或重新允许已有条目，然后验证现有密文；`--recover-initialization`仅完成有充分持久证据的首次初始化。密码不进入Host/模型/argv。进程只输出产品、版本、PID、repair种类及固定state，120秒或父进程退出即自行退出；Host另有相同超时和精确子进程清理。真实系统对话框行为尚需本人在场核验。

新建库的`init.phase`与vault.id绑定，从pending原子更新到publishing并完成持久同步后才可能首次发布密文。恢复时必须持有原锁并校验原身份：仅pending且从未发布，或publishing且现有密文能解密为精确空内容时继续；拒读密钥不当作缺钥，已有密钥不替换。publishing后密文缺失、阶段证据缺失/错误、已有非空状态均不能按空库重建。原有完整库不要求新阶段文件即可正常打开；旧的半初始化库缺乏证据时仍保留，不猜测。此恢复不删除原件、不换库身份，也不恢复旧代聊。

Host先持久操作id和边界、暂停全部代聊，再调用一次性进程；结果及原记录保留，无TTL。刷新/重启不自动再弹窗，执行中取消只停止自有进程；已经被系统接受的钥匙串许可不声称被撤销。成功后仍须本人另点准备组件，使用新进程核验非交互访问，再明确恢复微信账号；当前进程的二次读取不能证明跨进程“始终允许”已持久化。

成功加载账号目录后，hello的`nativeApiAvailable=true`并增加登录、文字、同步、目录和显式恢复能力；无参为false。完整`accountServiceReady`仍为false，完整Host consumer和产品验收尚缺。已保存凭据重开后仅为`stored`，不谎报已和服务器验证在线；明确扫码或显式恢复成功才报告online，没有自动重连/认证。

## 请求与响应

```json
{"id":1,"method":"login.start","params":{"operationId":"owner-generated-unique-id"}}
```

id是1到JavaScript最大安全整数；operationId为1–128个ASCII字母、数字或`-_.:`。每种params拒绝未知字段和重复键，信封也拒绝重复键。方法集合封闭；当前包括：

| 方法 | params | 结果 |
| --- | --- | --- |
| hello | 空对象或省略/null | 固定产品、协议、能力和本进程PID；没有内部状态 |
| status | 空对象或省略/null | serverId、accountGeneration、accountIdentity、credentialsAvailable、authenticated、connection、stream、受限egress观测；没有AccountState |
| login.start | operationId | 新意图先持久化，再获取一个二维码；重复id只查原意图，终态不会重试 |
| login.poll | operationId | 查询一个已创建挑战；同一意图不并发轮询。批准后认证交换一次，提交账号和成功回执 |
| login.operation | operationId | 读取持久回执；仅当前待扫/待批准挑战附加易失QR投影 |
| login.cancel | operationId | 持久取消；清除当前QR与取消guard；网络已在途时不声称可以追回授权 |
| conversation.authorize | accountGeneration、accountIdentity、destination、syncEpoch，可省略/null的expiresAtMs | 当前stream已同步完成且epoch吻合才可新鲜核当前好友/群身份；同一事务返回lease及stream基线；最终提交点再次检查期限 |
| conversation.pause | accountGeneration，可省略destination表示全部 | 先持久暂停及取消未提交消息，拒绝并发迟到授权；保留Submitting |
| text.send | lease、operationId、text | 同一Store先记意图；在协议最终before-submit持久化Submitting；只回受限SendReceipt |
| send.receipt | operationId | 查询原发送回执，不触发网络发送 |
| send.cancel | operationId | 仅Queued可改为Cancelled；Submitting和终态保持原状 |
| sync.pull | accountGeneration、accountIdentity | 拉一页真实协议同步，在同一个私有事务保留命令、消息、事件和游标，只回受限进度 |
| events.page | accountGeneration、after（规范十进制字符串）、syncEpoch | 在同一Store锁内核对reset epoch；每页最多100个事件，只含消息id/会话id/时间，不含协议payload |
| message.get | accountGeneration、messageId、syncEpoch | 在同一Store锁内核对reset epoch；正文只投影最多64KiB的UTF-8文字 |
| message.by_server | accountGeneration、serverId（规范非零u64十进制字符串） | 精确服务端id查当前账号消息流；不按正文猜测；仅供发送结果核对 |
| account.disconnect | 空对象或省略/null | 停止本地账号、清除已接受凭据并持久取消活动登录/未发意图；不承诺撤销远端设备信任 |

登录结果投影：`operation {id,generation,accountGeneration,phase,accountIdentity,startedAtMs,updatedAtMs,authenticationMayHaveOccurred}`，可有`qr {pngBase64,expiresAt}`。二维码只给授权面板，不进模型消息或通用诊断；图片最多512KiB。phase为starting/pending/scanned/completing/succeeded/cancelled/interrupted/failed/expired/rejected/lan_required。完成认证前已取消或中断不能变成succeeded。

`authenticationMayHaveOccurred`在开始认证阶段落盘，表示请求可能已经到达服务端，不是实测字节计数。认证不确定、取消和重启不会清除这项；手机上是否留下了设备授权需要真实验证，不能由本地退出承诺远端撤销。

凭据和成功回执在同一事务提交；存储失败不发布账号，不回退明文/易失登录。二维码创建、认证交换、已结束意图不自动重放；只有QR轮询中协议明确分类的暂时故障可以继续查询。不同operationId是本人明确发起的新意图，不用于组件内部悄悄重试。

固定错误码：invalid_request、invalid_params、unsupported_method、not_ready、operation_busy、invalid_operation、private_state_unavailable、account_service_unavailable、observation_unavailable、invalid_frame、internal_error及permission_denied。不会回显传入URL、字段、密钥、JSON解析异常或底层网络诊断。profile/account导入、秘密导出、通用URL、任意路径和shell方法均不存在。

文字发送回执包含id、destination、accountGeneration、conversationGeneration、state、createdAt、clientMessageId、serverId。成功须目的地/客户端id匹配、业务双code成功及非零u64 serverId；仅匹配的显式拒绝为failed，其余已提交错误为needs_review。accepted只证明协议受理，不是收件人已读或同步回显核验。未知/终态不会再次发送，同id不同正文或租约拒绝。好友须新回复的全mask好友位且非官方/系统对象；群须当前成员字段或精确群的正向本人roster证明，字段稀疏不复用旧状态。

Node侧已接入私有流、Supervisor、目录、认证编排及消息流基线。Host认证日志只保留意图与受限状态，提交前持久化原operationId；未知时只查询原意图，不自动认证或换nonce。恢复保存会话必须由本人明确触发；取消携带原operationId，迟到取消不能伤及新意图。二维码只在内存中留给原面板。旧HTTP认证记录保留并标为无法由新组件验证，不重放旧操作。上述仍是开发入口，不是最终用户配置命令；完整修复UI、真实账号、正式签名与升级、LAN显式路径和完整好友/群代聊接管验收仍保持开放。

## Node字节传输层

`src/native-stdio.mjs`提供私有管道transport，新的NativeSupervisor已消费它和NativeLinkClient。它只允许上表方法，信封按安全整数id关联，允许乱序，最多16个待回请求；输入/输出每帧上限1MiB，UTF-8严格解码。后端错误只接受固定code白名单，JSON异常、未知字段/诊断和stderr不转发。协议故障/关闭会拒绝待回请求并终止传入的自有子进程，不查询外部PID或回退另一后端。

未写出前取消为`request_cancelled`；已写出的请求超时/取消为`request_unknown`且mayHaveCommitted=true，之后的晚回包不会占据另一id。超时不自动重发、不谎报远端取消；宿主应沿同一operationId核回执。明确的副作用前拒绝码不冒充已提交。二进制身份、运行代次及账号DTO校验由后续Supervisor/NativeClient消费端承担，裸字节transport不是独立身份认证或完整Node接线。

子进程exit后立即拒绝新请求，但保留待读响应直到stdout读尽或close，避免丢失退出前已经写出的最终回执。真实Node子进程检查覆盖这一退出顺序、乱序、超时晚回包、关闭、超长/坏JSON及含秘密诊断拒绝；另已让该transport连接真正编译的Rust无参进程核PID、hello/status及离线登录拒绝。该组合没有默认钥匙串条目/账号访问，也不是真实扫码或Host安装验收。

`src/link-client.mjs`是上述私有管道的窄类型消费端，逐层拒绝未知字段，核当前PID/精确版本/9项能力，账号、租约与发送回执身份须匹配。每个adapter只绑定一个owned child，运行instance id每次新建；持久Store.serverId单独保存，不冒充新进程身份。提交直接使用run中的lease，写前没有await；未知/无效回包不重发，已明确副作用前拒绝与写后未知区分。认证/目录/同步/消息DTO及QR仅按封闭结构返回，不导出AccountState。accepted只有精确服务端id、账号、目的地、方向及全文都匹配的同步记录才可升为verified；没有serverId的未知发送不按正文搜索。实际插件旅程尚待，不能视为完整产品就绪。

同步使用账号generation和私有checkpoint ticket拒绝迟到/重复提交；网络不持control锁，同一账号最多一个sync.pull在途，stdio总网络线程仍最多两个。未知或不能投影的命令保留在同一个加密Vault且计数披露，不进RPC；不因新游标删除它们。相同命令去重，无变化轮询不改写Vault。消息id绑定账号代次和服务端id（缺id时用命令摘要）；同id冲突保留原投影及原始新命令，增加未投影计数，不覆盖已保存正文。

`stream {sourceRef,resetEpoch,eventCursor,caughtUp}`与账号历史流绑定；同账号显式恢复保留sourceRef和原消息id，但清除caughtUp，重新完成同步后才可授权。新库/新扫码账号有独立sourceRef。授权事务返回的eventCursor是该次处理权限的历史分界；只有同sourceRef/epoch且游标严格在分界之后的来信可交模型，不信任发送方时钟。-2006同步重置在同一事务暂停会话、取消Queued并推进resetEpoch；保留原消息/发送/原始命令。读取事件和正文各自再次核epoch，拒绝pull之后发生重置的旧读请求。若同步提交失败则停止当前网络owner，不能用内存游标继续发。Host后台失败只暂停自己观察到的policy epoch，不误伤后来明确恢复的新授权。

群消息的senderId保持null，尚未推导发言人；正文保留协议原文字，不捏造昵称或成员身份。非文字/过大/不能解码的正文为null；原命令仍加密保留。消息不会触发任何媒体、链接或预览下载。这里只完成本机持久消息入口，完整模型消费及真实群收发验收仍待。

对协议明确分类的会话拒绝，停止当前client并持久暂停全部grants；凭据保留、authenticated=false，不自动续期/扫码，也不将一般网络故障直接当凭据失效。重新验证只走下面的显式恢复入口。

## 当前目录

新增directory.start（operationId/accountGeneration/accountIdentity）、directory.advance和directory.operation（operationId）、directory.page（operationId/offset）。start持久创建从零刷新意图；advance每次推进一个目录页、群页或身份核验，网络期间不持control锁；operation只读，page仅返回当前账号已完成快照、最多100项及nextOffset。重复终态id不重新请求，参数仍拒绝未知/重复字段。

候选来自从零联系人ID目录、独立群目录和已同步群id，均用发送入口同一verified_target新鲜核关系和受限名字字段。无法核验计入unverifiedCount；群发现失败继续核验已知候选并标groupDiscoveryIncomplete=true。stalled cursor/超限记failed；服务端wait投影为retryAfterMs，等待时不发新查询。原始metadata/cursor不出RPC。

意图及终态快照落同一Vault；中间外部缓存和进度只在进程内，避免每个联系人后重写整个账号库。断开/EOF/重启记interrupted，不自动续跑或假造完成计数。新刷新可替换当前目录缓存，旧意图保留且snapshotAvailable=false；没有删除聊天、发送或控制历史，也没有为它们增加TTL。完整Host消费端仍待，accountServiceReady=false。

## 显式保存会话恢复

新增session.resume（operationId/accountGeneration/accountIdentity）、session.operation和session.cancel（operationId），仍为封闭参数，未知或重复字段拒绝。只有明确调用resume才认证；重启、status和查询不会认证或扫码。同id返回原回执，终态/不确定认证不会重放；没有自动QR回退。

resume先持久化意图、推进账号授权generation并暂停所有会话，再停止旧owner。临时认证owner的单次Persistence回调将已验证凭据和succeeded回执原子提交；随后停止临时owner，从已接受Store创建普通owner，不导出协议快照或同时保留两个活动writer。适配器仅返回Ok不能冒充持久接受。取消/断开/close与迟到回调相互隔离；回执保留authenticationMayHaveOccurred=true，不承诺撤销服务端设备信任。

ResumeRecord包含id、sourceGeneration、accountGeneration、accountIdentity、phase、authenticationMayHaveOccurred、startedAtMs、updatedAtMs。phase为authenticating/succeeded/failed/cancelled/interrupted；failed或interrupted也可能已有远端授权。若接受回调已提交，太晚的取消不改写成功历史，但本地不会因迟到结果重新上线。

账号授权代次与历史流分开：同一已保存账号的resume沿持久意图追溯原消息流，不复制历史或重置游标/事件序号；新账号登录不合流。message.id及其中accountGeneration是原消息流的稳定代次，当前读取仍要求最新账号授权代次和身份一致。旧发送租约/凭据writer已被新代次拒绝，恢复连接也不恢复代聊授权。Node/Host消费已接入；真实恢复兼容性仍待，accountServiceReady=false。
