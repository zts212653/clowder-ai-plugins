# Clowder Pi ACP 桥

把支持 ACP 的 Host 连接到本机 Pi，并将 Host 提供的 MCP 服务器注册到当前 Pi 会话。
需要 Node.js 22+、Pi 1.3+；Pi 的模型和认证先在原生客户端配置并验证。

安装本地候选包：`npm install -g <本地路径>/clowder-ai-pi-acp-0.1.0-beta.1.tgz`。
在 ACP 客户端目录中填写命令 `clowder-pi-acp`，参数留空。Windows 也可填写安装后 shim 的绝对路径。
需要指定 Pi 时，在启动 Clowder 的环境中设置 `PI_ACP_PI_COMMAND` 为 `pi.cmd` 或原生 Pi 可执行入口。
Node 脚本启动方案：命令为 node.exe，第一项参数为本包 `dist/index.js` 的绝对路径。

MCP 由 Host 自动注入，无需填写回调 token、服务器命令或另建 mcp.json。
新建和恢复会话都使用当前 ACP MCP 参数；支持 stdio 和 Streamable HTTP，不支持 SSE。
服务器配置只在当前 Pi 进程生效，不修改原生 MCP 文件；同名本地配置会覆盖注册，因此检测到冲突时明确停止并提示移除重复项。
Pi 旧版本缺少原生注册 API 时明确报错，避免静默失去协作工具。

该桥使用 MIT `pi-acp@0.0.34` 的协议实现，构建时校验源 SHA-256，执行受测试保护的有限补丁。
上游为 https://github.com/svkozak/pi-acp 。本包保留其许可证，运行时继续调用用户本机 Pi，不内置另一份 Pi。
新增 MCP 透传、当前会话原生扩展、加载时刷新、退出清理和失败时历史保留。`dist` 为生成物。
为保护原生历史，不声明 ACP 删除会话能力；收到删除请求明确返回不支持，不会虚报删除成功。
状态根冲突检查与 Pi 的 `~`、file URL、Windows shell 路径解析规则一致。

开发：`npm install`、`npm test`（先 `npm run build`）、`npm pack`。
协议测试不调用模型；真实 Clowder 协作证据由对应任务验收报告提供。
