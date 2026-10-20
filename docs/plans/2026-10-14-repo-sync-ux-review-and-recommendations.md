---
feature_ids: []
topics: [repo-sync, user-experience, design-review]
doc_kind: review
created: 2026-10-14
status: review-comments
tips_exempt: 针对用户旅程优化方案的设计复审意见，不替代原方案文档。
---

# 仓库同步插件用户体验方案：设计复审与实施建议

本文件基于 [2026-10-14-repo-sync-user-journey-optimization.md](./2026-10-14-repo-sync-user-journey-optimization.md) 的用户旅程优化方案，提供设计复审意见和实施建议。原方案的核心方向正确，本复审主要关注布局细化、实施风险控制和验收标准具体化。

## 1. 总体评价

原方案在以下方面表现优秀：

- **业务边界清晰**：明确保持 continuous/version 双模式、真实 Git 核验、单向同步等核心约束
- **问题诊断精准**：直接命中"流程碎片化"、"历史不可追溯"、"操作引导不清"三大痛点
- **记录结构深思熟虑**：第 5.3 节提出的四层关联（同步身份→执行任务→步骤尝试→配置快照）是正确的数据模型基础
- **验收标准务实**：第 7 节明确了"不只是接口成功，还要用户能回答在哪里、卡在哪"的标准

本复审主要补充细节和实施路径，不改变原方案主线。

## 2. 布局方案细化

### 2.1 左右分栏 + 垂直时间线的结合方案

原方案 3.1 节提出左右分栏（记录列表 | 详情），本复审建议**采用此方案，并在右侧详情内部使用垂直时间线展开子步骤**。

**推荐理由**：
- 左右分栏更适合"当前同步 + 历史对比"的场景
- 符合常见的"列表-详情"心智模型
- 便于在执行期间查看历史（原方案 3.3 节强调的需求）
- 右侧垂直时间线确保"同一流程展示大步骤和子步骤"

**具体结构示例**：

```text
┌─────────────┬──────────────────────────────────────────────┐
│ 同步记录    │  v2.3 → v2.4 同步详情                         │
│             │  外部 a17e9b40 → c2f84d91                    │
│ ● v2.4      │  内部 I0 → 待接受                            │
│   文件冲突  │  ────────────────────────────────────────    │
│             │                                              │
│ ✓ v2.3      │  ① 确认同步范围           [已完成 ✓] 2min   │
│   已完成    │     ├─ 读取tag版本        ✓ 14:30:12        │
│             │     ├─ 确认U0/I0对应      ✓ 14:30:45        │
│ ✓ v2.2      │     └─ 分析文件变化        ✓ 14:32:15        │
│   已完成    │                                              │
│             │  ② 准备代码               [失败 ×] 当前步骤  │
│ ✓ PR#123    │     [对象准备]                               │
│   已完成    │     ├─ 登记Issue映射      ✓ 14:33:20        │
│             │     ├─ 读取外部对象        ✓ 14:35:40        │
│ [筛选▼]     │     └─ 构造候选提交        ✓ 14:36:10        │
│             │                                              │
│             │     [文件处理]                               │
│             │     ├─ 保留内部文件        ✓ 14:36:25        │
│             │     └─ 合并README.md      × 冲突 (展开▼)    │
│             │         └─ 详情：3方合并检测到冲突           │
│             │            外部修改：第12行添加auth模块      │
│             │            内部修改：第12行添加log模块       │
│             │            [处理文件冲突] ← 主按钮           │
│             │                                              │
│             │     [质量检查]                               │
│             │     ├─ 核心文件树检查      ○ 等待中          │
│             │     ├─ 插件兼容性检查      ○ 等待中          │
│             │     └─ 业务检查            ○ 等待中          │
│             │                                              │
│             │  ③ 发布候选与创建PR        ○ 未开始          │
│             │  ④ 内部审核合入            ○ 未开始          │
│             │  ⑤ 核验并保存结果          ○ 未开始          │
│             │                                              │
│             │  ─────────────────────────── 固定操作栏 ─    │
│             │  当前需要：解决 README.md 的合并冲突         │
│             │  [处理文件冲突] (主按钮)                     │
└─────────────┴──────────────────────────────────────────────┘
```

