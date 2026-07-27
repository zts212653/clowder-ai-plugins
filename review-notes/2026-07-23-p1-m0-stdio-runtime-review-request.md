---
feature_ids: [P-1, M0]
topics: [plugin-sdk, standalone-runtime, standard-io]
doc_kind: review-request
created: 2026-07-23
---

# Review Request: P-1 M0 schema-neutral standalone stdio runtime — first slice

Review-Target-ID: p1-m0-runtime
Branch: feat/p1-m0-runtime
Code SHA: `5b6b58fe61da8c9a84a3dd8723995190e98f8e5f`

## What

Adds `@clowder-ai/plugin-sdk`, a schema-neutral, caller-stream-owned NDJSON transport
primitive. The public runtime is exercised through a real child process importing only the
public SDK; it preserves raw frames for later contract validation, keeps stdout protocol-only,
fails closed on framing/input/output/handler faults, and publishes a clean `dist` artifact.

This is the explicitly authorized P-1 first slice, not an M0 acceptance claim: all twelve
contract registry rows remain `ready=false`, and no handshake, grant, RPC, Host Broker, or
reserved production-method behavior is implemented.

## Why

SDK authors need one safe standalone byte transport before any contract-owned production wire
shape becomes executable. The runtime deliberately consumes the existing public conformance codec
instead of recreating wire truth, so later shape validation can use the preserved raw bytes.

## Original Requirements（必填）

> P-1 ultimately needs a real child-process standalone runtime over standard I/O, with every
> wire-level word contract-owned before runtime consumption.
> Framing is UTF-8 NDJSON and stdout is protocol-only.
> P-1a owns shapes; P-1b owns harness transport; P-1c owns the SDK author surface.
> This authorized first slice is schema-neutral only: every production registry row stays
> `ready=false`; no reserved production RPC or Broker shape may be manufactured.

- 来源：historical plan blob `6132eb6:docs/plans/2026-07-17-m0-standalone-io-plan.md:19-21,55,411-438`，以及 operator-authorized dispatch `0001784794557445-000215-82aaeea3`。
- **请对照摘录判断本 slice 是否提供真实公共 SDK child-process transport，同时严格保持 reservation boundary。**

## Tradeoff

Inbound processing pauses the caller-owned `Readable` and decodes one LF-bounded 16 KiB-or-smaller
slice at a time. This gives lower peak throughput than eagerly decoding a whole input chunk, but
prevents a slow handler or attacker-sized chunk from allocating an unbounded decoded-frame backlog.

## Architecture Ownership（必填）

Architecture cell: `plugin-sdk / schema-neutral standalone transport primitive`
Map delta: none
Why: the package adds one transport primitive only; it creates no parallel Store, Queue, Router,
Adapter, Dispatcher, or Binding, and does not alter an existing architecture ownership map.

请 reviewer 检查：

- diff 是否与 `Map delta: none` 一致；
- 是否意外新建并行状态/调度组件；
- 是否把 reservation-only contract row、handshake、grant、RPC 或 Broker 语义带入 SDK。

## Invariant Matrix

| 不变量 | 断言描述 | 验证方式 |
|---|---|---|
| INV-1 byte ingress | only `Uint8Array`/Buffer reaches the decoder; text/object chunks terminally fail closed | SDK object-mode and text-mode regressions |
| INV-2 raw evidence | handler receives public contract `DecodedNdjsonFrame { raw, value }`; original raw bytes survive parse | duplicate-member raw-frame regression |
| INV-3 bounded ordering | input pauses before decode; one LF-bounded slice is decoded/handled/written before the next; resume preserves order | high-watermark, multi-frame, and 10,000-frame single-chunk regressions |
| INV-4 terminal cleanup | any fatal/close stops acceptance, detaches caller-owned listeners, and never resumes input | fatal-close listener regression plus runtime state audit |
| INV-5 artifact boundary | `build` cleans `dist`; package contains only fresh public artifact and exact contract prerelease dependency | stale-sentinel `pnpm pack` regression |
| INV-6 reservation boundary | SDK transports generic JSON objects only; it contains no production RPC/Broker vocabulary | scope grep and exact diff review |

## E2E User Path Evidence

Scope verdict: ✅ 必做（developer-facing public SDK runtime）。

Path: public `@clowder-ai/plugin-sdk` import → spawned child stdin legal NDJSON → handler echo →
protocol-only child stdout. The real-child test is in
`packages/plugin-sdk/src/stdio-runtime.test.ts` and passed in this quality-gate run.

## Open Questions

### 技术 OQ（给 reviewer）

1. Verify the byte-slice loop cannot decode more than one LF-delimited frame before an awaited
   handler/output write, including cross-slice partial frames and an unterminated over-cap frame.
2. Verify terminal paths cannot race a later `resume()`, and public error classification remains
   `FRAME_ERROR` for codec faults versus `INPUT_ERROR` for non-byte chunks.
