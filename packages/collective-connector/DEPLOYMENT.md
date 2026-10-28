# 独立 Collective Service：SSH 私有部署

服务器只运行共同体 Service 和同包 Client。每位成员的电脑各自运行 Café 与 Collective 插件，
通过本机 SSH 入口访问服务器；猫、家内线程和 Works 原件留在各自 Café。
这里不需要公网 HTTP 端口、反向 SSH 或另一份 Redis。

```text
成员 A 浏览器 + Café ── 127.0.0.1:15201 ── SSH -L ─┐
                                                  ├─ 服务器 127.0.0.1:5201
成员 B 浏览器 + Café ── 127.0.0.1:15201 ── SSH -L ─┘   Service + Client + 普通附件
```

所有成员使用完全相同的外侧地址 `http://127.0.0.1:15201`。`localhost` 与 `127.0.0.1` 是不同 origin；
不能在登录、邀请和配对中混用。内侧 5201 与外侧 15201 可以不同，canonical URL 始终是外侧入口。
下列命令在已有的、专用的非 root 服务器账户下运行；云机创建、安全组和真人登录由部署操作者完成。

## 安装与启动

使用 Node 24+，在目标服务器安装与发布回执一致的精确版本。图片读取依赖包内声明的 `sharp`；
视频取帧和音频元数据依赖服务器 PATH 中的 `ffmpeg`、`ffprobe`。没有转写服务时，音频仍可上传和播放，
猫的音频读取明确返回 `transcription_unavailable`，不会伪造转写。

若服务器已有家里同协议的本机 ASR，可显式同时设置 `COLLECTIVE_STT_URL=http://127.0.0.1:9876` 和
`COLLECTIVE_STT_MODEL=<该服务实际模型名>`。只接受 loopback，调用前核 `/health` 的 `status/model/backend`，
模型身份不符、服务离线或返回无效时不发送音频或返回“转写不可用”；取消和撤权仍由原读取链处理。
请求使用既有 `/v1/audio/transcriptions` multipart 协议。CLI 不安装、不启动、不下载 ASR，也不借用某位成员
电脑上的转写服务。环境配置修改后重启 Service；未配置时不探测默认端口。

先把下列 `<发布回执中的版本>` 替换为实际版本，不使用漂移的 `next` 作为部署记录：

```sh
COLLECTIVE_VERSION='<发布回执中的版本>'
mkdir -p "$HOME/clowder-collective/releases/$COLLECTIVE_VERSION"
npm install --prefix "$HOME/clowder-collective/releases/$COLLECTIVE_VERSION" \
  --save-exact --omit=dev --ignore-scripts --no-audit --no-fund \
  "@clowder-ai/collective-connector@$COLLECTIVE_VERSION"
"$HOME/clowder-collective/releases/$COLLECTIVE_VERSION/node_modules/.bin/clowder-collective-service" --help
```

`npm` 安装会选择目标 OS/CPU 的 sharp optional dependency。不要加 `--omit=optional`，也不要把 macOS 的
`node_modules` 复制到 Linux。需要离线安装时，使用同 OS/CPU 已验收的自包含归档，核对发布回执 SHA256 后
解到新 release 目录，以 `node package/dist/business/service/cli.js` 启动；归档已有完整生产依赖，不需源码仓。
离线归档与 npm 包有不同摘要，二者都必须在回执中注明。

创建独立数据目录，启动时始终沿用它。数据默认长期保留，没有 TTL。一个数据目录只运行一个 Service 进程。

```sh
umask 077
mkdir -p "$HOME/.local/share/clowder-collective"
COLLECTIVE_SERVICE_HOST=127.0.0.1 \
COLLECTIVE_SERVICE_PORT=5201 \
COLLECTIVE_SERVICE_PUBLIC_URL=http://127.0.0.1:15201 \
COLLECTIVE_SERVICE_DATA_DIR="$HOME/.local/share/clowder-collective" \
COLLECTIVE_SERVICE_ALLOWED_HOST_ORIGINS=http://localhost:3001 \
  "$HOME/clowder-collective/releases/$COLLECTIVE_VERSION/node_modules/.bin/clowder-collective-service"
```

