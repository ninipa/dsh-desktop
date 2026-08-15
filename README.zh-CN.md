<h1 align="center">
  <img src="assets/icon.png" width="72" alt="DSH Desktop 标志" />
  <br />
  DSH Desktop
</h1>

<p align="center">
  面向 <a href="https://github.com/deepseek-ai/deepseek-harness">DeepSeek Harness</a>（dsh）
  的轻量 macOS 桌面壳——双击即用，无需手动开终端和浏览器。
</p>

<p align="center">
  <a href="README.md">English</a> ·
  <a href="LICENSE"><img alt="许可证：MIT" src="https://img.shields.io/badge/License-MIT-171513.svg?style=flat-square" /></a>
  <img alt="macOS" src="https://img.shields.io/badge/macOS-Apple%20Silicon%20%7C%20Intel-171513.svg?style=flat-square" />
  <a href="https://github.com/ninipa/dsh-desktop/releases"><img alt="最新版本" src="https://img.shields.io/github/v/release/ninipa/dsh-desktop?style=flat-square&color=171513" /></a>
  <a href="https://github.com/ninipa/dsh-desktop/actions"><img alt="CI 构建" src="https://github.com/ninipa/dsh-desktop/actions/workflows/release.yml/badge.svg" /></a>
</p>

DSH Desktop 把官方 DeepSeek Harness Web UI 包装成原生 macOS 应用。启动应用，它会**自动拉起 `dsh web`**（随机回环端口）；退出应用，它会**干净地停止服务**——无需手动 `dsh web`、无需终端、无残留进程。

它**不捆绑 dsh**——而是启动你系统里已安装的 `dsh`，因此你执行 `npm update -g @deepseek-ai/dsh` 后，应用下次启动会自动跟随上游新版。

## 为什么不捆绑 dsh

大多数桌面封装会把**一整套 dsh**（20 多个 `@deepseek-ai/dsh-*` 包 + 原生模块）打进 `.app` 里。DSH Desktop 刻意反其道而行：直接启动你系统里已经装好的 `dsh`。

| 维度 | 捆绑 dsh | DSH Desktop |
|---|---|---|
| **上游更新** | 等作者重新打包、发布新版 | `npm update -g @deepseek-ai/dsh` 后重启即用 |
| **体积** | 数百 MB（Electron + 整个 dsh 依赖树 + 原生模块） | 仅 Electron 壳本身，不含 dsh 依赖树 |
| **重复安装** | app 里藏一份 dsh，与你的 CLI 版本割裂 | 复用你全局的 dsh——一份、一个版本 |
| **升级节奏** | 被钉死在作者选择的版本 | 你决定何时升级，RC 动荡期可先观望 |
| **数据** | 可能共享或复制你的 `~/.dsh` | `DSH_HOME` 隔离，绝不碰 `~/.dsh` |

dsh 正处于快速演进的 developer preview：上游几天内就可能发布破坏性变更。捆绑它意味着每次上游变化你都得等一次重打包；而启动你已安装的 dsh，能让这个壳保持轻量、始终最新、且节奏由你掌控。

> [!IMPORTANT]
> 本项目是非官方社区封装，依赖快速演进中的 `@deepseek-ai/dsh`（当前 `0.1.0-rc.x`，developer preview，上游明确声明会有破坏性变更）。**仅支持 macOS。**

---

## 面向普通用户

### 前置要求

DSH Desktop 需要你机器上已装好 `dsh`。如果还没有：

```bash
# 1. 先安装 Node.js（>= 20），然后：
npm install -g @deepseek-ai/dsh
```

### 安装

1. 从 [GitHub Releases](../../releases) 下载最新的 `DSH-Desktop-*.dmg`。
2. 打开 DMG，把 **DSH Desktop** 拖入「应用程序」。
3. 双击运行 **DSH Desktop**。

首次启动需要在界面里填一次 API key（Settings → Models），之后即可使用完整的 Harness 界面。

### 插件市场

壳保持纯净——**不捆绑任何插件**（连市场本身也不捆绑）。首次启动时，启动页会显示一张引导卡片，一键安装**插件市场**（`dshmarket`）；重启后即可在 Settings → Plugin Market 里管理所有插件。

为什么这么设计：
- 壳从不捆绑第三方插件代码——dsh 升级不受影响
- 一键启用，其余（安装/更新/卸载）全在 UI 里完成
- 你的插件装在隔离的 `DSH_HOME` 里，与裸用 dsh 的环境分开

### 你的数据存在哪里

你在应用里做的**所有事**——API key、对话、工作区、安装的插件、设置——都存在一个**专门的隔离数据目录**：

| 数据 | 位置 |
| --- | --- |
| API key | `~/Library/Application Support/Dsh/dsh-home/.credentials.yaml` |
| 会话 / 对话记录 | `~/Library/Application Support/Dsh/dsh-home/storages/` 和 `sessions/` |
| 安装的插件 / profile | `~/Library/Application Support/Dsh/dsh-home/profiles/` |
| 设置 | `~/Library/Application Support/Dsh/dsh-home/settings.yaml` |
| 应用日志 | `~/Library/Application Support/DSH Desktop/dsh-desktop.log` |