3. Verify the SDK consumes, rather than duplicates, the public contract codec and does not imply
   any executable production wire row.

请 reviewer 逐条验证 Invariant Matrix 中的不变量是否被代码保持。

### 价值 OQ（给 operator，如有）

无。

## Fresh-Context Findings

Agent: [砚砚/gpt-5.6-terra🐾]
SHA scanned: `5b6b58f`
Total findings: 8 (6 P1, 2 P2)

| # | Finding | Author 处置 | 状态 |
|---|---|---|---|
| FC-1 | handler lost raw frame evidence | contract `DecodedNdjsonFrame` boundary | ✅ `3a794da` |
| FC-2 | text-mode input could replace invalid UTF-8 | byte-mode guard; later non-byte guard | ✅ `3a794da`, `5b6b58f` |
| FC-3 | fatal then close retained listeners | idempotent detach | ✅ `3a794da` |
| FC-4 | stale dist entered pack | clean-before-build artifact regression | ✅ `3a794da` |
| FC-5 | pending handler allowed unbounded cross-chunk pull | pause/resume around processor | ✅ `6bf19fd` |
| FC-6 | one large chunk eagerly decoded all frames | LF-bounded incremental decode | ✅ `04be3a4` |
| FC-7 | object-mode chunk was silently ignored | `Uint8Array` whitelist + INPUT_ERROR | ✅ `5b6b58f` |
| FC-8 | slice loop rescanned attacker tail | search only bounded subarray | ✅ `5b6b58f` |

Failure-mode sweep: ingress/decoder ownership, stream mode, frame evidence, backlog, terminal cleanup,
and packed-artifact identity were audited across all public entry paths; no remaining same-family case
was found.

**Reviewer delta tracking**: 请在 findings 标注 `[FC:covered]`、`[FC:new]` 或 `[FC:N/A]`。

## Next Action

Please perform an independent cross-family review of `origin/main...5b6b58f`, with special focus on
the invariant matrix, adversarial stream behavior, public API scope, and packaging boundary.

## Review Sandbox（必填）

- Path: `/tmp/cat-cafe-review/p1-m0-runtime/opus`
- Start Command: `pnpm --filter @clowder-ai/plugin-sdk test`（library-only；无 dev server）
- Ports: `web=N/A`, `api=N/A`

### 沙盒 Bootstrap

```bash
unset NODE_ENV
pnpm install --frozen-lockfile
pnpm --filter @clowder-ai/plugin-contract build
pnpm --filter @clowder-ai/plugin-sdk test
```

## 自检证据

### Spec 合规 / Quality Gate 摘要

| 检查 | 结论 |
|---|---|
| 愿景与 slice 授权 | real child public-SDK transport 已交付；无 M0/production-shape 声称 |
| 交付完整性 | operator 已明确授权 first slice；后续能力通过扩展此 generic transport，而非重写 |
| Patch counter | `76f00a0` 为功能；其余四个 `fix` 均关闭 reviewer 新发现的不同 failure mode，不计同一 AC 返工 |
| Close scope | 本次仅请求 P-1 first-slice code review，不关闭 P-1/M0 feature；slice 内所有 AC 与 review findings 均已满足 |
| Fallback layer | 仓库没有 `scripts/check-fallback-layers.mjs`；手工 diff 仅有单一 terminal guard，无三层 fallback 新增 |
| Architecture ownership | 工作区无 `check:architecture-ownership` script 或 ownership-cell docs；上方 ownership packet 供 reviewer 语义核验 |
| Dogfood | real public SDK child-process loopback 已跑，见下方 SDK test 13/13 |
| Pen/UI | `designs/**/*.pen` 无匹配；无前端改动 |
| Artifact hygiene | 工作树与 `origin/main...HEAD` 根目录媒体/设计工件扫描均为空 |

### 测试结果

```bash
pnpm test
# plugin-contract 265/265; plugin-sdk 13/13

pnpm typecheck
pnpm lint
pnpm build
pnpm conformance
# all exit 0; conformance 25/25 fixtures and 18/18 behavior cases

git diff --check
# passed
```

The SDK suite also runs a `pnpm pack` stale-artifact regression. It verifies a clean packed `dist`
and the package dependency resolves to the exact contract prerelease `0.1.0-beta.4`.

### 根目录工件闸门

```bash
git status --short | rg '^.. [^/]+\.(png|jpe?g|webp|gif|webm|mp4|mov|wav|pdf|pen)$'
git diff --name-only origin/main...HEAD | rg '^[^/]+\.(png|jpe?g|webp|gif|webm|mp4|mov|wav|pdf|pen)$'
# both empty
```

### 相关文档

- Historical plan: `6132eb6:docs/plans/2026-07-17-m0-standalone-io-plan.md`
- Current repository boundary: `README.md:53-60`
- Feature: P-1 M0 standalone I/O first slice
