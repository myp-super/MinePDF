# MinePDF

本地优先的「个人 PDF 知识库」桌面应用，形态类似 Obsidian，专注于 PDF 的管理、阅读、标注与笔记。

技术栈：Electron + React + TypeScript + Tailwind CSS + PDF.js + SQLite。

## 核心功能

- **PDF 文件库**：文件夹树与 `Documents/MinePDF/Library` 真实目录严格双向同步，本地增删改即时反映到软件，右键可直达系统资源管理器
- **PDF 阅读**：单页/双页、缩放、页码跳转、Ctrl+F 搜索、Ctrl+滚轮缩放、抓手拖拽平移、沉浸式阅读（最大化 + 收起边栏 + 161% 缩放）
- **书签 / 标签 / 笔记**：内置书签跳转；#标签 筛选；Markdown 笔记（格式/段落/剪贴板右键菜单、LaTeX、自动/手动保存、导出 PDF、选区截图插入笔记）
- **高亮标注**：选词整块高亮、添加备注，数据存 SQLite，重新打开自动恢复
- **临时阅读区**：设为默认 PDF 应用后，双击任意 PDF 临时预览，不进入知识库
- **全局搜索**：文件名、标签、笔记内容
- **自动更新**：内置更新源，启动自动检查，可一键下载安装（国内自动走镜像加速）

## 安装与运行

直接下载安装包（无需开发环境）：

- `release/MinePDF Setup x.x.x.exe` — Windows 安装程序
- `release/MinePDF x.x.x Portable.exe` — 绿色便携版

开发环境运行（Node.js 18+）：

```bash
npm install
npm run dev
```

## 构建与打包

```bash
npm run build    # 生产构建
npm run dist     # 生成安装版 + 便携版到 release/
```

国内网络打包前先设置镜像：

```powershell
$env:ELECTRON_MIRROR='https://npmmirror.com/mirrors/electron/'
$env:ELECTRON_BUILDER_BINARIES_MIRROR='https://npmmirror.com/mirrors/electron-builder-binaries/'
npm run dist
```

## 发布更新

打 tag 即自动构建并发布（GitHub Actions 生成 Release + 更新 Pages 上的 update.json）：

```bash
git tag v1.0.0
git push origin v1.0.0
```

## 数据目录

```
Documents/MinePDF/
├── Library/             # PDF 库（与软件文件夹树同步）
└── data/
    ├── database.sqlite  # 数据库
    ├── notes/           # 每篇笔记一个文件夹（md + 截图 assets）
    ├── annotations/     # 标注镜像
    ├── config/          # 设置
    └── backups/
```

## License

MIT
