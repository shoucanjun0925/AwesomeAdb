# AwesomeAdb 0.3.0

面向 Windows 的中文 Android 文件工作台：Sites 网页、本地助手和私有数据库。文件直接在电脑与设备之间传输。

## 开始使用

1. 在自己的工作台进入 **连接与设置**，下载并解压 Windows 助手。
2. 双击 **AwesomeAdb 助手.exe**。已内置 ADB，无需安装 Node.js、选择程序路径或配置环境变量。
3. 网页点击 **连接本地助手**，允许本地网络访问，在 Windows 授权窗口确认网址。
4. 使用 USB 或无线方式连接设备，填写备注，再点击 **完成设置，进入工作台**。
5. 从设备卡片进入文件管理，使用 **上传到设备** 和 **下载到电脑**。

支持 Windows 10/11 x64，建议使用 Edge 或 Chrome 顶层标签页。USB 设备需要打开 USB 调试并授权电脑。无线配对端口与连接端口分别填写。

**GitHub 通用包**不包含个人站点地址。请从自己的工作台下载 `AwesomeAdb-site.json`，放在助手旁边，或启动时导入。从私有工作台下载的完整包已带好本站配置。

## 更新和功能

ADB 更新完全手动：设置中点击 **检查更新**，需要时再更新。更新助手本身仍沿用已安装的有效 ADB。升级助手前请完成任务，在高级设置退出旧助手，再启动新版。

更新验证每个文件的大小和 SHA-256，按版本独立保存并保留上一版。任务和文件访问结束后才切换，失败保留原版本。兼容的其他 ADB 服务会自动共用，不会因版本不同静默停止其他工具。

- USB、IP 和无线配对；设备备注、连接历史、服务启停。
- 文件和文件夹上传下载，保留空文件夹；删除、重命名、新建目录、多选和排序。
- 文本和图片预览、任务进度、取消、失败重试及重名处理。
- Ctrl/Shift 多选、Ctrl+A、Enter、Backspace、F2、Delete 等键盘操作。

停止服务会取消未完成任务并保持停止，直到主动启动、检测设备或连接。文本预览读取前 1 MiB，支持 UTF-8、GB18030；图片预览上限 20 MiB。

## 数据与开发

云端只保存备注、连接地址和偏好，不保存文件内容、配对码或本机授权凭证。助手仅监听 `127.0.0.1:27183`，校验站点来源并要求本机授权。

本机配置位于 `%LOCALAPPDATA%\AwesomeAdb\config-v2.json`，ADB 位于同目录的 `adb` 文件夹。升级继承原电脑标识，保留旧配置。递归传输不跟随软链接；暂不提供断点续传和回收站。

使用 Sites Vinext、React、TypeScript、D1、R2、Tango ADB 和 Node 单文件应用。构建助手需要 Windows x64、Node.js 26.3 或更高版本。

```powershell
npm ci
npm run dev
npm run helper:prepare
npm run helper:dev
npm run typecheck
npm test
npm run helper:build
node scripts/package-release.mjs
```

`vendor/adb/release.json` 固定官方版本、地址和校验值，`manifest.json` 固定各文件。更新锁定版本前核对官方发行说明、依赖和许可。Windows 包附有运行时许可证及完整 ADB NOTICE。

公开源码不包含 Sites 项目身份；创建自己的私有 Sites 后由 Sites 工具设置项目 ID。私有环境变量 `DOWNLOADS_OWNER_EMAIL` 限定安装包发布者，不写入源码。

`node scripts/package-release.mjs --site-url <自己的HTTPS工作台地址>` 生成附站点配置的私有 ZIP。公开发布只使用 `outputs/public-source` 和通用 ZIP，不上传私有包、旧 Git 历史、本机数据或凭证。

扩展方式见 [架构说明](docs/architecture.md)，检查范围见 [验证记录](docs/verification.md)。
