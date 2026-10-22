# 插件模式化配置契约设计 v2（configurationVariants）

日期：2026-10-21
状态：**已实现的 contract 0.2.0 候选设计，待上游审阅与发布；不是已发布版本声明。**

实现与审阅：[插件 PR #101](https://github.com/zts212653/clowder-ai-plugins/pull/101)、[Host 集成 PR #1660](https://github.com/zts212653/clowder-ai/pull/1660)。依赖闭包兼容已在 [PR #105](https://github.com/zts212653/clowder-ai-plugins/pull/105) 独立交付。当前声明以 [Feishu manifest](../../packages/connector-feishu/plugin.yaml)、[video-generation manifest](../../packages/video-generation/plugin.yaml) 和各包 package.json 为准；候选摘要见[发布清单](../../review-notes/2026-10-21-catalog-release-manifest.md)。

配套：[Host 集成指南](../host-implementation-brief.md)与[可复现验收步骤](../../review-notes/2026-10-21-experience-acceptance-prep.md)。

## 1. 问题与目标

插件交给 Host 一张平铺字段表，只能表达"何时必填"（`requiredWhen`），无法表达"当前选择的是哪套配置"。飞书 Verification Token（webhook 模式必填、websocket 模式不存在）与 video-generation 的三模式凭据是同一类问题。显示、保存、就绪、运行四处各自猜测，必然分叉。

设计目标：用**标准 JSON Schema 组合结构**表达模式单选，Host 通用解释，四条消费路径（表单 / 保存+就绪 / 运行时投影 / declared MCP）消费**同一份解析结果**。

## 2. 契约形状（plugin-contract，新 contractVersion `0.2.0`）

### 2.1 字段表保持平铺，新增 `configurationVariants`

字段定义只维护一份，仍在顶层 `configuration` 中；分支只**引用**字段 key，不内联字段定义、不覆写 label/description。

```yaml
contractVersion: 0.2.0
configuration:
  - key: appId            # 公共字段
    kind: string
    required: true
  - key: connectionMode   # discriminator：普通 select，无 secret
    kind: select
    required: true
    options: [{ value: webhook }, { value: websocket }]
  - key: verificationToken
    kind: secret
    required: true        # 仅在该字段所属分支活跃时要求填写
configurationVariants:
  discriminator: connectionMode
  branches:
    - id: webhook
      when:
        properties:
          connectionMode: { const: webhook }
      fields: [verificationToken]
    - id: websocket
      when:
        properties:
          connectionMode: { const: websocket }
      fields: []
```

### 2.2 `when` 是标准 JSON Schema 片段，但受约束

- `when` 原样是 JSON Schema（`properties` + `const`/`enum`），**服务端装配**时把它组合进标准 `oneOf` 校验有效配置对象：

```json
{
  "type": "object",
  "oneOf": [
    { "properties": { "connectionMode": { "const": "webhook" } },
      "required": ["connectionMode", "verificationToken"] },
    { "properties": { "connectionMode": { "const": "websocket" } },
      "required": ["connectionMode"] }
  ]
}
```

  **必填性只有一个来源：字段自己的 `required`／`requiredWhen`。** 分支 `fields` 只决定字段是否适用（applicability），不隐含必填。装配出的标准 schema 由**契约包拥有并生成**（`buildVariantValidationSchema(manifest)`），Host 只消费、不各自实现；完整校验不只有 `required`——string/secret 字段要求非空且含非空白字符，URL 字段使用标准 URI 格式；键存在但值为空不算配置齐全，secret 原字节不被 trim。

- 契约语义校验（`validation/manifest.ts`）对 `when` 施加**结构化约束**，使其只承担"模式单选"，而不是任意 JSON Schema：
  1. `when.properties` 只允许出现 discriminator 这一个 key；
  2. discriminator 的约束只允许 `const`（单值）或 `enum`（值列表），且每个值必须是该 select 字段**已声明的 option**；
  3. 每个 option 值**恰被一个分支命中**（完备 + 互斥）。用 ajv 对每个 option 值逐分支试算 `when` 得出结论，不靠字符串比对。
- 明确边界：我们支持的是"可明确选出分支的模式表单"，**不是**支持任意 JSON Schema 自动生成界面。跨字段条件（"mode=webhook 且开启加密"）、无判别字段的"至少填一组"（真正的 anyOf），本期不做；条件模型演进时接到同一入口。

### 2.3 `fields` 声明字段适用性

- `fields: string[]` 引用顶层 `configuration` 已声明的 key，契约校验引用存在性。
- **一个字段可以属于多个分支**（分支互斥不要求字段集合互斥）。video-generation 的 accessKey/secretKey 同时属于 jwt 与 hmac 分支即合法用例。
- 分支不覆写字段的 label/description/kind——展示定义单一来源。
- `fields` 不只是表单元数据：它决定运行时有效配置包含哪些字段，是领域语义。

### 2.4 三态解析：`resolveConfigurationVariant`

plugin-contract 新增**纯函数、浏览器安全**的子路径导出（如 `@clowder-ai/plugin-contract/variant`）：

```ts
type VariantResolution =
  | { status: 'selected'; branchId: string }
  | { status: 'unselected' }            // discriminator 无值
  | { status: 'invalid'; value: unknown } // 有值但不匹配任何分支 when
```

- 实现只做 `const`/`enum` 等值匹配，**不依赖 ajv / Node validator**，浏览器与服务器共用同一份代码。
- 主包入口（含 ajv 的校验器）不进入浏览器依赖图；子路径独立导出。

契约包同时拥有并导出（同一子路径或主路径，均不依赖 Node）：

- `computeEffectiveConfiguration(manifest, storedValues)`：先跑三态解析，再产出**有效配置**——公共字段 + 当前分支字段的值；**无存值时所有消费者统一使用字段声明的 `default`**（不等"保存时物化"）；**stored 有非法值时不回退任何值**；保留的非活跃分支旧值**不参与**有效配置与就绪判断。返回 `{ resolution, effectiveValues }`。
- `buildVariantValidationSchema(manifest)`：把受约束的 `when` 编译成标准 JSON Schema（`{type:'object', oneOf:[...]}`，active 必填字段带 `minLength: 1`），供 ajv 校验**统一计算出的有效配置对象**，而不是直接校验原始 stored 对象。

### 2.5 无有效模式时的行为（统一规则）

| 场景 | 行为 |
|---|---|
| 设置页 | 仍显示公共字段 + discriminator 选择器，让用户修正；不显示任何分支字段 |
| 就绪检查 | 返回未就绪 |
| 运行时 | 拒绝启动（fail-closed） |
| stored 无 discriminator 值 | 所有消费者统一使用字段声明的 `default`（`computeEffectiveConfiguration` 内应用，不依赖保存时物化） |
| stored 有非法值 | **不得悄悄回退 default**；不回退任何值 |
| 隐式默认 | **禁止**把 select 第一项当作隐式默认 |

分支内选填：直接写 `required: false`（或 `requiredWhen`），**不引入新开关**——必填性永远只有 `required`/`requiredWhen` 一个来源。

## 3. 四条消费路径消费同一模型

### 3.1 设置页表单（web）

web 不自行解释分支，调用 §2.4 的同一个纯函数，输入为**已存配置的安全投影**（secret 字段掩码或仅给 mode 字段的真实值——判别字段都是普通 select，不含 secret，安全投影足够）**+ 当前表单草稿**。切换模式即时得到当前应显示的字段集，**无需保存、无需等服务端 `activeNow`**。逐字段校验（格式/必填）在同一草稿上本地即时反馈；最终权威校验仍在保存时由服务端完成。

### 3.2 保存与就绪（api）

- 保存：API 接受对已声明字段的**显式更新**并做格式校验；普通表单只提交当前活跃分支字段的修改，**其余草稿字段原样保留**；discriminator 与该分支字段**一次保存**（同一次请求内完成装配校验）。非活跃分支的已存值**保留在存储中**，不删除。
- 就绪：`requiredFieldsReady` 等就绪判断消费契约包 `computeEffectiveConfiguration` + `buildVariantValidationSchema`：有效配置对象整体通过标准 oneOf 且公共必填字段齐全 ⇒ 就绪。`unselected`/`invalid` ⇒ 未就绪。保留的非活跃旧值不参与就绪判断。
- operation 字段（kind: operation）的 `configured` 语义**不变**：仍是"该 operation 全部 target 是否已有值"，不感知分支、不过滤 target；空 target 集合不视为成功。

### 3.3 运行时投影（module / external runtime）

`resolveManifestConfiguration`（`packages/api/src/domains/plugin/.../manifest-configuration-projection.ts`）已同时服务 in-process 与 external runtime 两条路径。扩展为：先跑 `computeEffectiveConfiguration`，`selected` ⇒ 只投递有效配置的值（非活跃分支的已存值不投递）；`unselected`/`invalid` ⇒ fail-closed 拒绝启动。无 `configurationVariants` 的插件走原路径，行为逐字节不变。

**module 的实际 getter 也必须走同一规则。** 若 `config.get/secrets.get` 绕过有效配置而直读存储，WebSocket 模式便可能读到非活跃 Token。集成要求：**运行中的插件 getter 消费 `computeEffectiveConfiguration` 的结果**；同时区分用途——settings/dormant host 还服务扫码配置（operation action）与卸载，**管理性读取不得因"尚未选择模式"而不可用**（unselected/invalid 时管理读取按存储原值放行，仅运行时读取 fail-closed）；grant 检查（`plugin.config.read`/`secret.read`）保持不变。验收必须观察插件真实调用 getter 的返回值，不能只测启动解析器。

### 3.4 declared MCP 环境变量

`declared-mcp-resources.ts` 的 `mcpEnvironment`/`environmentValue` 若独立读 `contribution.environment` 并直接查 `field.required`，**绕过运行时配置解析**——仅改 `required: true` 会让 apikey 模式因缺 Access/Secret Key 启动失败，旧值又会把非活跃凭据传进 MCP 进程。

集成方式：declared MCP 绑定映射前**先消费 §3.3 同一份有效配置解析结果**，再做环境变量映射：

- binding 指向的字段在**当前活跃分支**（或是公共字段）⇒ 保留现有 grant + required 语义，从有效配置取值投递；
- binding 指向**非活跃分支字段** ⇒ **不投递该 env 项**（不报错、不要求 grant）；
- `unselected`/`invalid` ⇒ 拒绝启动 MCP contribution。

验收必须覆盖 module、external runtime、declared MCP 三条路径，各自权限边界（grant、secret.read）保持现状。

## 4. 插件实例

完整声明直接参见 [connector-feishu/plugin.yaml](../../packages/connector-feishu/plugin.yaml) 与 [video-generation/plugin.yaml](../../packages/video-generation/plugin.yaml)，避免文档副本与候选版本漂移。

- Feishu：`connectionMode` 默认 `webhook`；Webhook 分支包含必填的 `verificationToken`，WebSocket 分支不包含它。公共 `appId`/`appSecret` 始终必填。分支仅决定字段适用性，必填性仍由字段的 `required`/`requiredWhen` 决定。
- Feishu 在 WebSocket 模式下沿用已有 webhook 跳过行为，不增加 contribution 条件引擎。
- Video-generation：`authType=apikey` 使用 `apiKey`；`jwt-hs256` 与 `hmac-sha256-v4` 共用 `accessKey`/`secretKey`。字段跨互斥分支共享是合法的；环境变量映射保留，实际投递按有效字段过滤。
- HTTP/HTTPS endpoint 支持属于视频插件的请求行为；通用 URL 字段只提供标准 URI 语法校验，不引入统一 HTTPS-only 政策。

## 5. 两条关键数据流

### 5.1 未保存切换模式（设置页）

```
用户把 connectionMode 从 websocket 切到 webhook（尚未点保存）
  │
  ├─ web 本地调用 resolveConfigurationVariant(manifest,
  │     stored 安全投影 + { ...草稿, connectionMode: webhook })
  │     → { status: 'selected', branchId: 'webhook' }
  │
  ├─ 表单立即渲染公共字段 + verificationToken 输入框
  │   （本地同一草稿上做必填/格式即时反馈）
  │
  └─ 用户填 Token 点保存
        → 一次请求提交 { connectionMode: webhook, verificationToken: *** }
        → 服务端 computeEffectiveConfiguration + buildVariantValidationSchema
          校验统一计算出的有效配置对象
        → 保存成功；切回 websocket 时 Token 仍留存于存储，
          表单与运行时均不显示/不投递，再切回 webhook 恢复生效
```

### 5.2 declared MCP 启动（video-generation，authType=apikey）

```
Host 启动 contribution video-generation-toolset（stdio MCP）
  │
  ├─ 跑 resolveConfigurationVariant(manifest, stored)
  │     → { status: 'selected', branchId: 'apikey' }
  │
  ├─ 有效配置 = 公共字段 + apiKey 分支字段
  │
  └─ 映射 environment：
       VIDEO_GEN_PROVIDER / VIDEO_GEN_AUTH_TYPE / VIDEO_GEN_BASE_URL /
       VIDEO_GEN_MODEL / VIDEO_GEN_API_KEY → 按原 grant（config/secret）投递
       VIDEO_GEN_ACCESS_KEY / VIDEO_GEN_SECRET_KEY
         → 指向非活跃分支字段 → 不投递（不要求 secret.read grant）
```

若 stored 的 authType 非法或缺失：拒绝启动该 MCP contribution，设置页保留修复入口。

## 6. 兼容与版本

- **新 Host + 旧插件**：manifest 无 `configurationVariants` ⇒ 走原 `requiredWhen` 路径，显示/保存/就绪/运行行为逐字节不变（验收项）。
- **Host 不支持新协议时**：manifest 声明 `contractVersion: 0.2.0`，不支持该协议的 Host 应在安装时明确拒绝。当前 Host 集成使用显式兼容范围，安装与库存恢复共用同一判断；不再以旧的精确版本 allowlist 描述当前实现。
- 新能力绑定契约版本 `0.2.0` 发布，**不只靠 Host allowlist**：schema 层面 `configurationVariants` 只在 0.2.0 schema 中出现，0.1.0 manifest 携带该键即校验失败。
- `requiredWhen` 在 0.2.0 中保留原语义（只管必填），旧式插件可继续只用它。
- 版本迁移：契约包发 `0.2.0`；SDK 跟随；feishu 与 video-generation 按 §4 迁移后发新版。这是**正常发版链**，不走 hotfix。

## 7. 验收清单（贯穿真实路径）

1. 新装插件，逐模式选择 → 表单只显示对应字段；缺必填项保存被拒并指出缺项。
2. 填完保存 → 就绪；切换模式（未保存）→ 字段即时跟随；保存 → 运行时只收到当前分支值。
3. 重载页面 / 重启 Host → 状态恢复；切回旧模式 → 旧值恢复生效。
4. 插件实际收到的配置（module / external runtime / declared MCP 三条路径逐一验证）只含公共 + 当前分支字段。
5. 当前模式下分支内选填字段（`required: false`）仍可编辑、保存、投递——分支成员资格不得把选填变成必填。
6. 反例：非法/缺失 discriminator → 设置页可修复、就绪=未就绪、运行时拒绝启动、不悄悄回退 default；**default 未物化时所有消费者（表单/就绪/运行时）统一使用声明的 default**。
7. 旧插件（无 variants）在新 Host 上行为不变。
8. 不支持 0.2.0 协议的 Host 安装该声明的插件时明确拒绝。
9. **module 实际 getter**：WebSocket 模式下插件 `secrets.get('verificationToken')` 返回 undefined（观察真实 getter 调用，不只测启动解析器）；管理读取（扫码配置、卸载）在 unselected/invalid 下仍可用。
10. **飞书 webhook 跳过**：WebSocket 模式无 Token 正常启动；webhook 请求返回 `skipped: websocket_mode` 不投递消息；切回 Webhook 必须先满足 Token 必填才能就绪。

## 8. 实现边界

- `when` 是受约束的标准 JSON Schema 片段，不支持任意 JSON Schema 表单生成，也不新增多判别字段或贡献项条件引擎。
- 字段定义保持单一来源；分支可以共享字段，但不覆写 label、description 或 kind。
- 解析和 schema 生成由契约包拥有，Host 消费相同入口。保存、就绪与运行值投递不能各自推导另一套分支规则。
- `requiredWhen` 保留条件必填语义，不被偷换为字段隐藏规则；分支 `fields` 明确表示适用性。
- 无存值时使用声明默认值；非法存值不回退。运行拒绝未完成的配置，但设置与管理操作保留修复入口。
- 本文描述候选实现与验收要求，不把本地测试或旧候选摘要当成 npm 实发证明。发布状态以对应 PR、CI 与 registry 验证为准。
