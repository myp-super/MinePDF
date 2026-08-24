import { ChevronDown, Copyright, FileText, Info, Shield, ShieldCheck } from 'lucide-react';
import React, { useEffect, useState } from 'react';
import { useT } from '../i18n';
import { Modal } from './ui';

/** MIT License 官方全文（应用内直接展示，不依赖网络） */
const MIT_LICENSE = `MIT License

Copyright (c) 2026 myp-super

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`;

/** 安全说明全文（对应 SECURITY.md 内容） */
const SECURITY_TEXT = `Supported Versions
当前只维护最新公开版本。

Installer Safety Notice
请只从 GitHub Release 或 README 中列出的官方网盘入口下载安装包，旧版本 .exe 安装包一律视为不可信历史产物并隔离保留，不建议继续安装或传播。需要安装 MinePDF 时，请使用最新版本的官方 Release 安装包或便携版。
软件内更新仅通过官方更新源（update.json）下发，请勿使用来源不明的第三方更新地址。

Reporting a Vulnerability
如果你发现安全问题，请通过 GitHub Issues 或仓库作者主页联系作者。
请不要在公开 Issue 中直接贴出 Cookie、Token、账号信息、私密链接或可复现的敏感数据。`;

/** 最近版本更新内容 */
const CHANGELOG_TEXT = `3.12.4（当前版本）
• 修复最大化和还原小窗口时视口高度变化再次改写当前阅读页的问题
• 窗口尺寸变化不再自动改变 PDF 缩放比例，避免连续两轮布局造成跳页
• 增加视口尾部缓冲，阅读到文档末尾时最大化窗口也不会因滚动上限变化而被推回上一页

3.12.3
• 统一 PDF 阅读锚点，修复全屏、窗口变化和标签切回后阅读位置跳动
• 修复输入页码跳转不准确，以及跳转后滚动时页码显示被冻结的问题
• 会话按标签保存页码与页内位置，重新打开应用可准确回到上次阅读处
• 同一 PDF 在不同分屏中可分别保持各自阅读位置

3.12.2
• 修复 Ctrl + 滚轮缩放时阅读画面被二次校正、意外跳页的问题
• 缩放现在只以鼠标位置为锚点，鼠标下的 PDF 内容在放大缩小时保持不动

3.12.1
• 修复进入/退出沉浸全屏或界面重排后 PDF 阅读位置来回跳动
• 页码改为基于完整虚拟布局实时计算，滚动后页码不再固定或错误回到第 1 页
• 修复输入页码后跳转不准确，并在用户滚动时立即停止后台对齐，避免页面被锁住
• 会话快照现在保存每个标签的阅读页码，重新打开应用可恢复上次阅读位置

3.12.0
• 关于页的更新内容、许可协议与安全说明改为默认折叠，减少页面长度
• 文献阅读记录字段支持新增、重命名与删除，自定义字段内容按每篇文献独立保存
• 阅读记录字段改为长按拖拽手柄排序，并提供按压与拖动状态反馈

3.11.0
• 文库设置新增文献阅读记录表单配置，可启用、隐藏并调整 12 个结构化字段的顺序
• 关于 MinePDF 改为在设置页直接完整展示，不再通过按钮打开或折叠内容
• 笔记截图改用 PDFium 约 3× 像素密度重新渲染，显著提升图片与导出 PDF 的清晰度
• 修复高亮导入笔记后预览链接无法跳回 PDF，并修正高亮顶部坐标定位

3.10.1
• 修复翻译卡片错误包含后续普通笔记内容的问题；旧版翻译卡片现在精确截止到时间行

3.10.0
• 设置页重构为左侧分类导航 + 右侧详细设置，减少查找设置时的长距离滚动
• 笔记面板新增可折叠 Markdown 入门教程，覆盖标题、公式、表格、链接及 C / Python 代码块
• Add to Note 的翻译内容在预览与 PDF 导出中显示为独立卡片，同时保持 Markdown 可编辑和旧笔记兼容

3.9.8
• 修复翻译结果 Add to Note 后英文原文词间空格丢失的问题
• “关于 MinePDF”补齐近期版本更新记录

3.9.7
• 翻译结果弹窗移除具体翻译服务、在线来源和缓存状态显示，操作区更简洁

3.9.6
• 新增 Tencent TranSmart 与 Youdao Web 两个免 Key 翻译源
• 免 Key 服务改为短延迟竞速与自动切换，失败源临时熔断，减少等待和手动 Retry
• 增加异常译文质量检查，并修正备用服务结果的缓存复用

3.9.5
• 翻译快捷键支持自行录制，可设置任意单键或同时按下的两个键
• 分屏模式下快捷键仅作用于当前活动阅读窗格

3.9.4
• 翻译结果弹窗支持拖动，Providers 默认折叠，需密钥的服务改为点击后配置
• 删除科研术语表，新增翻译缓存说明、统计和清空按钮
• Add to Note 自动增加 Translation 序号；移除低质量的全文翻译模式

3.9.3
• 修复翻译失败时出现 Unexpected end of JSON input 的问题
• 长选区翻译改为完整分块处理，避免只翻译前半部分

3.9.2
• 阅读状态「标记为已读」改为图标+文字，面板变窄时自动只留图标（悬停有提示）

3.9.1
• 文献导出新增「摘要」列；Excel 表头与列宽按中英文实际显示宽度自适应（中文全角按 2 计）

3.9.0
• PDF 选词引擎重构：按下鼠标即锁定「页 + 旋转 + 视觉列 + 文本块」，拖拽只在同一文本区域内选词
• 旋转文字（如侧边 arXiv）、双栏另一栏、页眉/页脚/页码/图注不再被正文选区误纳入
• 新增选词几何调试层（Ctrl+Shift+E）：蓝=列、绿=行、红=字符，可直观核对分块是否正确

3.8.5
• 「导出文献」按钮改为「导出整理」；Excel 导出英文默认 Times New Roman、中文宋体
• 修复文献管理元数据填写被冲掉的问题：字段失焦保存不再整份回写草稿，避免把其他字段正在输入的内容清空

3.8.4
• 文献管理左上角新增「导出文献」与「保存」按钮，Ctrl+S 一键保存全部内容
• 关闭 PDF 标签或退出软件时，若有未保存的文献修改会弹窗提示：保存并关闭 / 不保存 / 取消
• 阅读状态（未读/阅读中/已读）改为图标+文字，面板变窄时自动只留图标

3.8.3
• 彻底修复左侧栏缩小时反复跳闪：状态筛选行的窄栏判断改为稳定测量，不再“隐藏文字↔显示文字”来回振荡

3.8.2
• 修复左侧栏拖拽缩小时宽度被状态刷新弹回的问题

3.8.1
• 标签区移至「信息」Tab（文献管理同样保留）
• 「文献管理」Tab 移到四个按钮最后；删除卷/期/页码字段
• 移除自动识别入口与相关提示
• 导出 Excel 单元格自适应宽度与行高
• 侧栏阅读状态筛选改为图标+文字，窄栏自动只留图标（悬停有提示）

3.8.0
• 信息面板重构为四个 Tab：文献管理 / 信息 / 书签 / 笔记，职责分离
• 「文献管理」新增结构化阅读记录（12 个独立字段，自动保存）
• 新增文献导出：当前文献 / 当前筛选结果 / 全部文献 / 自定义选择，支持 Excel 与 CSV
• 旧版 Markdown 阅读记录自动迁移到结构化字段，旧内容保留在「笔记」Tab
• 高亮「添加到笔记」改入普通笔记，引用可点击回跳原文

3.7.1
• 修复文献阅读记录面板闪动与编辑区过小的问题
• 打开未识别的文献时自动后台识别元数据（标题/作者/期刊/年份/DOI）

3.7.0
• 科研文献工作流升级：文献元数据自动识别（标题/作者/期刊/年份/DOI）
• 信息面板新增文献卡片：元数据编辑、阅读状态（未读/阅读中/已读）、摘要
• 新增「文献阅读记录」模板笔记，与 PDF 绑定，自动保存
• 高亮右键「添加到笔记」：插入原文引用，点击可回跳 PDF 原文页码
• 侧栏新增阅读状态筛选（全部/未读/阅读中/已读）
• 搜索扩展：支持文献元数据与笔记正文

3.6.11
• PDF 渲染诊断面板：改为不透明、可按住标题拖动

3.6.10
• 修复 PDF 文字发虚根因：PDFium 位图格式改用正确的 BGRA（原误用 BGRa 导致 LCD 亚像素抗锯齿被关闭）
• 文字/公式/细线现在具备亚像素抗锯齿，清晰度对齐 Edge

3.6.9
• 修复 PDF 发虚根因：按精确 DPI 渲染（不再向上取整到 0.25/0.5 桶），Canvas 与屏幕 1:1
• 消除浏览器二次缩小导致的 LCD 亚像素文字模糊，清晰度接近 Edge

3.6.8
• PDF 渲染诊断入口移到设置页「关于」区，打开即显示 DPR/缩放数据
• 诊断浮层优化：未翻页也能看到主进程 DPR 与缩放信息

3.6.7
• 新增 PDF 渲染运行时诊断（Ctrl+Shift+D）：显示 DPR / 位图 / Canvas / 缩放密度
• 附 PDFium 原始位图导出诊断脚本 scripts/render-diag.mjs，用于定位模糊层

3.6.6
• PDF 渲染清晰度专项优化：渲染分辨率按显示尺寸与 DPI 动态计算
• 高缩放（200%~400%）与 2K/4K 高 DPI 屏幕不再发虚，文字/公式/细线更锐利
• 渲染缓存键与实际分辨率一致，杜绝低清位图被放大显示

3.6.5
• 标签选择器重构：按钮触发下拉，搜索 + 常用/自定义分行展示，勾选切换
• 自定义标签支持直接删除（含使用数量确认），与“从文件移除标签”严格区分
• 左侧栏标签改为轻量胶囊样式，单行显示真实标签名

3.6.4
• 修复信息面板修改标题后顶部标签页/左侧栏不同步的问题（标题统一为单一数据源）
• 标签系统升级：常用预设标签 + 自定义标签，多标签连续添加
• 新增设置页标签管理：隐藏/恢复默认标签、重命名、全局删除
• 左侧栏显示真实标签名称，支持点击按标签筛选

3.6.3
• 支持 Windows 原生 Snap：二分屏 / 四分屏 / 最大化正常可用
• 窗口最小尺寸降至 480×360，可自由缩小窗口，界面自适应

3.6.2
• 修复页码输入跳转：聚焦全选、回车/失焦提交，不再逐键乱跳
• 连续跳转不再互相抢滚动位置，页码定位更稳定

3.6.1
• 修复双栏 / 多栏 PDF 跨栏误选：选词与高亮严格限制在起始栏内，同栏跨行仍正常

3.6.0
• 新增窗口状态记忆：记住上次窗口大小与位置
• PDF 工具栏新增阅读进度线
• 设置页按类重新分组，查找更清晰
• 关于面板新增隐私说明（本地存储、不上传云端）
• 笔记自动保存优化：输入即保存，切换 PDF / 面板时强制落库

3.5.18
• 新增「关于 MinePDF」面板：许可协议、安全说明、版权归属，应用内直接查看

3.5.17
• 新增界面字号设置（小 / 中 / 大），仅缩放 UI，不影响 PDF 清晰度
• 修复高亮模式下右键无法拖动平移的问题
• 临时区空状态移除多余提示文案

3.5.16
• 笔记自动保存优化：输入即保存，切换 PDF / 面板时强制落库，不再丢失内容

3.5.15
• 拖放文件 / 文件夹后不再自动折叠目录树

3.5.14
• 修复拖拽导入：拖到子文件夹进入该文件夹，知识库空白区拖放归入根目录

3.5.13
• 支持多选 PDF 拖拽批量移动`;