**关键设计点**：
- 左侧列表：当前同步用实心点 ●，历史用 ✓/×，状态一目了然
- 右侧顶部：版本对应关系（外部→内部）始终可见
- 大步骤：折叠/展开，当前步骤自动展开
- 子步骤分组：用 `[分组名]` 明确归类（对象准备/文件处理/质量检查）
- 固定操作栏：粘性定位在右侧详情底部，滚动时始终可见

### 2.2 子步骤分组的必要性

原方案 4.1 节的"② 准备代码"合并了多个职责，建议增加子步骤分组以提升可读性：

```text
② 准备代码
   [对象准备]
   ├─ 登记Issue映射 (仅continuous模式)
   ├─ 读取外部对象
   └─ 构造候选提交
   
   [文件处理] (仅version模式)
   ├─ 保留内部文件
   └─ 处理三方合并
   
   [质量检查]
   ├─ 核心文件树检查
   ├─ 插件兼容性检查
   └─ 业务检查
```

**优点**：
- 用户清楚地知道当前在哪个阶段（对象准备、文件处理、检查）
- 两种模式的差异更明显（continuous显示Issue登记，version显示文件处理）
- 失败时更容易定位问题（是对象读取失败？还是文件合并失败？还是检查失败？）

### 2.3 移动端布局降级策略

原方案主要关注桌面端，建议补充移动端策略：

**桌面端 (>768px)**：
```text
┌─────────┬──────────────┐
│ 记录列表│  详情         │
│  30%    │   70%        │
└─────────┴──────────────┘
```

**移动端 (<768px)**：
```text
状态A：列表视图
┌──────────────────┐
│ 同步记录         │
│ ● v2.4 文件冲突  │  ← 点击进入详情
│ ✓ v2.3 已完成    │
│ ✓ v2.2 已完成    │
└──────────────────┘

状态B：详情视图（全屏）
┌──────────────────┐
│ [← 返回列表]     │
│                  │
│ v2.3 → v2.4      │
│                  │
│ ② 准备代码  ×    │
│   ├─ ...         │
│   └─ ...         │
│                  │
│ ───────── 固定 ─ │
│ [处理冲突]       │
└──────────────────┘
```

**关键规则**：
- 移动端详情全屏显示，顶部增加"返回列表"按钮
- 固定操作栏在移动端更明显（padding增加，阴影加深）
- 按钮高度至少 44px（Apple Human Interface Guidelines）

## 3. "Git 自动 PR"的准确表达

原方案 4.1 节强调"推送候选与触发创建发生在同一次 push，不拆成两个虚构的独立平台动作"。完全同意，并建议进一步细化展示：

```text
③ 发布候选与创建PR
   ├─ 保存创建意图         ✓ 14:35:10
   │   └─ 冻结候选：sync/pr-125 = c2f84d91
   │      目标分支：main
   │      MR参数：merge_request.create, target=main
   │
   ├─ 推送并触发创建       ✓ 14:35:45
   │   └─ 详情：git push -o merge_request.create \
   │              -o merge_request.target=main \
   │              origin sync/pr-125:sync/pr-125
   │      ▸ 1次push操作完成推送+创建请求
   │      ▸ 服务器返回：Created merge request !92
   │
   ├─ 解析创建回执         ✓ 14:35:50
   │   └─ 获得PR地址：https://internal.example.com/!92
   │      来源：Git push回显 (非平台API)
   │
   ├─ 回读候选ref          ✓ 14:35:52
   │   └─ 确认：sync/pr-125 = c2f84d91 (未被修改)
   │
   └─ 登记PR引用           ✓ 14:35:53
       └─ 内部PR #92 已记录
```

