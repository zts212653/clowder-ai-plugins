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

仓根使用 pnpm workspace，并开启 `link-workspace-packages`。这种链接便于 SDK 与消费者一起开发，但不能证明最终安装会消费同一版本。当前 C1 迁移包有保留旧 SDK 的目录准备步骤：根 `postinstall` 调用 `prepare-retained-directory-graphs.mjs`，按已登记的不可变归档准备其实际依赖闭包。它不是要求第三方复制的开发模板。具体版本、包清单与操作顺序见[本地目录准备](../migration/2026-10-12-f202-local-directory-preparation.md)。

修改普通插件时保留其 SDK 约束。只有确实需要新 API 时，才单独处理依赖升级与兼容性验证；不要为了安装成功就把所有包改成最新 SDK。使用 `--ignore-scripts` 安装依赖时，目录准备不会自动运行，须按上面的说明显式完成。

## 独立项目怎样使用 SDK

在项目中安装一个**已经发布、可获取且验证过**的精确版本：

```bash
npm install --save-exact @clowder-ai/plugin-sdk@<已验证版本>
```

将占位符替换为实际版本；也可使用 pnpm。SDK 若在运行入口被导入，应放 `dependencies`，构建工具放 `devDependencies`，并提交锁文件。内网可通过自己的 npm 镜像提供依赖，不要求将业务插件发布到公网。

2026-10-17 的基础安装验收使用已发布的 SDK `0.1.0-beta.25`，通过其 `definePlugin` 校验声明，完成 module 插件安装、启用、禁用及版本替换。该结果只覆盖基础生命周期，不表示旧 SDK 支持当前源码里的所有功能；这个版本没有 `definePluginModule` 导出。不要直接照抄较新源码 helper 名称后假定可用。

不使用 SDK 也可以：按公开契约实现运行入口并提供合法声明。已验证的最小 ESM module 形状如下，它不提供业务工具：

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
- 配置、权限、引导和操作只声明实际需要的内容；能力请求仍需 Host 授权。
- README 写明支持范围、维护方式、构建命令、验证过的 Host/SDK 与升级注意事项。

### 描述与 README 的语言

插件只有一份 `plugin.yaml`、一个稳定 pluginId、一套版本和能力声明，不按语言复制插件。简短描述继续使用现有 `description.default` 与 `description.translations`：当前默认说明用中文，英文可放在 `translations.en`，已有 `translations.zh-CN` 可保留。这不是完整使用说明，也不引入语言配置。

完整说明并列放在同一包中：`README.md` 是当前中文默认文档，`README.en.md` 是英文平行版，两份互相链接。当前系统没有语言设置，Host 继续读取 `README.md`；不新增 locale 参数、query 或 Accept-Language 协商，也不宣称会自动选择译文。未来真正引入系统语言设置时，再单独设计和验证文档选择能力。

将语言文档明确列入 `package.json.files`（也可使用 `README*.md`），并检查实际 tarball 同时包含默认文档和译文；文件只在源码目录里不算交付。用户可见插件的默认 README 应完整使用中文叙述，英文版独立使用英文叙述；技术标识、产品名和界面标签保持准确。不要在同一份使用说明里插入另一种语言的迁移补记。内部源码搬迁、历史 checkpoint、测试账本和发布协调记录放到开发/核验文档，不能变成安装步骤。SDK、Contract 等开发者包按读者语境维护，不机械套用安装者模板。各语言应说明同一套实际功能、配置、权限及未验证范围，不能一份宣称可用、另一份还写待实现。维护者、安装与开发说明放 README，不把内部路由 ID 当成用户要逐项配置的功能。

团队 Git 仓在根目录维护 `pnpm-workspace.yaml`（`packages/*`）、`private: true` 的 package.json 和匹配的 `pnpm-lock.yaml`。当前 Host 读取一级 `packages/<slug>/plugin.yaml` 与 package.json，目录名使用小写字母、数字和短横线。发现阶段只读声明；选择安装后才执行冻结锁文件安装和目标包构建。因此源码、锁文件与构建脚本必须足以在干净克隆里工作。

## 日常开发与提交

官方仓按 [.nvmrc](../.nvmrc) 和 [CONTRIBUTING](../CONTRIBUTING.md) 配置工具链，安装依赖后运行具体包声明的 typecheck、test、build。如同时改 SDK/Contract，按依赖顺序构建并验证实际消费者；不要通过相对源码路径绕过包边界。

构建后在 Hub 选择「从本地目录安装」，选含 plugin.yaml 与 package.json 的具体插件根目录。至少验证：发现/名称版本、安装、配置保存、启用实际功能、禁用后停止、重新启用；修改同一 pluginId 的版本并重装，核配置与数据保留。源码修改不会热更新已经安装的制品。

提交 PR 时说明实际变动、版本与依赖、所需权限、安装测试结果及剩余限制。官方仓的发布与审查门禁仍以 [CONTRIBUTING](../CONTRIBUTING.md) 为准。

## Git 仓更新与 npm 发布

扩展 Git 仓按地址和分支克隆，读取包声明并按目录策略安装，不需要维护官方 npm catalog，也不要求发布业务包到 npm。仓库更新只刷新可安装列表，不自动升级已安装插件。

官方发布目录 `catalog/catalog.json` 引用 npm 制品及其哈希，和源码目录发现是两条交付路径。新增官方发布包还须检查发布 workflow 是否包含该包，并更新真实制品坐标；不能仅添加目录就宣称已进入官方 npm 市场。涉及打包字节的变动按贡献说明中的固定工具链重生成哈希。

`pnpm pack:gate`、`pnpm catalog:check` 等检查服务于制品与目录一致性；真实 Host 安装、启停和业务操作仍要验证。仓内未发布的 SDK 或插件候选不能写成已可从 npm 安装。
