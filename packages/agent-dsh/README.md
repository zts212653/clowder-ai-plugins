# DeepSeek Harness Desktop 接入插件

[English](README.en.md)

插件为 DSH 提供原生 system 身份补丁，并把 ACP 会话事件和回合结果转换为 Agent Adapter v1 数据。Host 授权工作目录和可执行文件，生成私有补丁并管理 ACP 进程。续聊需要经过校验的原生会话标识。此插件明确不支持额度查询。

当前候选使用隔离 Desktop 和回环模型验证。默认启动授权、成员登录、工具审批及桌面引导仍需产品验收。