**优点**：
- 明确标注"1次push操作"，避免用户以为是两个独立步骤
- 展示实际命令（帮助调试）
- 标注"来源：Git push回显"，与平台API查询区分（原方案 5.1 节的"执行依据"需求）

## 4. 历史记录数据模型的渐进实施

原方案 5.3 节提出的四层关联（同步身份→执行任务→步骤尝试→配置快照）是正确的最终目标，但**实施时容易低估工作量**。

根据 VALIDATION.md，当前已有 113 项测试和 8 个浏览器脚本通过。如果大幅重构数据模型，可能破坏现有执行正确性。

### 4.1 建议分两阶段实施

**Phase 1：最小可行历史记录（不破坏现有测试）**

```typescript
// 最小可行版本：扁平结构，只记录关键信息
interface SyncRecordV1 {
  id: string;                    // 同步身份
  mode: 'continuous' | 'version';
  
  // 版本对应
  source: {
    pr?: number;
    tag?: string;
    commit: string;              // 外部U1
  };
  baseline: {
    externalU0: string;
    internalI0: string;
  };
  result: {
    candidateCommit?: string;
    acceptedCommit?: string;     // 内部I1
    internalPr?: number;
    internalIssue?: number;
  };
  
  // 时间与状态
  startTime: Date;
  endTime?: Date;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  
  // Phase 1 扁平存储步骤（暂不做完整任务关联）
  steps: Array<{
    id: string;                  // '1-confirm-range', '2-prepare-code'
    name: string;                // '确认同步范围'
    status: 'pending' | 'running' | 'completed' | 'failed';
    startTime?: Date;
    endTime?: Date;
    error?: {
      code: string;              // 'FILE_CONFLICT', 'GIT_FETCH_FAILED'
      message: string;
      detail?: string;
    };
  }>;
  
  // 受限配置快照（原方案 5.2 节要求）
  configSnapshot: {
    branches: {
      source: string;
      target: string;
    };
    fileRules?: {
      internalPaths?: string[];
      mergePaths?: string[];
    };
    prCreationMode: 'git' | 'command' | 'manual';
    // 不包含：凭据、完整命令参数、原始输出
  };
}
```

**Phase 2：完整关联结构（补齐细节）**

```typescript
// 完整版本：四层关联
interface SyncRecordV2 extends SyncRecordV1 {
  // 执行任务的完整关联
  tasks: Array<{
    taskId: string;
    belongsToStep: string;       // '2-prepare-code'
    belongsToSubStep?: string;   // '2.3-merge-files'
    startTime: Date;
    endTime?: Date;
    attempts: Array<{
      attemptNumber: number;
      startTime: Date;
      endTime: Date;
      result: 'success' | 'failure';
      error?: string;
      executionLog?: string;     // 受限日志
    }>;
  }>;
  
  // 配置变更历史
  configHistory: Array<{
    field: string;               // 'internalWebUrl'
    changedAt: Date;
    appliedToStep: string;       // 哪个步骤生效
    value: string;               // 脱敏后的值
  }>;
  
  // 执行依据标注（原方案 5.1 节）
  evidenceSources: {
    candidateVerified: 'git-ref-read' | 'git-fsck';
    prCreated: 'git-push-response' | 'platform-api' | 'user-registered';
    merged: 'git-verify' | 'user-confirmed';
  };
}
```

### 4.2 迁移策略

```typescript
// 读取时兼容旧格式
function loadSyncRecord(id: string): SyncRecord {
  const raw = readFromDisk(id);
  
  // 旧数据结构：按需迁移
  if (!raw.configSnapshot) {
    return migrateV0toV1(raw);
  }
  
  // V1结构：直接使用
  if (!raw.tasks) {
    return raw as SyncRecordV1;
  }
  
  // V2结构：完整版本
  return raw as SyncRecordV2;
}

// 写入时使用最新格式
function saveSyncRecord(record: SyncRecord): void {
  writeToDisk(record.id, record);
}
```