`ALLOWED_HOST_ORIGINS` 填成员实际打开 Café 的 origin；多个值用逗号分隔，逐个精确列出。
例如有成员打开 `http://127.0.0.1:3001`，就另列这个 origin。**这只允许来源，不代替真人授权和配对。**
未列出的 origin 仍被拒绝。Service CLI 禁止监听非 loopback，拒绝占用 Café 的 3001/3002。

启动输出一行 `collective-service-ready`，含 `url`、`listenUrl`、`serviceInstanceId`、`clientBuildId` 和
私有 `bootstrapLinkPath`，不把 bootstrap secret 输出到日志。保留实例 ID 和版本作为恢复核对基线。
`curl http://127.0.0.1:5201/api/health` 可在服务器探活，`/api/meta` 可核实例身份。
用 SIGTERM/SIGINT 停止并等待退出后再启动新版本。

## 让服务器持续运行

可用现有进程管理器管理上述命令。Linux 的 systemd user service 示例位于
[`deployment/collective.service`](deployment/collective.service)，环境文件示例在
[`deployment/collective.env.example`](deployment/collective.env.example)。复制前按服务器账户、Node 安装位置、
release 目录和 Café origin 修改。环境文件用 0600；不要放进 Git 或截图。

```sh
mkdir -p "$HOME/.config/systemd/user" "$HOME/.config/clowder-collective"
# 将已修改的 collective.service 和 collective.env 分别放入上述目录
systemctl --user daemon-reload
systemctl --user enable --now collective.service
systemctl --user status collective.service
journalctl --user -u collective.service -n 30
```

退出 SSH 后能否持续运行由服务器既有 user-manager/linger 配置决定；部署操作者应先确认这项。
示例不自动修改系统账户、sshd、安全组或 linger。只放行正常 SSH 入口，5201 无需公网开放。

## 成员的正常入口

1. 在**每位成员自己的电脑**保持隧道运行：

   ```sh
   ssh -N -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=3 \
     -L 127.0.0.1:15201:127.0.0.1:5201 <已有SSH别名或user@server>
   ```

   服务端只需支持 local forwarding；无需 `-R`。SSH 断了就重新运行同一条命令，不换 Service 或数据目录。

2. 管理员首次通过 SSH 读取 `bootstrapLinkPath`，在自己的浏览器打开其中完整的 **15201** 链接。
   按 Client 引导注册 GitHub App、完成本人登录和共同体设置。私有链接只给管理员，不发公共频道。
   App Manifest 的 `url`、安装完成回调与 OAuth callback 均由 canonical URL 生成。
   注册确认是在 GitHub 网站上由真人完成；服务端不需要接收 GitHub 公网 webhook。
3. 其他成员在隧道已连通时打开管理员发来的邀请，使用**各自**的 GitHub 身份接受邀请。
4. 每台 Café 的插件设置中选择 **Run mode → Connect to remote**，设置
   **Remote Service address → `http://127.0.0.1:15201`**，保存后停用再启用插件。
   这沿用 F202 的普通设置入口，不需要编辑 Café 源码或 Service 数据文件。
5. 打开 Café 的 **Collective** 入口，进入远端 Client，点击“带猫进来”，在本机确认名单后配对。
   远端模式不创建本机 Service。两个成员得到独立 endpoint；设置保存或停止插件不会撤销已有连接。

如果 15201 已占用，在正式创建 GitHub App 前为所有成员共同选择另一个外侧端口，并同步 canonical URL、
SSH 命令和插件设置。已经注册后变更地址还需同步 GitHub App 回调与既有连接配置；不能只改一台电脑。

## 普通附件与共享作品

普通聊天上传的图片、文件、音频由服务器 `attachments/` 保存，receipt 与原始摘要一起持久化。
发送者 Café 离线后，仍有权限的其他成员可以读取；撤权后拒绝读取，重试保留原回执。
私有暂存附件不会因“上传成功”变成全体可读，只有发布并满足当前权限才可读取。

共享 Works 继续使用原 Café 的 content owner 与原 revision，经既有 relay 读取、建议修改和采纳。
原 owner 离线时显示不可用，独立 Service 不另存作品原件，也不把附件复制成新的 Work。

家里的贴纸原图不随公开 npm 包分发。私有部署从获准的 Core checkout 导出匹配目录：

```sh
pnpm --filter @cat-cafe/shared build
node scripts/export-collective-stickers.mjs --output /absolute/private/stickers
scp -r /absolute/private/stickers <SSH别名>:~/.local/share/clowder-collective/
```

