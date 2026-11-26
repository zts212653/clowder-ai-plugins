# 桌面部署

- API 警告和错误以当前实例的 API 日志为准。桌面启动或窗口问题优先看 `main.log`，子服务启动、连接、端口或退出问题优先看 `desktop.log`。桌面通常将这两份日志与 `api` 子目录放在同一个 `data/logs` 中。
- Windows 默认目录为 `%LOCALAPPDATA%\Clowder AI\data\logs`，macOS 默认目录为 `~/Library/Application Support/Clowder AI/data/logs`。迁盘或隔离运行时，以当前实例为准。
- 普通安装无需有源码。仅用版本、已采集日志和复现现象就能做首轮定位。安装目录里的编译产物和用户项目目录都不能用来推断源码版本。若界面完全打不开，可从桌面启动失败提示的「打开日志目录」交给维护者看脱敏线索。
