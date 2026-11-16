# 服务端公钥来源：分层状态

2026-11-17，砚砚回读宪宪共享证据`meow-talk/output/wechat-delegation-alpha10/key-provenance/结论.md`第二版，并独立运行其只读提取脚本，核验当前腾讯签名应用及资源封印。只读程序制品，未启动微信、读运行内存、账号目录或真实凭据。

| 对象 | 当前证据 | 可支持的结论 | 不能外推的结论 |
| --- | --- | --- | --- |
| MMTLS ECDSA版本5、1000，两把验签公钥 | 本机`WeChat.app`4.2.0（270353），Tencent Developer ID/Team `5A4RE8SF68`；`codesign --verify --deep --strict`通过。`CodeResources`将`Resources/wechat.dylib`封印为SHA-256 `d61eab4f61523936f84e3c98f57395edb15e45d3cd4291adb363e44e63375c98`，提取文件摘要一致。x86_64和arm64各自`7,1000-5,1000`记录中的验签公钥值，均与仓内mmtls fixture的对应版本匹配 | 两把实际公钥值在这份官方签名制品中存在，已得到独立重跑核对。脚本按DER/曲线点及去除PEM头尾/空白后的base64比较，不声称原始PEM文本连空白逐字节相同 | 不能当作已核验Linux4.1.13.26来源、正在运行的网络对端、最终制品或整个协议的安全证明 |
| 业务层10014、50005、10001各两把，共六把 | 宪宪第二版报告：所覆盖静态编码/压缩形式未匹配，主通道读取运行时对象，存储来源未追到。本轮只复跑MMTLS记录提取，没有伪称重跑全包全部阴性扫描 | 仍未独立确认；“未找到”不是证明非官方。10001未被当前`profile_for_region`选择，数据保留不表示它可达 | 不能写“全部八把官方来源已核验”，也不能从旧网络登录成功外推全部版本都可信 |

砚砚本轮输出：`meow-talk/output/wechat-delegation-security-rewrite/protocol/official-mmtls-recheck.json`。脚本来源：同共享目录的`extract_mmtls_static_keys.py`及`scan_keys.py`，执行前已读代码，只扫描文件并写自有JSON，不加载被扫描对象。原报告还给出了MMTLS默认配置注册与GetEcdsaKey的静态调用地址；该反汇编链本轮回读，未重新独立反汇编，不能把它冒称第二次独立复现。

源码数据流另行核对：`Session::handshake`只接受5/1000，并无条件校验服务端签名及Finished后才建立short session；`prelogin_rpc`先建立该session再生成业务层预登录包；短链使用会话导出的ticket/access_psk加密业务route及payload。因此MMTLS根来源和业务层公钥来源应分层记账。这里记录代码观察，不将其直接升级为完整运行安全结论。

来源审计：source=use（本机官方签名制品的值比对，范围精确）；non-triviality=not-compared（来源核查，无算法增益主张）；decision-fit=direct用于两把MMTLS公钥来源，partial用于整体账号安全。完整`officialKeyOriginVerified`仍为false，因为不是全部内嵌公钥的来源都已核清。宪宪当前额度限制不影响读回已经落盘的证据，不能将旧空响应当未做取证或完整结果。
