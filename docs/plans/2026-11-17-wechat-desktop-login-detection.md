# 本机官方微信登录情况识别

沿原Task000075及用户000535新指令实施，不新建工位。基线alpha.11/0f7faa4的独立审和CI已通过；本轮是额外的只读桌面识别能力，不能借用旧批准覆盖新代码。创作稿为宪宪000538，菜单证据修订为000542；读完两版后采用修订稿，去掉窗口大小线索、未实测的登录页推断，保留桌面与插件连接两行。

用户已在mac登录。独立Swift探针实测只有一个WeChat 4.2.0实例，但当前进程链AXIsProcessTrusted=false；未授权时没有读取界面。原visible-reader主要是截图/OCR和CGEvent，不能用它的窗口尺寸或运行进程直接证明微信登录。未申请系统权限、未截屏、未读取聊天、账号资料/凭据或运行内存。桌面会话是否要直接复用免扫码已在同一线程澄清；本轮先完成两种意图都需要的状态识别，不将检测结果用作插件认证。

## 权限与事实来源

独立native/desktop crate只依赖既有锁内serde/serde_json及构建用cc，没有协议、网络、Keychain、Vault或账号服务依赖。自己的小进程与clowder-wechat-link分离；后者不新增AppKit/AX入口。两个制品使用不同的hardened runtime签名identifier。探针仅有--desktop-status和--request-desktop-access两个固定模式，无通用路径、shell、URL、UI操作或凭据输入。无账号数据目录参数，不创建link-vault。清空环境、禁core dump、拒root/setuid、15秒/父进程退出看门狗，Node超时和stop只结束自有子进程。

NSRunningApplication/NSWorkspace发现固定com.tencent.xinWeChat；SecStaticCode校验Apple签名链、应用identifier和Tencent Team 5A4RE8SF68。未找到、未运行、多实例和签名不符分别报告。辅助功能查询不默认弹框；只有本人点击并勾选说明后才以明确flag请求系统权限。OS授予辅助功能的范围较大，当前功能只读取首个应用菜单，最多两层/每层24个命令，单AX调用150ms超时；不取窗口标题、聊天、账户目录或秘密。对外仅固定状态/受限版本/检查时间，不返回任何菜单原文或账号身份。

只有已核的4.2.0和明确可用的“退出登录/Log Out/登出”菜单条目支持logged_in_ui。未知版本、条目缺失或禁用仍为unknown，不推断为已退出；真实已登录/已退出/锁定界面下菜单行为尚待辅助功能授权后的实测。菜单可用最多说明本机存在登录界面证据，不证明网络在线、桌面账号与插件账号相同，也不授予会话读写权限。

## Host与界面

Runtime在账号连接组件尚未准备时即可处理desktop_status；desktop_request_access另要求confirm=true。独立Supervisor探针核自身PID、产品、版本、完整摘要及封闭6字段输出，异常/超限不回显。检测不暂停/替换现有账号服务、不登录、不恢复、不发送、不创建代聊策略。检测失败清除旧的已登录观察，避免刷新后继续显示旧绿点。stop/失效owner之后排队的检测不得再启动。

现有连接卡顶部增加“本机桌面微信”和检查/权限入口，原账号hint明确标“插件连接”，页头也用插件连接措辞。只在打开卡片和本人重新检查时查询，不跟随状态轮询重复弹权限；申请权限须勾选。桌面状态不改变扫码、恢复或开启代聊按钮。沿用badge/notice/toolbar和既有颜色，不开新页面。失败显示无法确认，绝不把process存在当登录成功。

## 检查与交付

先红后绿：原程序拒绝新的只读模式；原Runtime要求先准备账号，无法完成桌面检测；失败重查会保留旧logged_in_ui。新增检查分别复现后修正。Node实际合成子进程核私有输出、空环境、无vault初始化、明确请求权限、保留现有账号服务、owner停止隔离及恶意额外字段不外泄。浏览器合成状态覆盖权限缺失、勾选才请求、重新检查后显示桌面已登录且插件仍休眠；原登录/代聊/接管完整旅程继续通过。真实本机只运行无提示的状态查询，权限对话框和正向菜单匹配不冒充已实测。

最终重新编译两件自有制品，以同一source commit/hash/lockfile绑定。完整Node/Rust、27文件来源重建、桌面/手机/暗色、最终归档空白consumer及跨语言旅程后交准确HEAD独立审。现用插件不替换，账号授权和真实收发仍未开始。证据放原output/wechat-delegation-security-rewrite/login/desktop-*；新候选alpha.12另附安装说明。Task保留原责任，尚未关闭。