**优点**：
- Phase 1 可以快速实施，支持原方案第 7 节的"回看上个月的版本"场景
- 不破坏现有 113 项测试
- Phase 2 根据实际需求渐进补齐，避免过度设计

## 5. 主按钮固定位置的实现方案

原方案第 6 节提到"主操作位于固定区域，长页面滚动时仍能找到"，建议采用**粘性操作栏**（Sticky Action Bar）：

### 5.1 CSS 实现

```css
.action-bar {
  position: sticky;
  bottom: 0;
  background: white;
  border-top: 1px solid #e0e0e0;
  padding: 16px 24px;
  box-shadow: 0 -2px 8px rgba(0, 0, 0, 0.1);
  z-index: 10;
  
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}

.action-bar__prompt {
  flex: 1;
  color: #333;
  font-size: 14px;
  font-weight: 500;
}

.action-bar__button {
  flex-shrink: 0;
}

/* 移动端优化 */
@media (max-width: 768px) {
  .action-bar {
    flex-direction: column;
    padding: 12px 16px;
    box-shadow: 0 -4px 12px rgba(0, 0, 0, 0.15);
  }
  
  .action-bar__prompt {
    text-align: center;
    width: 100%;
  }
  
  .action-bar__button {
    width: 100%;
  }
}
```

### 5.2 按钮视觉层次

```css
/* 主按钮：继续、确认 */
.button.primary {
  background: #0066cc;
  color: white;
  font-weight: 600;
  padding: 12px 24px;
  font-size: 16px;
  border: none;
  border-radius: 6px;
  cursor: pointer;
  min-height: 44px;  /* 移动端触控优化 */
}

.button.primary:hover {
  background: #0052a3;
}

.button.primary:disabled {
  background: #ccc;
  cursor: not-allowed;
}

/* 次按钮：取消、返回 */
.button.secondary {
  background: transparent;
  border: 1px solid #666;
  color: #333;
  font-weight: 500;
  padding: 11px 23px;  /* 边框占1px，减1px保持视觉一致 */
  font-size: 16px;
  border-radius: 6px;
  cursor: pointer;
  min-height: 44px;
}

/* 危险按钮：撤销、删除 */
.button.danger {
  background: #dc3545;
  color: white;
  font-weight: 600;
  padding: 12px 24px;
  font-size: 16px;
  border: none;
  border-radius: 6px;
  cursor: pointer;
  min-height: 44px;
}

/* 按钮组布局 */
.button-group {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
}

@media (max-width: 768px) {
  .button-group {
    flex-direction: column;
    width: 100%;
  }
  
  .button {
    width: 100%;
  }
}
```

### 5.3 文案动态切换逻辑

```typescript
function getActionBarContent(syncRecord: SyncRecord): ActionBarContent {
  const currentStep = getCurrentStep(syncRecord);
  
  switch (currentStep.status) {
    case 'pending':
      return {
        prompt: '将接收这些变更，内部 main 等待平台合入',
        primaryButton: { label: '开始同步', action: 'start-sync' },
        secondaryButton: null,
      };
      
    case 'running':
      return {
        prompt: '正在执行，暂时无需操作',
        primaryButton: { label: '查看执行详情', action: 'expand-current-step' },
        secondaryButton: currentStep.cancellable 
          ? { label: '取消', action: 'cancel-task' }
          : null,
      };
      
    case 'waiting-user-action':
      if (currentStep.id === '2-prepare-code' && hasFileConflict(syncRecord)) {
        return {
          prompt: 'README.md 尚未解决，候选未发布',
          primaryButton: { label: '处理文件冲突', action: 'resolve-conflict' },
          secondaryButton: null,
        };
      }
      if (currentStep.id === '4-approval' && syncRecord.result.internalPr) {
        return {
          prompt: '在内部平台完成审核合入',
          primaryButton: { 
            label: '打开内部 PR #' + syncRecord.result.internalPr, 
            action: 'open-pr',
            href: getPrUrl(syncRecord),
          },
          secondaryButton: { label: '已在平台合入，核验结果', action: 'verify-merge' },
        };
      }
      break;
      
    case 'failed':
      if (currentStep.error?.code === 'TASK_STORE_FAILED') {
        return {
          prompt: '业务已结束，只需保存原记录',
          primaryButton: { label: '补存执行记录', action: 'save-record-only' },
          secondaryButton: null,
        };
      }
      return {
        prompt: getErrorPrompt(currentStep.error),
        primaryButton: { label: '重试', action: 'retry-step' },
        secondaryButton: { label: '查看详情', action: 'expand-error' },
      };
      
    case 'completed':
      if (syncRecord.status === 'completed') {
        return {
          prompt: `同步完成：v${syncRecord.source.tag} 已接收`,
          primaryButton: { label: '查看下一笔更新', action: 'check-next' },
          secondaryButton: null,
        };
      }
      // 当前步骤完成，但同步未结束
      return {
        prompt: '当前步骤已完成',
        primaryButton: { label: '继续下一步', action: 'next-step' },
        secondaryButton: null,
      };
  }
}
```

