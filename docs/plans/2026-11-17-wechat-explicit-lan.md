# 本次登录的显式局域网验证

沿原000352重写授权与原Task继续；不连接真实微信、不在真实LAN监听。取证：宪宪000444、固定MIT上游ed976d7的lan_login.rs/client.rs/wire.rs。上游没有成功真号样例；本实现不因此声称实机兼容。

微信轮询503的LAN challenge会清除批准凭据。现版直接终止并记录lan_required。改后新增lan_awaiting_consent及lan_verifying两种活动态；旧lan_required继续是终态，避免给旧记录复活权限。待批准意图与QR保持原id/guard。只在本人新点击并确认之后，经stdio reader原准入票据、control epoch和同一Store事务记录本次LAN许可/期限，再开监听/上报。新意图、重试上传或换nonce都不由轮询自动发起。

协议只增加固定CGI22312/extdeviceuploadlaninfo的受guard调用：identifier/cookie/key_version仍留在LoginAttempt内部；一次标记在请求前设置，响应丢失不重发。编解码沿固定上游，令牌为受限UTF-8、最多4096字节，只在native易失内存中；不进入Host、模型或诊断。LoginGuard可缩短到当前时间后120秒并保留同一个取消原子量。

监听由自有native/link模块负责，无新增外部依赖。生产只枚举启用的广播型非回环/非点对点IPv4接口，排除VPN/tun、CGNAT、198.18、公共地址；macOS选择en*接口，最多8个合法私有地址和连续子网掩码。分别绑定这些具体地址的同一个8050–8100端口，不绑定0.0.0.0。只写不读、收到已验签短链的令牌后才接受并应答；来源必须在该监听接口同一子网内。总连接数最多32、单连接写入最多1秒，取消/到期/批准/拒绝/进程退出结束。监听线程自身观测guard，网络线程阻塞也不能延长暴露。令牌应答不授予账号权限，后续正常手机批准/手动认证检查仍在。

Native Store保留原操作及本次许可/期限，无TTL；重启中断，不重开监听、不重上报。allow_lan重复或未知结果仅投影原记录。Host AuthFlow只在同进程/库/原登录意图的待LAN确认阶段发送一次明确请求；随后原操作轮询继续，未知只query，取消仍指原id。Native/Node/UI契约新增能力explicit-login-lan-v1及受限phase/许可/期限投影；不输出IP、identifier或token。

面板常显本次范围确认：短时端口、私网地址向微信上报、同子网设备可得到验证数据、系统可能不另弹网络许可、最长120秒/结束即关闭、仍需手机确认。初次遇到挑战时没有监听；按钮和checkbox只针对原操作，取消或换意图不沿用确认。

精准检查先覆盖：拒绝/未许可零监听与零上报；旧terminal记录不复活；准入排队后取消；上报只一次/ACK丢失无重试；两种LAN活动态重启中断；来源/掩码/接口过滤；真实loopback受控listener的frame、取消/期限与连接上限；许可后依然需要服务器批准；Host刷新/未知/旧取消与秘密canary。自动化仅loopback和合成私网数据，不绑定实际局域网地址。协议派生SHA与完整patch同步，重新逐文件重构、编译/打包并独立审最终HEAD。真实许可和兼容验证留到具体候选就绪、本人明确授权后。

## 本轮自证

源码提交b0f9920。Rust workspace的73项主检查、3项真实进程、100项协议及6项compile-fail均通过；2个ignored入口分别由父测试及Node显式启动。Node携带本次Rust libtest目标全包112/112通过。私有stdio真实reader在LAN上传阻塞时先返回取消，迟到上传不能认证；重复许可只读原记录，ACK丢失只query。拒绝状态优先于同包LAN标志。

loopback取消、截止和32连接后实际端口拒绝；截止/连接上限检查另重复20次全过。原固定休眠不能充当并发线程退出屏障；改等自有done信号，保留1秒上限及实际connect拒绝。生产逻辑不依赖测试延时。

真实Host Runtime/MemberRunner经Node typed client和Rust stdio/AccountService/加密Store走通好友主动/接话、canonical精确核对、切猫、接管后旧lease拒绝、群发送未知不重发及秘密canary。微信远端与成员端口仍为合成替身，不代表实际宿主安装或真实账号验收。浏览器合成面板走通扫码、LAN确认及原意图继续认证；确认前许可计数0、最终1，desktop/mobile/dark和无横溢出检查通过。Hub实际投递此前为unconfirmed，不据此声称本人已看到。

固定MIT上游和完整patch逐字节重构27文件；新增纯LAN codec注明改编源及原文件SHA。打包脚本同步刷新实际source/patch/lock摘要。日志在meow-talk/output/wechat-delegation-security-rewrite/login/的lan-tests.log、lan-node-tests.log、lan-browser.log、lan-close-repeat.log、lan-release-build.log和native-host-journey.log。准确最终HEAD及归档自证待制品就绪记录；Task仍doing，真实系统交互和微信收发验收未完成。
