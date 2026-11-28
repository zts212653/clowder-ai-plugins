# Claude Code Agent 接入插件

[English](README.en.md)

当前候选通过 Agent Adapter v1 契约运行 Claude Code print 模式。Host 提供版本检测、私有身份文件及受控原生进程。用户提示经 stdin 传入，插件输出原生会话标识、文本、回合结果和用量。

此承载关闭工具和 MCP。SDK、交互承载、登录、模型发现和额度各有独立的产品验收要求。