## 6. "尚未选择目标"状态的澄清

原方案第 6 节提到"尚未选择目标 → 选择本次要接收的版本或 PR"，但这与第 4.1 节的"确认同步范围"有重叠。建议明确两个不同场景：

### 6.1 场景A：首次同步（空白状态）

```text
┌─────────────────────────────────────────────┐
│ clowder-ai 仓库同步                          │
│ 外部：github.com/zts212653/clowder-ai       │
│ 内部：internal.example.com/team/clowder     │
│                                             │
│ 当前状态：尚未开始任何同步                   │
│                                             │
│ 外部最新版本：v2.4.0                         │
│ 扫描于：2026-10-14 10:30 (30分钟前)         │
│                                             │
│           [开始第一次同步]                    │
│                                             │
│ 提示：首次同步需要确认外部 U0 和内部 I0 的对应关系 │
└─────────────────────────────────────────────┘
```

点击"开始第一次同步" → 进入仓库接管向导（原方案 3.4 节）

### 6.2 场景B：已有历史，选择下一笔（选择目标）

```text
┌─────────────┬────────────────────────────┐
│ 同步记录    │ 选择要同步的版本            │
│             │                            │
│ ○ v2.4 (新) │ ✓ v2.4.0                   │ ← 可选择
│   未开始    │   外部：c2f84d91 (+23文件)  │
│             │   基于：v2.3 (a17e9b40)    │
│ ✓ v2.3      │                            │
│   已完成    │   [选择此版本]              │
│             │                            │
│ ✓ v2.2      │ ○ v2.3.1 (跳过)            │
│   已完成    │   ...                      │
└─────────────┴────────────────────────────┘
```

点击"选择此版本" → 进入"① 确认同步范围"（查看这笔同步会改什么）

**区别**：
- **选择**：从列表中选一个目标（可能跳过某些版本）
- **确认范围**：查看选中目标的具体变更内容、文件列表、commit范围

## 7. 验收标准的可操作化

原方案第 7 节的验收标准很好，建议补充**具体的可观察行为指标**：

| 场景 | 原验收重点 | 补充：可观察行为 | 测试方法 |
|------|-----------|----------------|---------|
| 版本更新遇冲突 | 不寻找另一个任务窗口 | **计时**：从看到 × 到找到"处理冲突"按钮 < 3秒 | 录屏+秒表 |
| PR已自动创建 | 返回位置明确 | **点击次数**：从平台返回到看到核验按钮 = 1次点击 | 记录操作序列 |
| 记录保存失败 | 业务状态与记录状态分开 | **文案准确性**：显示"代码已接收，记录待保存"而非"同步失败" | 截图对比 |
| 回看历史 | 读取所选记录 | **准确性**：刷新页面后仍停留在选中的历史记录 | 浏览器刷新测试 |
| 执行期间查看历史 | 不强行跳回当前任务 | **保持选择**：查看历史期间，当前同步完成不自动切换视图 | 并发操作测试 |
| 长页面操作 | 主按钮始终可见 | **滚动测试**：滚动到页面任意位置，操作栏仍在视口内 | 不同屏幕高度测试 |
| 移动端使用 | 无横向溢出 | **视觉检查**：390px宽度下无横向滚动条 | Chrome DevTools模拟 |
| 失败后重试 | 时间与尝试可见 | **显示完整性**：显示"第1次失败(14:35:20)、第2次成功(14:36:10)" | 故障注入测试 |

