---
feature_ids: [F202]
topics: [plugins, development]
doc_kind: guide
created: 2026-10-17
---

# 插件开发：官方仓、独立项目与团队仓

官方插件和第三方插件都通过公开插件契约接入 Host。SDK 是可选的开发依赖和运行辅助库；选择 SDK 时，通过 `package.json` 依赖与包名 import 使用，不复制 SDK 源码，也不导入 Host 内部实现。

## 选开发位置

| 场景 | 源码与依赖 | 安装验证 |
| --- | --- | --- |
| 官方插件 | 本仓 `packages/<目录>`；每包有独立声明、依赖和构建 | 构建具体包后从本地目录安装；发布制品另做验证 |
| 独立插件项目 | 自己的项目根；按需依赖已发布的 SDK | 构建后直接选择项目根目录安装 |
| 团队 Git 插件仓 | `packages/<目录>` 多包布局、pnpm workspace 与锁文件；可引用 npm SDK | Hub 添加仓库地址和分支，发现插件后选择安装 |

开发者不必为了安装测试先发布插件。SDK、插件包版本和 manifest 的 `contractVersion` 是三个不同坐标；使用目标 Host 实际支持的声明与能力。

## 官方仓怎样使用 SDK

本仓同时维护 `packages/plugin-contract`、`packages/plugin-sdk` 和插件。插件声明运行依赖，再从公开包入口导入，例如：

```js
import { definePlugin } from '@clowder-ai/plugin-sdk';
```

使用哪个 helper，以所选版本实际导出的 API 为准。当前源码里的新 helper 不一定存在于已发布旧版本。插件的 ESM module 运行入口也不是“把 SDK 的某个源码模块集成进 Host”：Host 加载的是插件声明的入口，SDK 是这个插件的依赖。

仓根使用 pnpm workspace，并开启 `link-workspace-packages`。这种链接便于 SDK 与消费者一起开发，但不能证明最终安装会消费同一版本。插件通过其 package.json 声明所需的 Contract／SDK 版本。当前 workspace 与最终安装版本必须分别核对。

修改普通插件时保留其 SDK 约束。只有确实需要新 API 时，才单独处理依赖升级与兼容性验证；不要为了安装成功就把所有包改成最新 SDK。使用 `--ignore-scripts` 安装依赖时不会构建插件；安装验证前应显式执行包的 build，并核对最终制品的依赖闭包。

## 独立项目怎样使用 SDK

在项目中安装一个**已经发布、可获取且验证过**的精确版本：

```bash
npm install --save-exact @clowder-ai/plugin-sdk@<已验证版本>
```

将占位符替换为实际版本；也可使用 pnpm。SDK 若在运行入口被导入，应放 `dependencies`，构建工具放 `devDependencies`，并提交锁文件。内网可通过自己的 npm 镜像提供依赖，不要求将业务插件发布到公网。

不使用 SDK 也可以：按公开契约实现运行入口并提供合法声明。最小 ESM module 形状如下，它不提供业务工具：

```js
export default {
  create(manifest) {
    return {
      async start(host) {
        host.log('info', 'plugin started', { pluginId: manifest.pluginId });
        return {
          actions: {},
          async stop() {
            // 释放本次启用创建的连接、定时器和订阅。
          },
        };
      },
    };
  },
};
```

对应 manifest 使用 `runtime.transport: builtin` 与 `runtime.entrypoint: dist/index.js`。这里的 builtin 是 module 载体类型，不是官方身份或自动授权。其他载体遵循各自契约，不套用此模板。

## 一个插件需要提交什么

```text
packages/my-plugin/       # 独立项目也可直接放在项目根
├── package.json          # 包名、版本、依赖、build、files
├── plugin.yaml           # 身份、版本、运行入口与实际能力
├── README.md             # 中文默认：用途、维护者、配置、开发与验证方法
├── README.en.md          # 本仓用户可见插件：独立英文说明
├── src/                  # 实现
└── dist/                 # 构建产物；须被最终安装制品包含
```

- `pluginId` 是稳定身份；升级保持不变。`plugin.yaml.version` 与 `package.json.version` 保持一致。
- `plugin.yaml` 只写对应 Contract 支持的字段。管理信息放 README 或 package.json 标准字段，不自造 manifest 属性。
- `package.json.files` 包含声明、编译入口、资源和实际需要的文件；本地工作区能运行不能代替打包后验证。
- 功能、配置、引导和操作只声明实际需要的内容；公开接口经既有 SDK、实例与调用上下文使用。
- README 写明支持范围、维护方式、构建命令、验证过的 Host/SDK 与升级注意事项。

### 描述与 README 的语言

