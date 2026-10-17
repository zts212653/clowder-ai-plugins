---
feature_ids: [repo-sync]
topics: [codehub, issues, compatibility, recovery, verification]
doc_kind: verification-report
created: 2026-10-15
---

# PR #77：CodeHub Issue 阻塞修复

来源是用户在本 PR 的[接口分析](https://github.com/zts212653/clowder-ai-plugins/pull/77#issuecomment-6194104318)与[补充实测](https://github.com/zts212653/clowder-ai-plugins/pull/77#issuecomment-6194157808)。继续使用现有分支，不拆 PR，不改变既有仓库绑定、游标或创建意图。

## 根因与修改

1. Issue 查询错误地只接受 GitLab 裸数组。CodeHub 实测返回 `{opened,closed,all,issues:[…]}`，首次查找就失败，尚未进入正常创建流程。现在仅对 Issue 集合路径解封，MR 集合继续要求裸数组。
2. 分页完整性检查原本读取封套对象的 `length`。现在检查解封后的数组，继续按 `x-next-page` 读取；缺少满页回执、跳页、回退、循环、异常格式和超过页数上限都暂停，避免把不完整查找当成不存在而重复创建。
3. 关联流程无条件读取 CodeHub 不支持的 `issues/:iid/related_merge_requests`，返回 405 后阻塞。现在回读已映射 Issue、具体 MR 的地址 / head / 分支 / 状态，以及 MR 描述里的独立 `Related to #内部编号` 行和稳定关联标记，写入后重新 GET 核对。保留原描述，缺行可以补齐，已有行不重复追加。
4. 同类检查补齐无效 Issue iid、非对象列表项和异常描述类型。明确的 MR 空描述 `null` 可正常补关联；缺失描述字段及非法类型仍暂停。非作者复核发现的空描述回归已先复现失败再修正。

创建、关闭、重开 Issue 的单对象接口，以及 `opened` → `open` 状态映射，与用户实测一致，沿用原实现。关联回执证明的是**平台远端描述关联**，不声称平台原生关联列表已验证。关闭仍须实际 Git 合入、核心核验和必要提交全部接受后，显式更新并回读；没有吞掉 405、认证错误或网络失败的兜底分支。

## 已有失败任务怎样继续

更新本 PR 分支，重启插件并重新提供本人 Token，然后在原项目点击 **恢复原同步**。无需重建基线、修改冻结配置或清空台账。

- 尚未创建的 Issue：完整查找后正常创建。
- 创建已生效但回执丢失：从列表找回原稳定标记，复用原 Issue。
- 旧版关联 405：沿用已存在的 Issue / PR，补齐并回读原 MR 描述。
- 关联或关单已生效但回执丢失：先回读原对象，已经满足的操作不再写入。
- 来源重复、身份冲突、读取不完整：保留意图和映射，暂停核对，不创建第二个对象。

## 验证记录

| 检查 | 结果 |
|---|---|
| `node --test test/gitlab-codehub-compatibility.test.mjs test/gitlab-issues.test.mjs` | 13/13；旧实现出现封套解析、405、非法编号等真实 RED；空描述回归另有 1/1 RED → GREEN |
| `node --test test/codehub-runtime.test.mjs` | 4/4；真实隔离 Git + 工作台 HTTP，两笔共用 Issue，正常 / 创建回执丢失 / 关联回执丢失 / 关单回执丢失，均跨服务重启恢复 |
| GitLab PR、Issue 自动化 / 纠错 / 认证 / 设置、完整迁移恢复 | 20/20；包含 PR 回执丢失、映射冲突和迁移后恢复 |
| `connection-ux-browser-check`、`process-setup-journey-browser-check`、`pause-boundary-browser-check` | 3 个入口退出码均为 0；配置到合入关单、文件保留、身份映射、第五步、逐笔暂停、刷新重启和桌面 / 移动端 |
| `npm run lint` | manifest / MCP 3/3，语法扫描通过；首次受沙盒临时目录与 loopback 限制，解除测试限制后原检查通过，没有改产品逻辑 |
| `npm run build`、`npm run test:package` | 构建通过；全新 consumer 安装与真实 stdio / Web 启动 1/1 |

四条恢复旅程最终均只有 **1 个 Issue、2 个 PR、2 次关联写入和 1 次关单**，完成后重复继续不增加写入，未请求不支持的关联端点。浏览器使用的 CodeHub 夹具也已改成实测封套与 405，避免测试继续错误假设标准 GitLab 行为。

原本机正式试用服务已在核对空闲任务、私有配置和进程身份后重启；新实例健康、页面 / 静态资源、安全策略及源码 / 安装包一致性回读通过，`/demo` 返回 404，没有添加测试项目或重写历史。本轮只跑受影响的上述回归集合，没有重跑全部 23 个浏览器入口或整个包的所有历史测试。

以上平台 API 为依据用户实测协议构造的本机 HTTP 服务，Git 为真实隔离仓库，来源队列为冻结测试数据；没有访问真实内网或使用真实 Token，不代替新版在 CodeHub 的部署验收。没有新增演示服务，PR 保持 Draft / Alpha。
