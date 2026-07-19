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
| **1. 现象** | Windows 上 `HarnessChild.stop()` 在 `taskkill /T /F` 非零退出时仍可能成功返回；若直接目标进程先退出，其 helper 可能存活且 harness 不报告 cleanup 失败。期望是整棵树有可验证的终态：`reaped` 或公开 `HarnessCleanupError`。 |
| **2. 证据** | Cloud R3 inline review `3610759288` 针对 `583840c43ae21ca6fe4741bb5eb9e6a9752d5d65`；`child-process-harness.ts` 的 Windows 分支只监听 `taskkill` 的 `error`，不监听非零 `close`，而 Windows `processTreeIsAlive()` 仅返回直接目标是否退出。 |
| **3. 根因** | 终止请求、目标退出和整树回收被压在同一个直接子进程对象上：异步 kill utility 的终态未进入 cleanup 决策，且直接目标 PID 退出后不再是稳定的树所有权锚点。 |
| **4. 诊断策略** | 以 Fable `d1340f8` 的 Stateful Object Gate 重建单写者状态机；用可注入 Windows runtime 穷举 taskkill success/nonzero/spawn-error/timeout，并单独证明 target-exit 后仍使用 sentinel root PID。 |
| **5. 超时策略** | 若 sentinel 控制通道无法同时保持目标退出语义和稳定树根，停止实现并回到 plan owner；不得退回“直接 PID + taskkill fallback”。 |
| **6. 预警策略** | 任一路径仅凭 kill utility exit code 返回、只做一次存活探测、或 cleanup error 未进入公开边界，即说明仍在旧坐标系补锅。 |
| **7. 用户可见交互修正** | Harness API 保留 `waitForExit()` 的直接目标语义；`stop()` 新增 fail-closed cleanup 失败信号，不再静默遗留 helper。 |
| **8. 验收** | `process-tree-controller.test.ts` 覆盖四类 kill utility 终态、bounded poll、target-first-exit、hard-kill monotonicity；child-process integration 覆盖 sentinel 生命周期；package test/typecheck/lint/build/generate/built-boundary/conformance 全绿。 |
