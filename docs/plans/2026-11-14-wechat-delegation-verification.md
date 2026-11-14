# 微信代聊候选：作者验证与独立审查范围

日期：2026-11-14 UTC。目标分支 `feat/wechat-delegation`，基线 `04f08e761af6d4423080f7e3fc83fbbdbdca9ae3`；正式审查使用请求消息指定的完整提交 SHA。

本次交付是实际插件代码及可安装开发归档。完整用户目标仍是本人选好友或群、选猫及交流边界后，由猫主动开口和持续接话，并随时由本人接管。**真实微信完整旅程没有走通**：尚未运行供应商二进制、扫码登录或对真实好友/群发送，也没有在实际 Host 内调用真实受限模型。隔离测试不能替代这些验收，不据此关闭产品任务。

## 已执行的验证

| 检查 | 本次结果与证据范围 |
| --- | --- |
| `node --test packages/wechat-delegation/test/*.test.mjs` | 最终 42 passed，0 failed。含真实 loopback HTTP、合成可执行文件的受监督进程、受限成员协议、持久竞态与安装后入口。 |
| `node --test scripts/ci-gate.test.mjs` | 12 passed，0 failed。检查 CI 编排；并非整仓 gate。 |
| `pnpm --filter @clowder-ai/wechat-delegation build`、`lint` | 通过。Node 原生构建，无 npm 运行依赖。 |
| 当前 Host `@clowder-ai/plugin-contract` 的 `validateManifest` | `valid: true, errors: []`。没有增加 Host schema。 |
| `git diff --check` | 通过。提交前另检查 staged diff。 |
| 发布物 consumer | 测试实际 `npm pack`，在空白临时 consumer 离线安装、导入最终入口、启动并经 owner 上下文获取真实面板；全局 fetch 被禁止，证明启用不会联网/启动 native；已打包 MCP 的 tools/list 为空，任意 tools/call 被拒绝。 |
| 浏览器组合旅程 | 当前工位启动 `scripts/preview.mjs`，`http://127.0.0.1:5188/`，实际使用最终 `dist/panel.html`。在 1280×900、390×844 上通过；无 pageerror、手机无横向溢出。 |
| `pnpm gate:ci` | 指定 Node 24.18.0 / npm 11.16.0 / zlib 1.3.1-e00f703 下，42 阶段全部通过（831 秒）。系统 Node 24.22.1 的首次尝试在工具链检查处拒绝，未绕过。整仓执行期间审查修复落地，因此再单独补跑最终包的 42 项测试、build/lint、浏览器及下述 Host 归档检查；未将前一轮 32 项包测试冒称最终修复覆盖。 |
| 真实 Host 源码的隔离接线 | Clowder AI `4a305ec1bd9536e25236e491632acb60424623fc` 的实际 archive admission、module worker、owner HTTP routes，临时 SQLite inventory 与内存 private storage；归档安装、启用、面板/status/pause_all、停用和重启保留暂停全部通过。全局 fetch 禁止，未调用真实模型、账号或供应商。此结果不代表用户运行中的宿主已经安装或具备模型执行支持。 |

浏览器实际执行：第三方同步范围确认 → 准备模拟账号 → 选择模拟群与猫 → 显示实际模型预览 → 一次授权 → 主动开口 → 未知结果 → 会话接管 → 全局暂停。接管后主动开口禁用，未知记录仍保留。最终桌面及手机截图已由作者查看，保存在本地隔离证据目录，未混入 npm 归档；测试脚本可重现。Hub 预览投递返回 `unconfirmed/no_matching_client`，没有声称用户端已打开。

主要回归保护：生成中和移交前接管；移交后取消未知不重发；账号预检失败零外发；切猫和重启失效旧许可；全局暂停阻止尚未完成的新授权；主动操作确认前先持久保存；native 退出和重新准备保持暂停；可信本人原消息触发同一持久接管；旧发送记录分页可查；撤销状态不被全局暂停改写。损坏二进制缓存仅用校验后的字节原子修复，保留账号 profile。

独立审查及实际 Host 验收揭示的修复均有失败信号：忙碌会话/到期事件阻塞账号游标；生成中接管后虚假的未回信状态、只主动模式未处理对方回信、明确取消未释放等待；授权未提交时的受限会话清理；Host 在 preStop 后撤销端口，stop 再次访问 storage 失败。分别补回归后通过。入站先以 waiting 记录持久保存再推进账号游标，按会话处理，避免用丢消息换推进；接管和重启取消旧 waiting。正文请求开始与接管同序，迟到正文不能进入新的授权代次。持久停止留在 preStop，后续 stop 只清理本地资源。

## 风险和审查重点

| 轴 | 影响与验证边界 |
| --- | --- |
| 行为 | 新增主动发起、持续接话、切猫、手动/计划执行及恢复。重点查组合旅程与迟到许可，不以单按钮测试代替。 |
| 数据 | Host CAS 保留授权与发送历史，无 TTL；native 独立目录可能同步更多会话，扫码前披露。仅授权且账号匹配的实时消息送模型，历史或其他群不得扩大范围。 |
| 安全 | 所有写操作由真实 Host owner 上下文授权；模型 memory=[]、零工具、无账号凭据。检查外部文本不能变更收件人/权限，以及下载、凭据、loopback、进程身份边界。文字敏感规则不保证覆盖所有诈骗语义。 |
| 契约 | 固定 Agent WeChat v2.4.1 API v1；摘要与 API 字段来自发布方，不是平台认可或独立安全认证。Host 可选 memberSessions 缺失时明确不可用，无全权限回退。 |
| 不可逆 | 实际外发无法用本地回滚撤回。提交前持久关口与停止排序；提交后保留平台状态，未知只查原键。所有当前测试均无真实微信副作用。 |

所有权见[实施计划](2026-11-14-wechat-delegation.md)。包保持 `private`，未加入正式目录、未发布 npm。CI workflow 与 lockfile 属于信任边界，按当前 CONTRIBUTING 由风险匹配的非作者独立审查覆盖，并要求 required CI；CODEOWNERS 是责任地图，不额外要求指定账号批准。作者本地结果不替代独立审查或 required CI。

下一步：非作者审查固定提交并处理 findings；在相容宿主验证安装入口和真实受限执行；由本人完成不可代替的微信扫码、目标选择和授权，再分别记录好友与群实收、主动会话与接管竞态。需要本人前先备好可审查安装候选，不把作者代码与浏览器验证转给本人。
