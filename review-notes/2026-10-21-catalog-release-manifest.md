# configurationVariants 发布候选清单

状态：[源码 PR #101](https://github.com/zts212653/clowder-ai-plugins/pull/101) 的未发布候选清单；实现及验证证据以 PR 对应提交的检查为准，尚不表示 npm 发布或 live catalog 激活。

## 范围

- contract 0.2.0：新增配置分支模型与共享解析；重复分支枚举返回校验错误，存储值只读取自身属性，条件值去重、普通 select 限定选项、每分支只编译一次，字符串/secret 需要非空白内容且保留原值；operation 不进入标量校验，URL 使用标准 URI 格式（Host 注册 ajv-formats）；`contractVersion` 是插件所需协议，不等同于 npm 依赖版本。
- SDK 0.2.0-beta.24：支持新契约。beta.23 已发布，其他插件继续使用自己的声明版本。
- connector-feishu 0.1.0-alpha.8：Verification Token 仅属于 Webhook 分支。
- video-generation 0.1.0-alpha.2：认证字段按 authType 分支选择；恢复迁移前 HTTP/HTTPS endpoint 均可配置的行为，撤销 #54 新增的非 loopback HTTP 限制。
- 通用依赖兼容校验另行交付；不批量升级其他插件。

## 候选制品

使用 Node 24.18.0 / npm 11.16.0，先构建再运行原 `scripts/pack-publish-artifact.mjs`；没有新增解包重压缩逻辑。下表记录候选字节；修改包内容后须重新验证，并以发布时 registry 实发字节为最终核对依据。

| 包 | 版本 | 字节 | SHA256 |
|---|---|---:|---|
| plugin-contract | 0.2.0 | 234320 | `1bcd26e0191a5a04e0a7a2be3832368ed06398cce7a4f5110956e22c5c010d45` |
| plugin-sdk | 0.2.0-beta.24 | 92488 | `06ef52010accb1e9a670df040ccff7258e585c6256d2fcded7afe17244e58e31` |
| connector-feishu | 0.1.0-alpha.8 | 86602 | `fee9d2fb3f94d7ee98573c3f999c31a65cea0996d892fd46353040cd63c7dd9e` |
| video-generation | 0.1.0-alpha.2 | 47037 | `738c0e08d3814042ecff97881fc8491d5419d69b38569f8226b2936ccab69947` |

### 完整 npm integrity

- plugin-contract@0.2.0: `sha512-pvA/A/s13JLnnYtCacQ3gS+rC3phS5fpNVczmOJemlcLfdCGMQL3VvS8v4TAKEogGVBvHiHEKGeDbwiSmZbCjQ==`；SHA1 `b33346ae02bbecb859839f10ffbb1e4f08a471bc`
- plugin-sdk@0.2.0-beta.24: `sha512-obnziD7d+OHHjQp3eNUKHeZJU5CZ1NC5yonWAak4koXX+Jg8o8wzld3CcBhfGMbZCghIvCFJuXMMTXhNjx7u+g==`；SHA1 `64cdb7002f4e7abca5d30356a8244ffe123b7aad`
- connector-feishu@0.1.0-alpha.8: `sha512-9t9SQrgqFxYJtD8sywja2lSdPP/c/JbxOV0JOZZPY+EgpdmAMYNjtfqsBp3OdcXeaOrNBgB+07rGnYWf/dvD9A==`；SHA1 `42ce0f56a2648310dc9edf760f8bea57c5b17287`
- video-generation@0.1.0-alpha.2: `sha512-YzEMEKsNFWatYyjDV4WEj/VjpXeaef1bYX4SqjL+Xc8o3OaKvReTzmTVqYUjOZ9+esI6OPPGTi8qGmQOdi48yQ==`；SHA1 `170a6a1ba279776e09f38efac228e72bb1f0a814`

契约包位于 `packages/plugin-contract/clowder-ai-plugin-contract-0.2.0.tgz`；SDK/契约哈希必须与飞书 shrinkwrap 完全相同。两个插件的 candidate 条目必须与官方打包结果完全相同。已发布版本的条目不重写。

## 验证与顺序

飞书隔离 registry 安装已验证正式 tgz、保留包内 resolved 路径的 npm ci、错误 SDK/契约下载地址 E404 拒绝、integrity、manifest 校验、create 入口及 EINTEGRITY 篡改拒绝；整套 gate 与云端结果以精确提交的检查为准。

本地目录验收与公开发布是两条路径：

- 本地目录：安装并构建源码依赖后，可按[验收步骤](2026-10-21-experience-acceptance-prep.md)使用支持该契约的 Host 验证配置，无需先公开发布候选 SDK 或插件。
- 公开发布：源码经所需 CODEOWNER 审批合入后，main CI 发布；核对 registry 中四个精确版本及字节，再通过独立 PR 激活 live catalog。遵循 [CONTRIBUTING.md](../CONTRIBUTING.md)，不重写已发布身份。
- Host 集成与兼容验证见 [Host PR #1660](https://github.com/zts212653/clowder-ai/pull/1660)；本清单不代替使用方的构建、运行验收或发布审批。

迁移对照：Host main `ffa73bb8fb`（2026-08-04）的协议引擎与迁移前 `db22707` 均无 HTTPS-only 限制；插件迁移 `a57fa82` / #54 `29595a7` 新增了该限制。本次恢复 HTTP/HTTPS 支持，覆盖普通域名/内网 HTTP、HTTP/HTTPS submit/poll 请求与已有真实本地 HTTP fixture；不把插件 endpoint 规则推广到通用 URL 字段。