插件只有一份 `plugin.yaml`、一个稳定 pluginId、一套版本和能力声明，不按语言复制插件。简短描述继续使用现有 `description.default` 与 `description.translations`：当前默认说明用中文，英文可放在 `translations.en`，已有 `translations.zh-CN` 可保留。这不是完整使用说明，也不引入语言配置。

完整说明并列放在同一包中：`README.md` 是当前中文默认文档，`README.en.md` 是英文平行版，两份互相链接。当前系统没有语言设置，Host 继续读取 `README.md`；不新增 locale 参数、query 或 Accept-Language 协商，也不宣称会自动选择译文。未来真正引入系统语言设置时，再单独设计和验证文档选择能力。

将语言文档明确列入 `package.json.files`（也可使用 `README*.md`），并检查实际 tarball 同时包含默认文档和译文；文件只在源码目录里不算交付。用户可见插件的默认 README 应完整使用中文叙述，英文版独立使用英文叙述；技术标识、产品名和界面标签保持准确。不要在同一份使用说明里插入另一种语言的迁移补记。源码搬迁记录、测试账本和发布协调记录保留在 Git 历史或仓外核验材料，不放入现行使用与开发指南。SDK、Contract 等开发者包按读者语境维护，不机械套用安装者模板。各语言应说明同一套实际功能、配置、隐私边界及未验证范围，不能一份宣称可用、另一份还写待实现。README 说明实际功能、配置与业务授权边界，不建立逐插件 SDK API 权限清单。安装来源由官方仓审核或用户团队治理；实例与调用身份使用已有 SDK 上下文。维护者、安装与开发说明放 README，不把内部路由 ID 当成用户要逐项配置的功能。

团队 Git 仓在根目录维护 `pnpm-workspace.yaml`（`packages/*`）、`private: true` 的 package.json 和匹配的 `pnpm-lock.yaml`。当前 Host 读取一级 `packages/<slug>/plugin.yaml` 与 package.json，目录名使用小写字母、数字和短横线。发现阶段只读声明；选择安装后才执行冻结锁文件安装和目标包构建。因此源码、锁文件与构建脚本必须足以在干净克隆里工作。

## 日常开发与提交

官方仓按 [.nvmrc](../.nvmrc) 和 [CONTRIBUTING](../CONTRIBUTING.md) 配置工具链，安装依赖后运行具体包声明的 typecheck、test、build。如同时改 SDK/Contract，按依赖顺序构建并验证实际消费者；不要通过相对源码路径绕过包边界。

构建后在 Hub 选择「从本地目录安装」，选含 plugin.yaml 与 package.json 的具体插件根目录。至少验证：发现/名称版本、安装、配置保存、启用实际功能、禁用后停止、重新启用；修改同一 pluginId 的版本并重装，核配置与数据保留。源码修改不会热更新已经安装的制品。

提交 PR 时说明实际变动、版本与依赖、配置要求、安装测试结果及剩余限制。官方仓的发布与审查门禁仍以 [CONTRIBUTING](../CONTRIBUTING.md) 为准。

### 验证归档与安装者说明

用仓库的规范 packer 生成 npm 候选归档；若安装路径需要带生产依赖的独立本地归档，先将规范归档放入名为 `f202-w1-tarballs` 的目录并创建其 `self-contained` 子目录，再调用对应脚本。例如：

```bash
mkdir -p /absolute/output/f202-w1-tarballs/self-contained
node scripts/pack-publish-artifact.mjs packages/enterprise-workflow /absolute/output/f202-w1-tarballs
node scripts/pack-self-contained-artifact.mjs packages/enterprise-workflow /absolute/output/f202-w1-tarballs
```

这两个命令生成不同用途的本地制品，不执行 npm 发布。独立打包脚本使用当前工作区的 Contract／SDK 字节，并验证重定位后的声明入口。交付时记录准确文件、完整 SHA-256 和包的版本，不能仅凭路径或源码可用判断已安装。

声明生产依赖的插件必须提供发布者维护的 `npm-shrinkwrap.json`，或由规范打包流程完整内置依赖；私有模块和编辑器插件也遵守这一安装边界。尚未发布 SDK／Contract 的候选需由作者交付含实体依赖的独立归档，不能要求安装者手工拼依赖。独立归档与 npm 规范归档具有不同摘要，均应列入候选矩阵。源码旁的依赖、空消费者额外安装的核心包和测试软链接不证明归档可直接安装；须用交付的闭包验证真实 Host 的设置、启动和恢复。

检查实际归档中的 `README.md`、`README.en.md` 与对应源码逐字一致，声明、资源和生产依赖均存在。运行 `pnpm test:package-inventory` 检查当前包声明、双语说明和目录／发布接线；空消费者再验证实际依赖与导出。涉及打包字节的变动仍须同步目录摘要。真实账号、浏览器、原生辅助进程和 Host 安装／启停旅程需要分别验证，不能由模拟宿主或归档导入替代。