function ExpandableBlock({
  title,
  icon,
  summary,
  full,
}: {
  title: string;
  icon: React.ReactNode;
  summary: string;
  full: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="overflow-hidden rounded-lg border border-app-border bg-app-panel2">
      <button
        type="button"
        className="flex w-full items-start gap-2 px-3.5 py-3 text-left transition-colors hover:bg-app-base/25"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
      >
        <span className="mt-0.5 shrink-0">{icon}</span>
        <span className="min-w-0 flex-1">
          <span className="block text-[12px] font-semibold text-app-text">{title}</span>
          <span className="mt-1 block text-[11.5px] leading-relaxed text-app-text/80">{summary}</span>
        </span>
        <ChevronDown
          size={14}
          className={`mt-0.5 shrink-0 text-app-muted transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>
      {open && (
        <pre className="mx-3.5 mb-3 max-h-72 overflow-y-auto whitespace-pre-wrap rounded-md bg-app-base/60 px-3 py-2 text-[10.5px] leading-relaxed text-app-text/75">
          {full}
        </pre>
      )}
    </div>
  );
}

export function AboutContent({ appVersion }: { appVersion: string }) {
  const t = useT();
  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-app-border bg-app-panel2 px-3.5 py-3">
        <div className="flex items-center gap-2 text-[12px] font-semibold text-app-text">
          <Info size={13} className="shrink-0 text-app-accent" />
          {t('about.version')}
        </div>
        <div className="mt-2">
          <span className="rounded border border-app-border px-1.5 py-0.5 text-[11px] tabular-nums text-app-text/90">
            MinePDF v{appVersion || '—'}
          </span>
        </div>
      </div>

      <ExpandableBlock
        title={t('about.changelog')}
        icon={<Info size={13} className="shrink-0 text-app-accent" />}
        summary={t('about.changelogSummary')}
        full={CHANGELOG_TEXT}
      />
      <ExpandableBlock
        title={t('about.license')}
        icon={<FileText size={13} className="shrink-0 text-app-accent" />}
        summary={t('about.licenseBody')}
        full={MIT_LICENSE}
      />
      <ExpandableBlock
        title={t('about.security')}
        icon={<Shield size={13} className="shrink-0 text-app-accent" />}
        summary={t('about.securityBody')}
        full={SECURITY_TEXT}
      />
      <div className="rounded-lg border border-app-border bg-app-panel2 px-3.5 py-3">
        <div className="flex items-center gap-2 text-[12px] font-semibold text-app-text">
          <ShieldCheck size={13} className="shrink-0 text-app-accent" />
          {t('about.privacy')}
        </div>
        <p className="mt-1.5 text-[11.5px] leading-relaxed text-app-text/80">{t('about.privacyBody')}</p>
      </div>
      <div className="rounded-lg border border-app-border bg-app-panel2 px-3.5 py-3">
        <div className="flex items-center gap-2 text-[12px] font-semibold text-app-text">
          <Copyright size={13} className="shrink-0 text-app-accent" />
          {t('about.copyright')}
        </div>
        <p className="mt-1.5 text-[11.5px] leading-relaxed text-app-text/80">{t('about.copyrightBody')}</p>
      </div>
    </div>
  );
}

/** 关于 MinePDF：版本 / 许可协议 / 安全说明 / 版权归属 */
export function AboutModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useT();
  const [appVersion, setAppVersion] = useState('');

  useEffect(() => {
    if (open) {
      void window.pkm
        .getAppInfo()
        .then((info) => setAppVersion(info.version))
        .catch(() => undefined);
    }
  }, [open]);

  return (
    <Modal open={open} onClose={onClose} title={t('about.title')} width={520}>
      <div className="max-h-[62vh] overflow-y-auto py-1 pr-0.5">
        <AboutContent appVersion={appVersion} />
      </div>
    </Modal>
  );
}
