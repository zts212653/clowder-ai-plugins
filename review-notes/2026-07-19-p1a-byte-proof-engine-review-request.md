# Review Request: P-1a schema-independent byte-proof engine

Review-Target-ID: p1a-byte-proof-engine
Branch: feat/p1a-byte-proof-engine
Code commit: `ba378fdc4a93f678aa006bc58f89234274dc3616`

## What

Adds an internal, pure byte-proof calculator under `packages/plugin-contract/src/byte-proof/`.
It accepts a JSON template, explicitly supplied closed string-leaf profiles, and a caller-owned
frame budget; it calculates compact-JSON UTF-8 maxima for ASCII, multi-byte UTF-8, and JSON-escape
families, then emits per-leaf N/N+1 candidates. Tests include a frozen P-2 message fixture.

## Why

P-1a.0 shape approval gates contract-owned schemas and numeric wire bounds, not this reusable
calculation kernel. Preparing it now lets the eventual schema-first P-1a work feed approved leaf
profiles into a tested calculator without inventing a registry row, public bound, or runtime check.

## Original Requirements（必填）

> P-1a generates per-row byte proofs and validators; P-1b executes the conformance oracles.
> Proof coverage includes ASCII, multibyte UTF-8, JSON escaping, and +1-byte oversize rejection.
> A proof above `maxFrameBytes` returns to #1165 as a shape delta.
> No implementation may manufacture a bound absent from the approved matrix.
> P-1a has no runtime or transport code.

- 来源：`docs/plans/2026-07-17-m0-standalone-io-plan.md:93-97, 351-356, 383-387`
- **请对照上面的摘录判断交付物是否解决了这块前置需要，同时没有越过 shape-approved 边界。**

## Tradeoff

The calculator intentionally takes an explicit generic template and leaf profiles rather than
importing the unapproved 12-row matrix or publishing an API. This makes the current change less
end-to-end, but prevents a second source of wire shape or a pre-approved numeric bound.

## Architecture Ownership（必填）

Architecture cell: `plugin-contract / internal byte-proof tooling`
Map delta: none
Why: this is a pure helper inside the existing contract package; it adds no Store, Queue, Router,
Adapter, Dispatcher, Binding, production enforcement, or public export.

请 reviewer 检查：

- diff 是否与 `Map delta: none` 一致；
- 是否意外新建了并行运行时组件或把工具层暴露为生产 wire 行为；
- 是否把一个未获批准的 public bound、frame policy，或 12-row shape 固化进实现。

## Open Questions

### 技术 OQ（给 reviewer）

1. `JSON.stringify` 后以 `Buffer.byteLength(..., "utf8")` 计算紧凑 JSON 值，且不计 NDJSON
   末尾 LF；这是否与计划里的 "compact profile" / frame 口径一致，还是 generator 应显式计入 LF？
2. 当前 N/N+1 candidate 只在该 candidate 超过调用方 budget 时标记失败；请确认这比“每个
   N+1 都必然失败”的错误断言更符合可复用 proof skeleton 的职责。
3. 请审查 `😀`（四字节 UTF-8）与 U+0000（六字节 JSON escape）是否足以代表此阶段承诺的
   multibyte / escaping worst-case families；若不够，请给出不依赖未批准 schema 的补法。

### 价值 OQ（给 operator，如有）

无。

## Next Action

请以 fresh context 审核 `origin/main...ba378fd` 的两份源码文件，特别检查以上三项技术 OQ、
输入校验，以及 P-2 fixture 是否仅作样例而未被提升为 P-1a shape 真相。请给出 finding-only
结论；有 finding 我会按 `receive-review` 逐项处理。

## Review Sandbox（必填）

- Path: `/tmp/cat-cafe-review/p1a-byte-proof-engine/Fable`
- Start Command: `pnpm --dir packages/plugin-contract exec node --import tsx --test src/byte-proof/encoded-byte-proof.test.ts`（library-only；无 dev server）
- Ports: `web=N/A`, `api=N/A`

### 沙盒 Bootstrap（reviewer 在干净 sandbox 复跑 Validation 前必做）

```bash
unset NODE_ENV
pnpm install --frozen-lockfile
```

## 自检证据

### Spec 合规

- 只新增内部 `src/byte-proof/`；`src/index.ts` 未导出该模块。
- 没有 registry、method、wire schema、public numeric bound、frame default、runtime/transport、
  发布或依赖变更。
- 所有数值（leaf maxima / frame budget）均由调用者输入；实现只计算并报告。
- 冻结 P-2 `message-draft.json` 仅作为证明样例；其未界定的 `text` payload 未被伪装成 closed leaf。
- quality gate：无 UI 或运行时表面，故浏览器/视觉 dogfood 不适用；以真实冻结 fixture 的计算测试
  作为工具层 dogfood。

### 测试结果

```bash
# 作者实际执行（先清掉继承的 production 安装模式）
unset NODE_ENV
pnpm install --prod=false

node --import tsx --test src/byte-proof/encoded-byte-proof.test.ts
# 3 passed, 0 failed

pnpm test
# 109 passed, 0 failed

pnpm lint
pnpm typecheck
pnpm build
pnpm --filter @clowder-ai/plugin-contract generate:check
# all passed; generated contract current

git diff --check
# passed before commit
```

### 根目录工件闸门

```bash
git status --short | rg '^.. [^/]+\\.(png|jpe?g|webp|gif|webm|mp4|mov|wav|pdf|pen)$'
git diff --name-only origin/main...HEAD | rg '^[^/]+\\.(png|jpe?g|webp|gif|webm|mp4|mov|wav|pdf|pen)$'
# both empty
```

### 相关文档

- Plan: `docs/plans/2026-07-17-m0-standalone-io-plan.md`
- Feature: P-1a M0 standalone I/O; task `2193542f`