导出逐个校验现行 catalog 的字节长度和 SHA256，并生成 `manifest.json`。服务端默认读取数据目录下
`stickers/{memory,collaboration}`；可用 `COLLECTIVE_STICKER_DATA_DIR` 指定另一个私有目录。
没有提供相符原图时贴纸准备失败，不返回占位图；已上传的普通图片和文件不受影响。
备份时也包含这个目录；若放在数据目录外，需另备份。

## 升级、备份和恢复

升级前核对发布回执的 Host/Contract/SDK/Collective 兼容组合；每台 Café 和服务器消费这一组合。
先把新包装到另一个 release 目录，校验摘要并运行 `--help`，此时不要启动第二份 Service。

1. 停止 Service 并确认进程退出（systemd：`systemctl --user stop collective.service`）。
2. 整体备份数据目录和环境文件；不要在写入过程中单独复制 JSON 或附件目录。
   备份含成员/会话/endpoint 凭据、GitHub App OAuth 凭据、普通附件和未领取的管理员入口，按私有数据保管。
3. 修改 service unit 的可执行路径指向新 release，**数据目录和 canonical URL 保持原值**。
   使用 systemd 时先 `systemctl --user daemon-reload`，再 `systemctl --user start collective.service`，
   让已停止的服务按新 unit 启动；随后核 `systemctl --user status collective.service` 和日志。
4. 核对 `/api/meta` 的 `serviceInstanceId` 未变；重新打开两台 Café，原连接无需重新配对。
   查看一条旧消息、打开旧附件、验证一件原 owner 在线的共享作品，再发一条新消息。
5. 失败时先停新进程。保留失败目录供排查，将升级前备份解到新目录，配合原 release 启动；
   不把旧程序直接写到新版本已修改的数据上，也不同时运行原目录和恢复目录。

停机备份例子（部署路径已核对后执行）：

```sh
mkdir -p "$HOME/collective-backups"
umask 077
tar -czf "$HOME/collective-backups/service-before-upgrade.tgz" \
  -C "$HOME/.local/share" clowder-collective
```

停止当前进程后，将上述备份解到新目录（不要覆盖原目录）：

```sh
umask 077
mkdir -p "$HOME/collective-restores/before-upgrade"
tar -xzf "$HOME/collective-backups/service-before-upgrade.tgz" \
  -C "$HOME/collective-restores/before-upgrade"
```

在环境文件中将 `COLLECTIVE_SERVICE_DATA_DIR` 改为
`/home/<服务器账户>/collective-restores/before-upgrade/clowder-collective`，核对文件归属与私有权限。
将 unit 指向该备份对应的原 release，执行 `systemctl --user daemon-reload` 和
`systemctl --user start collective.service`；然后按上面的实例、旧消息、附件和原作品检查验收。
完整目录恢复应保留同一 Service 实例、provider 凭据、成员关系、事件与附件回执；不要手工替换实例 ID。
备份不是删除策略，升级和停用均不删除用户数据。

## 故障与边界

| 看到的状态 | 处理 |
|---|---|
| 连不上远端 Service | 核 SSH 进程、外侧端口和服务器 health；恢复相同隧道后点击重试，已有连接/草稿保留 |
| 这个入口通往另一个 Service | 检查隧道目标与启动的数据目录；不要把新实例冒充旧实例或重绑旧凭据 |
| 待设置 / 未配对 | 打开远端 Client 完成本人登录和正常配对 |
| 已撤销 | 旧 endpoint 不会因重启复活；有权限的人须重新配对，获得新连接 |
| 已接受但客户端没收到回复 | 保留原连接和本地数据，恢复网络让同一个 operation 重试；不要手工删除 outbox |
| 普通附件可读、作品原件不可读 | 核作品所属 Café 是否在线；这是两条不同的保管链 |
| `sharp` 或 `ffprobe` 不可用 | 按服务器 OS/CPU 重新安装依赖或补齐媒体工具；不要复制另一平台的 native module |

工程证据覆盖隔离安装、真实 OpenSSH、本地两个独立浏览器与插件实例、附件/作品及故障恢复。
GitHub 身份和 Host owner/roster 的自动化验证使用明确 fixture；云机、两台真实电脑、两位真人和真实 provider
还要在正式部署窗口验收。该边界不能由本机测试数量替代。
