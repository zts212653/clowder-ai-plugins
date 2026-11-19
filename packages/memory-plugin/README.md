# 记忆插件

Clowder AI 的官方记忆插件。它接管记忆业务规则、存储与后台处理，宿主负责身份、授权、canonical 原文和物理存储根。

记忆 v1 的线上契约在独立包 `@clowder-ai/plugin-memory-contract` 里，只含 DTO、校验和解释。它与 F202 的 `plugin-contract`、SDK 版本各自独立，不要求同步升版。

[English](README.en.md)

## 这个插件管什么

- **线程 KV**：沿用旧 Redis hash 的记录形状、50 键上限、新键才驱逐最旧，以及持久（TTL=0）语义。
- **记忆业务**：检索、融合、降级、筛选、分页，以及 matter / person / profile / taste 的写入规则与回执。
- **后台处理**：索引、重建、embedding 生命周期和记忆任务的 cursor。

宿主保留 HTTP / MCP / PDL 入口、请求身份、原文授权和通用审批。插件不自己拼物理路径，不接触 Redis 客户端或 SQL 句柄。

## 协议

`memory.describe` 无业务参数，返回 `{protocolMajor: 1, operations: string[], storageFormat: 1}`。宿主在加载 actions 之后、宣告 healthy 之前调用它，做一次准入校验；每次安装、换包、重启和手动启用都重新校验。

`memory.dispatch` 接收 `{operation, input}`。插件在边界处把操作类型和 JSON 一次性解析成类型化 DTO，之后的分支只处理已校验的输入。

当前已落地第一批真实消费者：`kv.put` / `kv.get` / `kv.list` / `kv.delete`。

## 宿主端口

插件不接受任何未授权的存储访问。宿主通过 `MemoryHostPorts` 提供：

```ts
interface MemoryThreadKvPort {
  readAll(threadRef: string): Promise<Readonly<Record<string, string>>>;
  write(threadRef: string, key: string, json: string): Promise<void>;
  remove(threadRef: string, key: string): Promise<boolean>;
}
```

宿主负责校验 `threadRef` 属于当前调用已认证的线程，并按它构造物理键。插件把 `threadRef` 原样透传，从不自行拼装；部署级 `default` 是一个普通的已授权线程引用，不是插件可以绕过的特例。

宿主不提供这些端口时，插件在准入阶段直接失败——不会降级成一个空记忆库。降级会让两边都看起来正常，同时隐藏全部已有记录。

## 开发

```bash
pnpm --filter @clowder-ai/plugin-memory-contract build
pnpm --filter @clowder-ai/memory-plugin build
pnpm --filter @clowder-ai/memory-plugin test
```

管理页声明在 `console/pdl.yaml`，文案在 `console/i18n/`。宿主读取的是包内的 console 文件，不是插件运行时自己校验的 manifest。