### 7.1 可用性测试检查清单

在正式实施前，用静态原型进行测试：

**测试准备**：
- 招募2-3个未参与设计的人（不熟悉repo-sync的开发者）
- 准备4个典型场景的静态原型（可点击HTML或Figma）
- 准备秒表、录屏工具

**测试任务**：
1. "请开始一次版本同步" → 观察是否找到入口
2. "同步遇到文件冲突，请解决" → 计时从看到错误到找到处理按钮
3. "PR已创建，请去平台审核，然后回来核验" → 记录点击次数和是否找到返回位置
4. "查看上个月v2.2的同步详情" → 观察是否能找到并正确展示

**成功标准**：
- 任务1：100%的人能在10秒内找到入口
- 任务2：平均 < 3秒找到"处理冲突"按钮
- 任务3：无人点错按钮或找不到返回路径
- 任务4：无人误以为看到的是当前配置

## 8. 实施顺序的调整建议

原方案第 8 节的实施顺序合理，建议在第2步和第3步之间**插入原型验证**：

```text
步骤 1：确定页面结构、五个大步骤、状态操作文案
        └─ 输出：详细的步骤定义表格、状态机图

步骤 2：制作低保真交互稿
        └─ 输出：Figma线框图或手绘草图

   ↓ 【新增】

步骤 2.5：用静态HTML + 假数据做可点击原型
          ├─ 不需要真实后端，只需模拟交互流程
          ├─ 找2-3个未参与设计的人试用
          ├─ 记录他们在哪里卡住、点错什么
          ├─ 验证"3秒找到按钮"等可观察行为
          └─ 输出：可用性测试报告、待修正问题清单

   ↓

步骤 3：补齐记录关联（基于原型反馈调整数据模型）
        ├─ Phase 1：最小可行历史记录（扁平结构）
        └─ Phase 2：完整四层关联（渐进补齐）

步骤 4：统一当前与历史的流程详情
        └─ 实施策略：通过feature flag切换新旧UI

步骤 5：落实固定操作区域、选择保持、刷新恢复

步骤 6：按旅程开展交互验证
        └─ 保留现有 113 项测试 + 8 个浏览器脚本
```

**原因**：从 PR #77 的 VALIDATION.md 看，已有大量执行正确性测试，但用户反馈"经常要找半天按钮"，说明**可用性测试不足**。在写代码前先用原型验证交互，投入产出比最高。

## 9. 与现有代码的兼容策略

最关键的问题：**如何在不破坏现有 113 项测试的前提下实施这些改进？**

### 9.1 渐进式重构策略

**Phase 1：视图层改造（不动数据模型）**

```javascript
// 保持现有逻辑不变
// binding.mjs, delivery.mjs, tasks.mjs 等不改动

// 新建统一流程渲染器
// packages/repo-sync/src/render-unified-flow.mjs
export function renderUnifiedFlow(state) {
  return `
    <div class="unified-layout">
      <aside class="record-list">
        ${renderRecordList(state.deliveries, state.active)}
      </aside>
      <main class="flow-detail">
        ${renderFlowSteps(state.active)}
        ${renderActionBar(state.active)}
      </main>
    </div>
  `;
}

// 通过 feature flag 切换
// packages/repo-sync/src/app.mjs
const USE_NEW_UI = process.env.REPO_SYNC_NEW_UI === 'true';

function render() {
  if (USE_NEW_UI) {
    return renderUnifiedFlow(state);
  }
  return renderLegacyFlow(state);  // 旧版本保留
}
```