### 数据与原生 dsh 相互隔离（重要）

这是本应用刻意为之的设计，请务必了解：

- **DSH Desktop** 使用 `~/Library/Application Support/Dsh/dsh-home`。
- **直接使用 `dsh`**（终端里，或浏览器打开 `dsh web`）使用 `~/.dsh`。

两者互不相通。你在应用里安装的插件，**不会**出现在原生 dsh 环境里，反之亦然。应用的 API key、会话、插件是一套**完全独立的 profile**——在应用里做任何尝试都不会污染你日常的 CLI/浏览器环境（反之亦然）。

### 卸载

把应用拖进废纸篓只删除应用本体，**数据会保留**（macOS 惯例）。若要连数据一起清空：

```bash
rm -rf "$HOME/Library/Application Support/Dsh"
rm -rf "$HOME/Library/Application Support/DSH Desktop"
```

### 更新

- **应用外壳**：有新版时下载新的 DMG 覆盖即可。
- **dsh 本体**：应用用的是你系统里的 `dsh`，执行 `npm update -g @deepseek-ai/dsh` 后重启应用即可。

---

## 面向二次开发者

### 前置要求

- Node.js（>= 20）
- 全局安装 `dsh`（`npm install -g @deepseek-ai/dsh`）

### 从源码运行

```bash
git clone <本仓库>
cd <仓库目录>
npm install        # 会下载 Electron；网络慢时可加 ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
npm start          # 开发模式启动
```

### 测试

```bash
npm test           # node --test，零额外依赖
```

### 打包

```bash
npm run dist:mac:arm64   # Apple Silicon DMG + ZIP
npm run dist:mac:x64     # Intel DMG + ZIP
```

### 工作原理

DSH Desktop 是一个薄壳，不 fork、不修改 Harness UI，只负责宿主：

1. **解析 dsh** —— 通过 login shell 定位你已装的 `dsh`（`/bin/zsh -l -i -c 'command -v dsh'`），失败回退 `npx --yes @deepseek-ai/dsh@latest`，再失败弹安装指引。`-i`（交互式）参数是必需的：`.zshrc`（负责把 `fnm`/`node` 加进 `PATH`）只在交互式 shell 中读取。解析结果**从不缓存**，每次启动现查。
2. **启动** —— spawn `dsh --profile web --host 127.0.0.1 --port 0`（随机回环端口），并且**显式用 `node` 执行 dsh 脚本**（GUI 应用不继承 shell `PATH`，`#!/usr/bin/env node` 的 shebang 会失败）。
3. **等待就绪** —— 匹配 stdout 行 `dsh web: http://127.0.0.1:<port>`（另有 HTTP 200 轮询作兜底通道）。
4. **加载** —— 顶层 `BrowserWindow.loadURL(url)`（同源）。刻意不用 `<iframe>`：上游 `/api` 信任边界会拒绝 null/跨源 Origin。
5. **隔离** —— 设置 `DSH_HOME` 指向 `~/Library/Application Support/Dsh/dsh-home`，绝不触碰 `~/.dsh`。
6. **托管** —— 单实例锁、pidfile 残留检测与自动回收、崩溃重启（≤3 次指数退避）、`SIGTERM → 5s → SIGKILL` 进程组清理、版本护栏（低于 `0.1.0-rc.5` 警告但不阻断）。

### 代码结构

| 文件 | 职责 |
| --- | --- |
| `src/dsh-service.js` | 唯一值得的抽象：`resolveDshCommand` / `getDshVersion` / `startDshService`（spawn、就绪、pidfile、stop） |
| `src/main.js` | 窗口、托盘、单实例、崩溃重启、版本护栏、日志 |
| `src/window-options.js` | BrowserWindow 安全选项（sandbox、`contextIsolation`） |
| `src/window-lifecycle.js` | 关窗隐藏到托盘 + 托盘菜单 |
| `src/mac-titlebar.js` | 将 web 内容融入 macOS 隐藏式标题栏 |
| `scripts/smoke-packaged.mjs` | 针对系统 dsh 的冒烟测试 |

### 安全模型

- Harness 只绑定 `127.0.0.1` 随机端口
- 启用 `sandbox` 和 `contextIsolation`，禁用 `nodeIntegration`
- 新窗口与跨域导航交给系统浏览器
- 无 shell 字符串拼接——所有进程参数都以数组形式传递
- 应用从不读取或转发你的 API key（不碰 `~/.dsh/.credentials.yaml`）

### 签名与公证

发布版使用 Apple **Developer ID** 证书签名并**公证**，macOS Gatekeeper 不会弹警告。本地无证书构建时回退为 ad-hoc 签名（首次启动需右键 → 打开）。

---

## 已知限制

- **仅 macOS** —— dsh 官方不支持 Windows 沙箱；Linux 尚未验证。
- 上游 dsh 仍是 developer preview，可能出现破坏性变更。
- 无自动更新。

## 许可证

MIT —— 见 [LICENSE](LICENSE)。Fork 自 [steven-kid/deepseek-harness-desktop](https://github.com/steven-kid/deepseek-harness-desktop)（MIT）。本项目与 DeepSeek 无隶属或合作关系，DeepSeek Harness 及相关名称权利归其各自所有者所有。
