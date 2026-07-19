---
feature_ids:
  - P-1b
topics:
  - stdio-harness
  - windows
  - process-tree-cleanup
doc_kind: bug-report
created: 2026-07-20
tips_exempt:
  reason: Internal conformance-harness cleanup semantics; no user or cat guidance surface changes.
---

# P-1b Windows process-tree cleanup

| 栏位 | 内容 |
|------|------|
| **1. 现象** | Windows 上 `HarnessChild.stop()` 在 `taskkill /T /F` 非成功时仍可能成功返回；即使 sentinel root 已退出，未继承协议流的 helper 仍可能存活。期望是没有独立后代存活证据时 fail-closed，不能把 root 消失当作整树回收证明。 |
| **2. 证据** | Cloud R3 inline review `3610759288` 针对 `583840c43ae21ca6fe4741bb5eb9e6a9752d5d65`；Cloud R4 thread `PRRT_kwDOTWGKB86SHlWK` 针对 `02293c574a10e34d10a4943eaf6680ed1d295386`。R4 证明 Windows `treeIsAlive(rootPid)` 只探测 sentinel，而状态机在 taskkill nonzero/spawn-error/timeout 后仍允许 root-absence 升级为 `reaped`。 |
| **3. 根因** | R3 已把 kill utility 终态纳入单写者状态机并引入稳定 sentinel root，但把“root 不存活”误当成“整棵后代树已回收”的充分证据。该探针只证明 wrapper 消失；taskkill 非成功时没有 Job Object 或后代枚举提供独立的 whole-tree 证明。 |
| **4. 诊断策略** | 以 Fable `d1340f8` 的 Stateful Object Gate 为约束，用可注入 Windows runtime 穷举 taskkill success/nonzero/spawn-error/timeout；分别验证 root 存活与 root 消失。仅 success 可继续 bounded root probe，所有非成功结果在缺乏独立后代证据时直接收敛 `cleanup-failed`。 |
| **5. 超时策略** | 若 sentinel 控制通道无法同时保持目标退出语义和稳定树根，停止实现并回到 plan owner；不得退回“直接 PID + taskkill fallback”。 |
| **6. 预警策略** | 任一路径仅凭 root PID 消失宣告整树回收、忽略 kill utility 非成功、或 cleanup error 未进入公开边界，即说明 whole-tree 证据仍不充分。若需要让非成功结果恢复为成功，必须先引入 Job Object 或独立后代枚举，并回到 plan owner 复核。 |
| **7. 用户可见交互修正** | Harness API 保留 `waitForExit()` 的直接目标语义；`stop()` 新增 fail-closed cleanup 失败信号，不再静默遗留 helper。 |
| **8. 验收** | `process-tree-controller.test.ts` 覆盖四类 kill utility 终态，并证明 nonzero/spawn-error/timeout 即使 sentinel root 已消失也 fail-closed；success 仍需 bounded probe、target-exit 和 stream-close。child-process integration 覆盖公开错误边界；package test/typecheck/lint/build/generate/built-boundary/conformance 全绿。 |