**Phase 2：数据层补齐（增量添加）**

```javascript
// 新建历史记录模块
// packages/repo-sync/src/sync-record.mjs
export function saveSyncRecord(delivery, tasks, config) {
  const record = {
    id: delivery.id,
    mode: config.mode,
    source: extractSource(delivery),
    baseline: extractBaseline(config),
    result: extractResult(delivery),
    startTime: delivery.startTime,
    endTime: delivery.endTime,
    status: delivery.status,
    steps: mapTasksToSteps(tasks),
    configSnapshot: extractConfigSnapshot(config),
  };
  
  // 保存到独立文件
  const recordPath = path.join(
    config.stateDir, 
    'history', 
    `${record.id}.json`
  );
  atomicWriteFile(recordPath, JSON.stringify(record, null, 2));
}

// 读取时兼容旧数据
export function loadSyncRecord(id, config) {
  const recordPath = path.join(config.stateDir, 'history', `${id}.json`);
  
  if (!fs.existsSync(recordPath)) {
    // 旧数据：从 delivery + tasks 重建
    return rebuildFromLegacyData(id, config);
  }
  
  return JSON.parse(fs.readFileSync(recordPath, 'utf-8'));
}
```

**Phase 3：清理旧代码**

```javascript
// 所有测试和浏览器脚本迁移到新UI后
// 删除旧渲染代码
// - 删除 render-overview.mjs 的旧实现
// - 删除 render-task.mjs 的独立任务面板
// - 删除 USE_NEW_UI feature flag
// - 统一数据模型，移除兼容层
```

### 9.2 测试迁移计划

```javascript
// 在迁移期间，同时运行两套测试

// test/unified-flow.test.mjs (新测试)
describe('Unified Flow UI', () => {
  before(() => {
    process.env.REPO_SYNC_NEW_UI = 'true';
  });
  
  it('should display steps in vertical timeline', () => {
    // 测试新UI
  });
});

// test/legacy-flow.test.mjs (保留旧测试)
describe('Legacy Flow UI', () => {
  before(() => {
    process.env.REPO_SYNC_NEW_UI = 'false';
  });
  
  it('should display steps as before', () => {
    // 旧测试继续通过
  });
});

// 浏览器脚本也分两版本
// test/browser-check-new-ui.mjs
// test/browser-check-legacy.mjs

// 当新UI的测试覆盖率达到100%，且所有测试通过时
// 删除 legacy 测试和代码
```

### 9.3 风险控制

| 风险 | 缓解措施 |
|------|---------|
| 新UI破坏现有功能 | Feature flag控制，默认关闭；旧代码保留直到新UI完全验证 |
| 数据模型变更导致测试失败 | Phase 1 只改视图，不动数据；Phase 2 增量添加，兼容旧数据 |
| 浏览器脚本大量失败 | 先用1个简单场景验证新UI，通过后再迁移其余7个 |
| 性能回退 | 新旧UI都加性能测试（渲染时间、内存占用），对比基线 |
| 移动端适配问题 | 390px测试必须在合并前通过，用真实设备验证 |

## 10. 设计细节补充

### 10.1 状态图标统一规范

```text
✓  已完成（绿色 #28a745）
●  进行中（蓝色 #0066cc，带动画脉冲）
×  失败（红色 #dc3545）
○  未开始（灰色 #6c757d）
⏸  等待操作（橙色 #fd7e14）
⚠  警告（黄色 #ffc107）
```

### 10.2 时间显示规范

```text
绝对时间：14:35:20
相对时间：2分钟前
耗时：2min 15s

显示规则：
- 当天：显示时分秒（14:35:20）
- 昨天：显示"昨天 14:35"
- 本周：显示"周一 14:35"
- 更早：显示"10月12日 14:35"
- 历史详情：显示完整时间戳（2026-10-14 14:35:20）
```

### 10.3 错误信息分级

