# Google Cloud 配乐

[English](README.en.md)

让猫根据风格、情绪和配器生成音乐，将新的 MP3 和来源回执一起送进当前项目。使用你授权的 Google Cloud 项目和结算，不使用 AI Studio 的预付充值余额。此包目前是未发布的私有候选，不在插件目录中；需要支持项目产物交付的宿主版本。

## 配置与使用

1. 在 Plugin Manager 安装精确插件包，核对其项目产物交付说明。安装后保持未启用。
2. 填写要承担费用的 Google Cloud 项目 ID。该项目须有有效结算、启用 Vertex AI，并授予所选账号必要的项目访问权限。
3. 本机已有标准 Google Cloud 授权时，点“复用本机已授权账号”并确认。插件核对 ADC 的项目、结算及接口状态，再由 Manager 保存授权；不会读取浏览器或 AGY 私有登录。
4. 新连接或需要重新授权时，使用自己在 Google Cloud 创建的 Desktop app OAuth 应用，在卡片填写 Client ID 和 Client Secret。点连接，主动打开 Google 链接并勾选 Cloud 数据权限。接收器在后台等待；刷新卡片后可接续，过期后明确重新连接。取消按钮只取消等待；断开授权只影响本插件。
5. 测试连接通过后，明确启用。安装、检查、授权和启用均不生成音乐。
6. 请猫描述音乐，并指定项目内新的 `.mp3` 相对位置。猫使用 `generate_music`，为这一次有意的生成保留同一个 `requestId`；等待和恢复交付继续使用原参数。

已有授权无需因为安装插件而重新登录。项目与授权由一次设置操作一并保存；所填项目与授权的 quota project 不一致时拒绝，避免静默换项目。配置和凭据保存都留在 Manager，不要求复制令牌或运行终端命令。

## 费用、错误与恢复

Clip 默认生成短配乐，列表估价每次 $0.04；Pro 是明确选用的长音乐模型，列表估价 $0.08。目标时长和 BPM 是提示意图，不是实测保证。实际扣费及 Ultra 赠金是否抵扣，以 Google Cloud 账单为准；回执中的实际扣费保持未知。

宿主在生成前核准项目并预留音频与回执。已有文件或非法路径会在生成前拒绝。插件持久保留已生成内容，宿主承接媒体后完成交付；磁盘失败或权限变化只恢复交付，不重新生成。配额不足、安全拒绝和超时均返回结构化结果。

`pending` 表示同一操作仍在进行；`generation_unknown` 表示无法确认供应商结果，不能改请求编号自动再生成。`delivery_required` 表示保留了产物，但交付尚待恢复。只有 `delivered` 表示两个文件均已持久完成。恢复保留原 `requestId` 和参数。

停用会停止新调用及等待中的后台接收器。升级、停用和卸载保留已生成的音乐、回执和操作历史；卸载不会注销其他应用的 Google 授权。

## 开发验证

运行 `pnpm --filter @clowder-ai/music-generation build`、`typecheck` 和 `test`。测试使用临时目录和模拟供应商，不读取真实授权或付费生成。发布物另须从精确归档验证依赖闭包和宿主完整旅程；源码单测不代表真实生成已经验收。

官方资料：[桌面 OAuth](https://developers.google.com/identity/protocols/oauth2/native-app)、[项目结算查询](https://cloud.google.com/billing/docs/reference/rest/v1/projects/getBillingInfo)、[服务状态查询](https://cloud.google.com/service-usage/docs/reference/rest/v1/services/get)、[Vertex AI 价格](https://cloud.google.com/vertex-ai/generative-ai/pricing)。
