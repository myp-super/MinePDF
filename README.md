# MinePDF

一个本地优先的「个人 PDF 知识库」桌面应用。它不是简单的 PDF 阅读器，而是把论文、教材与技术文档的管理、阅读、标注、笔记和画笔整合在一起的工具，形态类似 Obsidian，但专注于 PDF 工作流。

![Electron](https://img.shields.io/badge/Electron-33-47848F) ![React](https://img.shields.io/badge/React-18-61DAFB) ![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6) ![SQLite](https://img.shields.io/badge/SQLite-better--sqlite3-003B57)

## 功能特性

- **文件库（Library）严格双向同步**：多级文件夹树与 `Documents/MinePDF/Library` 真实目录**一一对应且保持严格同步**——软件里新建/重命名/移动/删除文件夹会同步操作真实目录；在资源管理器中新建文件夹、移动文件、重命名文件/文件夹，软件会**瞬间（防抖 0.4 秒）自动识别并同步**，移动与重命名不会产生重复记录；**在资源管理器中删除文件或文件夹，软件会同步移除对应记录**（笔记与标注随之清理）。
- **右键直达本地**：任意文件、文件夹甚至「我的知识库」根节点，右键都有「在系统资源管理器中查看」，一键跳转到 Library 对应位置，改完回到软件即已同步。
- **PDF 导入**：拖拽到窗口、选择文件、批量导入文件夹（递归）三种方式；文件会**复制到目标文件夹对应的真实目录**统一管理，自动记录文件名、路径、大小、页数、导入时间，并做重复导入检测。
- **Obsidian 式库目录**：所有 PDF 统一存放在 `Documents/MinePDF/Library/`。在资源管理器中把 PDF 直接拖进该目录（任意子文件夹），软件自动扫描同步显示；删除库内文件或文件夹，软件同步移除对应记录。
- **信息面板折叠**：右侧信息面板可一键折叠为细竖栏，节省阅读空间。
- **PDF 阅读器**（PDF.js）：单页 / 双页模式、缩放与适应宽度/页面、页码跳转、全屏；快捷键 Ctrl+F 文档内搜索、Ctrl+滚轮以鼠标为中心缩放、←/→ 翻页；**快速打开**：最近打开的文档在内存中缓存，切换回来秒开，主进程同时缓存最近读取的文件内容。
- **书签（目录）**：工具栏有独立的书签按钮，点击打开/折叠目录面板；打开带书签的文档时自动显示，点击任意书签跳转到对应页并高亮当前页。
- **标签系统**：#标签 添加 / 删除 / 点击筛选。
- **Markdown 笔记（Obsidian 式）**：每个 PDF 对应一份笔记，支持标题、列表、代码块与 LaTeX 公式（KaTeX 渲染），自动保存（可关闭）；**右键菜单提供文本格式**（加粗/倾斜/删除线/高亮/代码/数学/注释/清除格式）、**段落**（H1–H6/正文）、**剪贴板操作**（剪切/复制/粘贴/纯文本/全选）；笔记以可读文件保存（`data/notes/《PDF名称》笔记.md`），支持**导出 PDF** 与**截取当前 PDF 页面插入笔记**（图文并茂）。
- **PDF 标注（高亮）**：高亮模式选中文字即生成高亮（支持多页连续选择），右侧为每条标注添加备注；在 PDF 上**右键高亮可直接删除或编辑备注**；数据存入 SQLite，重新打开自动恢复。
- **全局搜索**：同时搜索文件名、标签与笔记内容（Ctrl+K）。
- **多语言**：设置中可选择简体中文 / English，默认简体中文。
- **检查更新**：标题栏右上角与设置页均可手动检查更新；启动后会自动检查一次。有新版本时显示「当前版本 → 最新版本」与更新内容，一键跳转下载。
- **临时阅读区**：可将 MinePDF 设为 Windows 默认 PDF 应用；双击任意 PDF（或右键“打开方式”选择 MinePDF）会在软件左下「临时阅读」区临时预览，**不会进入知识库**，可标注/笔记，随时「加入知识库」归档或「清空临时区」。
- **设置**：深色/浅色主题、默认导入目录、笔记自动保存开关、一键数据备份、更新源 URL。
- **异常处理**：文件被移动/删除时提示重新定位或移除记录；数据库损坏时自动备份并重建；友好 Toast 与确认对话框。
- **完全本地**：数据保存在 `Documents/MinePDF/`，无任何联网功能（更新检查除外，且默认关闭，需手动配置更新源）。

## 交付产物

`release/` 目录包含：

- `MinePDF Setup 1.0.0.exe` — Windows 安装程序（NSIS，可自定义安装目录）
- `MinePDF 1.0.0 Portable.exe` — 绿色便携版，解压即用

界面预览见 `docs/`：

- `docs/splash-screenshot.png` — 启动画面
- `docs/app-screenshot.png` — 三栏主界面

## 项目结构

```
├── electron/                 # 主进程
│   ├── main.ts               # 窗口、启动页、生命周期、自动检查更新
│   ├── preload.ts            # contextBridge API
│   ├── db/                   # SQLite（schema / database / repository）
│   ├── services/             # 导入、设置、备份、PDF 页数探测、更新检查
│   └── ipc/register.ts       # 全部 IPC 注册
├── src/                      # 渲染进程（React + Tailwind）
│   ├── components/           # Sidebar / Viewer / Inspector / Settings / UpdateModal 等
│   ├── i18n.ts               # 中英文案与翻译钩子
│   ├── lib/pdf.ts            # PDF.js 初始化与搜索
│   ├── shared/types.ts       # 主/渲染共享类型
│   └── store.ts              # Zustand 全局状态
├── public/
│   ├── splash.html           # 启动画面
│   └── logo.svg              # 应用 Logo
├── scripts/                  # 构建辅助脚本
├── build/                    # 打包资源（icon.ico / icon.png）
├── docs/                     # 界面预览截图
└── release/                  # 打包产物（Setup.exe / Portable.exe）
```

## 数据目录

```
Documents/MinePDF/
├── Library/                  # PDF 库根目录（文件夹树与软件一一对应）
└── data/
    ├── database.sqlite       # SQLite 数据库
    ├── notes/                # 笔记镜像（<pdfId>.md）
    ├── annotations/          # 标注与笔迹镜像（<pdfId>.json / <pdfId>.ink.json）
    ├── config/settings.json  # 设置
    └── backups/
```

> 旧版本数据目录 `Documents/PDFKnowledgeManager` 会在首次启动时自动迁移为 `Documents/MinePDF`。

## 开发环境运行

环境要求：Node.js 18+（建议 20/22）、Windows。

```bash
npm install        # 安装依赖（会自动为 Electron 重编 better-sqlite3）
npm run dev        # 启动 Vite 开发服务器 + Electron
```

## 构建与打包

```bash
npm run build      # 类型安全构建（主进程 tsc + 渲染进程 Vite）
npm run dist       # 产出 Windows 安装版 + 便携版到 release/
```

产物：

- `release/MinePDF Setup 1.0.0.exe` — NSIS 安装程序
- `release/MinePDF 1.0.0 Portable.exe` — 绿色便携版

### 国内网络打包（镜像）

```powershell
$env:ELECTRON_MIRROR='https://npmmirror.com/mirrors/electron/'
$env:ELECTRON_BUILDER_BINARIES_MIRROR='https://npmmirror.com/mirrors/electron-builder-binaries/'
npm run dist
```

### 常见打包问题

- **winCodeSign 解压报错 / Cannot create symbolic link**：无管理员/开发者模式权限的 Windows 无法创建 macOS 符号链接，而 `winCodeSign-2.6.0.7z` 内含两个 darwin 软链（Windows 打包并不需要）。仓库内置 `scripts/7za-wrap.cs` 编译为包装器替换 `node_modules/7zip-bin/win/x64/7za.exe`（原版保留为 `7za-real.exe`）：解压退出码为 2 但产物完整时视为成功。重新 `npm install` 后会还原，按需重新执行：

```powershell
C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe /nologo /out:$env:TEMP\7za-wrap.exe scripts\7za-wrap.cs
Copy-Item node_modules\7zip-bin\win\x64\7za.exe node_modules\7zip-bin\win\x64\7za-real.exe
Copy-Item $env:TEMP\7za-wrap.exe node_modules\7zip-bin\win\x64\7za.exe
```

- **GitHub 直连超时**：Go 编写的 app-builder 不读取系统代理，请使用上面的国内镜像环境变量。

## 如何发布更新（自动检查更新机制）

本项目采用 **GitHub Releases + GitHub Pages** 作为更新渠道：

- 更新清单：`https://myp-super.github.io/MinePDF/update.json`（仓库根目录的 `update.json`，随 main 分支自动部署到 Pages）；
- 安装包：GitHub Releases 附件；
- 应用默认内置该更新源，**用户安装后零配置**，启动 8 秒后自动检查，也可点击标题栏右上角按钮手动检查。

### 一键自动发版（推荐）

仓库内置 `.github/workflows/release.yml`，发版只需：

```bash
git tag v1.1.0
git push origin v1.1.0
```

工作流会自动完成：构建安装包与便携版 → 创建 GitHub Release 并上传附件 → 生成新版本 `update.json` 提交回 main（Pages 自动更新）。约 10 分钟后用户端即可检查到新版本。

### 手动发版（不依赖 Actions）

1. 修改 `package.json` 的 `version`（如 `1.1.0`）；
2. `npm run dist`（国内网络请先设置镜像环境变量，见上文）；
3. 在 GitHub Releases 创建 tag `v1.1.0` 并上传两个 exe；
4. 更新仓库根目录的 `update.json`，格式如下，然后推送到 main：

```json
{
  "version": "1.1.0",
  "notes": [
    "本次更新的内容说明"
  ],
  "url": "https://github.com/myp-super/MinePDF/releases/download/v1.1.0/MinePDF.Setup.1.1.0.exe",
  "publishDate": "2026-08-08"
}
```

检测到新版本时，弹窗显示「当前版本 → 最新版本」和更新内容列表，点击「前往下载」在浏览器中打开下载地址。安装版用户运行安装包覆盖升级；便携版替换新包即可。若想修改更新源或完全关闭自动检查，可在「设置 → 更新」中调整（留空即关闭）。

> 说明：应用本身只负责「检查 + 提示 + 跳转下载」，不会在后台偷偷下载安装，也**不包含任何 AI 功能**。若希望安装版实现真正的静默自动升级，可在主进程接入 electron-updater（需要配置 electron-builder 的 publish 字段），当前版本保留了这一扩展点。

## 自动化验证

```powershell
$env:PKM_SMOKE_TEST='1'
.\release\"MinePDF 1.0.0 Portable.exe"
```

冒烟测试使用系统临时目录（不污染真实知识库），依次验证：preload 桥接、更新检查 IPC、库快照、创建文件夹（含真实目录）、PDF 导入（按文件夹落盘）、移动 PDF 到根目录/子文件夹、文件读取、笔记保存、标注增改查删、标签、全局搜索、库扫描与清理，全部通过后退出码为 0。另有独立的同步验证脚本（`scripts/test-sync.cjs`）覆盖本地建文件夹、移动文件、重命名文件夹/文件、新增文件等严格同步场景。

## 常用命令

| 命令 | 说明 |
| --- | --- |
| `npm run dev` | 开发模式（热更新） |
| `npm run typecheck` | 主进程 + 渲染进程类型检查 |
| `npm run build` | 生产构建 |
| `npm run dist` | 打包安装版 + 便携版 |
| `npm run dist:dir` | 仅产出免安装目录（调试用） |

## 技术要点

- **数据库**：better-sqlite3（同步、事务可靠），WAL 模式，外键级联清理笔记、标注与笔迹；数据损坏时自动改名备份并重建。
- **库同步**：文件夹即真实目录，主进程用 `fs.watch` 递归监听 Library（Windows 支持），防抖后增量扫描；新建/重命名/移动文件夹会同步操作真实目录；监听失败时自动降级为定时轮询。
- **PDF.js**：Vite `?worker` 方式将 worker 打成 Blob Worker，兼容 Electron `file://` 加载；附带 cmap 以支持非内嵌中文字体；打开解析禁用 eval 并启用文档/文件双重缓存，追求快速打开与渲染。
- **标注存储**：高亮矩形与画笔笔迹均以 PDF 页面坐标（pt）保存，缩放后按当前视口重新换算，保证位置精确；笔迹采样点附带宽度系数（压力 × 速度），重绘时还原笔锋。
- **安全**：`contextIsolation` + 无 `nodeIntegration`，渲染进程仅能通过白名单 IPC 访问主进程能力；更新仅拉取 `update.json` 并校验格式，下载跳转仅允许 http/https。

## License

MIT

## 更新记录

- **1.2.1**：修复临时阅读的信息面板（书签/笔记/标注可用）；截图改为选区截图并移入笔记工具栏；默认 PDF 应用改为手动开关（安装不再强制注册）。
- **1.2.0**：笔记升级为 Obsidian 式编辑器（右键格式/段落/剪贴板菜单）；笔记以「PDF 名称 笔记.md」文件保存；新增导出 PDF、截取 PDF 页面插入笔记；设置页更新区简化为「检查更新 + 启动自动检查」开关。
- **1.1.2**：设置页「默认 PDF 应用」改为开关；PDF 文件关联图标独立设计（与应用 Logo 区分）；临时阅读区高度可拖拽；移除多选提示条。
- **1.1.1**：去掉成功/信息类操作弹窗提示（直接操作，仅保留错误提示）；移除左侧栏底部标签格。
- **1.1.0**：新增临时阅读区（双击 PDF 临时预览、不污染知识库，可一键归档/清空）；支持设为 Windows 默认 PDF 阅读器（设置页引导）。
- **1.0.8**：多选后的移动/删除操作收归右键菜单；「导入文件夹」改为整目录导入（保留目录结构并建立对应文件夹层级）。
- **1.0.7**：左侧文件列表支持 Ctrl 多选，可批量删除 / 移动到文件夹（右键菜单或顶部操作栏）。
- **1.0.6**：本地删除文件/文件夹时软件严格同步移除记录；修复首页“导入文件夹”无反馈的问题（导入后自动打开文档）。
- **1.0.4**：优化更新检查（绕过 GitHub Pages CDN 缓存），软件内直接下载并安装更新。
- **1.0.3**：修复旧配置空更新源覆盖内置默认地址的问题；更新检查绕过 CDN 缓存。
- **1.0.2**：新增软件内下载更新与一键安装；修复 i18n 字典。
- **1.0.1**：标题栏动态显示版本号；内置默认更新源。