```text
【系统级错误】（红色背景）
× Git fetch 失败：network timeout
→ 建议：检查网络连接或增加 timeout 配置

【业务级错误】（黄色背景）
⚠ README.md 存在冲突
→ 需要操作：选择保留内部版本或外部版本，或手工合并

【提示信息】（蓝色背景）
ℹ 候选分支已推送，等待平台审核
→ 下一步：在内部 PR #92 完成审核后回来核验
```

### 10.4 加载与进度反馈

```text
后台任务执行中：
┌────────────────────────────┐
│ ● 正在下载外部对象          │
│ [████████░░░░] 65%         │
│ 已接收 1,234 对象 / 1,890   │
│ 解析增量：82%               │
│                            │
│ 预计还需 1 分钟             │
└────────────────────────────┘

可取消的任务：
[取消] 按钮启用

不可取消的任务：
[取消] 按钮禁用，提示"推送已发生，无法取消"
```

## 11. 总结与后续建议

### 11.1 核心建议汇总

1. **✅ 布局方案**：采用原方案的左右分栏 + 右侧垂直时间线，兼顾历史对比和流程清晰
2. **⚠️ 实施风险控制**：Phase 1 只改UI（通过feature flag），Phase 2 补数据，避免破坏现有测试
3. **🎯 验收标准具体化**：补充可观察行为指标（如"3秒找到按钮"），用秒表和录屏验证
4. **🧪 原型验证提前**：在步骤2和3之间插入可用性测试，用静态原型找真实用户试用
5. **📱 移动端策略明确**：详情全屏 + "返回列表"的降级方案，固定操作栏更明显
6. **📊 数据模型渐进**：先做扁平结构的最小可行版本，再补齐四层关联，避免过度设计
7. **🔧 Git自动PR准确表达**：明确标注"1次push完成推送+创建"，避免误导用户

### 11.2 最重要的三件事

如果资源有限，优先做这三件事：

**P0 - 原型验证（1-2天）**
- 用静态HTML做可点击原型
- 找2-3个新用户试用4个典型场景
- 记录卡点和点击时长
- → 输出：可用性测试报告

**P1 - 视图层统一（1-2周）**
- 实现左右分栏 + 垂直时间线
- 通过feature flag切换新旧UI
- 确保旧测试继续通过
- → 输出：新UI可选用，旧UI保留

**P2 - 历史记录补齐（1周）**
- 实现Phase 1的扁平历史记录
- 支持"查看上个月版本"场景
- 兼容旧数据读取
- → 输出：历史可回看，配置可追溯

### 11.3 下一步行动

建议按以下顺序推进：

1. **本周**：完成可点击原型，邀请用户测试
2. **下周**：根据测试反馈调整设计，启动Phase 1实施
3. **两周后**：新UI通过基本验证，开始迁移浏览器脚本
4. **一个月后**：Phase 1完成，启动Phase 2（数据补齐）

### 11.4 成功标准

本轮优化达到以下目标即可视为成功：

- ✅ 用户能在3秒内找到下一步按钮（从"找半天"到"立刻找到"）
- ✅ 历史记录可点击查看详情，包含版本对应、时间节点、配置快照
- ✅ 子步骤与执行记录在同一流程中展示，不需要切换窗口
- ✅ 现有 113 项测试全部通过，无回归
- ✅ 8 个浏览器脚本迁移到新UI，全部通过

## 12. 参考文档

- [用户旅程优化方案（原方案）](./2026-10-14-repo-sync-user-journey-optimization.md)
- [PR #77 - 独立双模式Git同步插件](https://github.com/zts212653/clowder-ai-plugins/pull/77)
- [VALIDATION.md - 113项测试和8个浏览器脚本](../../packages/repo-sync/VALIDATION.md)
- [场景与恢复边界排查](./2026-10-14-repo-sync-scenario-audit.md)

---

**编写说明**：本文件是对原优化方案的设计复审，不替代原方案。两份文档应配合阅读：原方案定义"做什么"，本复审补充"怎么做"和"如何验证"。实施时以原方案的业务目标为准，采纳本复审中适用的技术建议。