### 源码目录安装的核验边界

源码目录、规范 npm 归档和带依赖的 prepared 目录是不同输入，必须分别通过实际安装入口验证。检查所有声明的 runtime 与 contribution 入口、静态资源和精确生产依赖，不能只看主入口或工作区链接；编译成功也不表示安装后的依赖可解析。准备过程保留来源和摘要、确认前后的输入校验及文件／符号链接检查，不靠放宽资源限制或按插件 ID 特判通过。

生命周期核验覆盖启动中途失败后的资源回收、重试、停用和重新启用，并区分配置、认证、启用意图与实际运行。组件或空消费者测试证明其覆盖的边界，真实 Host 安装、账号授权与实际功能仍由相应旅程证明。

### 版本与兼容性

SDK 包版本是插件携带的库版本，Host 产品版本不能替代这个依赖坐标。目录安装按插件声明的精确版本或 semver range 校对实际依赖与锁文件；不能用当前工作区的 SDK 冒充旧版本。兼容性验证须包含旧插件在新 Host 上的安装及相关操作，而不只验证一起升级的组合。

维护线承诺兼容的公开接口及行为应继续保留。废弃需先标记 `deprecated`，提供替代方式、迁移说明和跨版本窗口；经过若干版本不自动获得删除权。真正移除须进入明确的破坏性版本并说明迁移边界，不能用早期开发阶段的 breaking 说明推翻已作出的兼容承诺。

## Git 仓更新与 npm 发布

扩展 Git 仓按地址和分支克隆，读取包声明并按目录策略安装，不需要维护官方 npm catalog，也不要求发布业务包到 npm。仓库更新只刷新可安装列表，不自动升级已安装插件。

官方发布目录 `catalog/catalog.json` 只激活已可从 npm 获取且摘要匹配的版本；源码候选及其准确制品坐标在 `catalog/candidate.json`，不直接用于 Host 发现。两者与 Git 源码目录发现是不同交付路径。新增官方发布包还须检查发布 workflow 是否包含该包。涉及打包字节的变动按贡献说明中的固定工具链重生成候选哈希。

发布使用普通分步流程：

1. 合入源码与候选坐标，保留当前 live catalog。main push 通过验证后按现有 workflow 发布包。
2. 确认本批插件、SDK 和 Contract 已发布，再运行 `pnpm catalog:activate`。该命令重新检查候选字节、当前发布清单、实际可下载的归档及摘要，然后在本地准备 `catalog/catalog.json` 更新；不执行 npm 发布、Git push 或 merge。任一步失败，live 文件不变，可修复发布后重试。
   如果共享候选还包含无关的待发布版本，而一个自包含插件已经独立审查并发布，可运行 `pnpm catalog:activate:plugin -- <pluginId>`。scoped 路径只推进该插件并验证其 registry 身份与归档字节，保留其他 live 行和 staged 候选；它不会执行整批 Contract、SDK 与插件发布对账，因此不得用于依赖尚未发布核心包的制品。
3. 通过普通 PR 审阅并合入目录更新，与对应 C1 Host 版本一同交付。`pnpm catalog:live-check` 验证目录实际选择的最高版本可获取且摘要匹配；历史版本行保留不可变出处，不要求补发从未发布的旧候选。

发布操作者负责把本批推进到目录 PR 合入，或明确交接给下一位负责人并附 PR／阻塞原因；npm 上传成功不能作为这条责任的终点。发布 job 最后运行 `pnpm catalog:activation-check`：候选最高版本未进入 live，或远端归档不可获取／摘要不符时失败。这个失败可能表示包发布已成功、目录仍待审阅，不应因此重发或改写 npm 版本。正常源码 PR 的 CI 不要求提前激活未发布候选。

手工 npm 发布不会触发 main push，因此独立的 **Catalog Activation Audit** 每日及手动运行同一只读检查。手工恢复发布后，发布操作者应立即触发该 audit，接续激活 PR；不等下一日扫描。检查不发布包、不写 catalog、不推送、不合入。只有目录合入且该检查通过，才可报告官方目录上架完成。32 份 C1 候选归档包含核心库与安装闭包，本次官方目录对应其中 17 个插件，并非 32 个可安装目录条目。

包发布暂停或部分失败时继续保留原目录，不需要按时间协调切换或维持两代 Host 的兼容通道。目录检查不能代替新 Host 与新插件的实际安装、更新、失败恢复及用户数据／安装／配置身份连续性验证。

`pnpm pack:gate`、`pnpm catalog:check` 等检查服务于制品与目录一致性；真实 Host 安装、启停和业务操作仍要验证。仓内未发布的 SDK 或插件候选不能写成已可从 npm 安装。
