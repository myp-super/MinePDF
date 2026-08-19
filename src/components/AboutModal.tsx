import { ChevronDown, ChevronRight, Copyright, FileText, Info, Shield, ShieldCheck } from 'lucide-react';
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
const CHANGELOG_TEXT = `3.8.1（当前版本）
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
    <div className="rounded-lg border border-app-border bg-app-panel2 px-3.5 py-3">
      <div className="flex items-center gap-2 text-[12px] font-semibold text-app-text">
        {icon}
        {title}
      </div>
      <p className="mt-1.5 text-[11.5px] leading-relaxed text-app-text/80">{summary}</p>
      <button
        className="mt-1.5 flex items-center gap-1 text-[11.5px] text-app-accent transition-colors hover:text-app-text"
        onClick={() => setOpen((v) => !v)}
      >
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        {open ? '收起' : '查看完整内容'}
      </button>
      {open && (
        <pre className="mt-2 max-h-56 overflow-y-auto whitespace-pre-wrap rounded-md bg-app-base/60 px-3 py-2 text-[10.5px] leading-relaxed text-app-text/75">
          {full}
        </pre>
      )}
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
      <div className="max-h-[62vh] space-y-4 overflow-y-auto py-1 pr-0.5">
        {/* 版本信息 */}
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

        {/* 更新内容 */}
        <ExpandableBlock
          title={t('about.changelog')}
          icon={<Info size={13} className="shrink-0 text-app-accent" />}
          summary={t('about.changelogSummary')}
          full={CHANGELOG_TEXT}
        />

        {/* 许可协议 */}
        <ExpandableBlock
          title={t('about.license')}
          icon={<FileText size={13} className="shrink-0 text-app-accent" />}
          summary={t('about.licenseBody')}
          full={MIT_LICENSE}
        />

        {/* 安全说明 */}
        <ExpandableBlock
          title={t('about.security')}
          icon={<Shield size={13} className="shrink-0 text-app-accent" />}
          summary={t('about.securityBody')}
          full={SECURITY_TEXT}
        />

        {/* 隐私说明 */}
        <div className="rounded-lg border border-app-border bg-app-panel2 px-3.5 py-3">
          <div className="flex items-center gap-2 text-[12px] font-semibold text-app-text">
            <ShieldCheck size={13} className="shrink-0 text-app-accent" />
            {t('about.privacy')}
          </div>
          <p className="mt-1.5 text-[11.5px] leading-relaxed text-app-text/80">{t('about.privacyBody')}</p>
        </div>

        {/* 版权归属 */}
        <div className="rounded-lg border border-app-border bg-app-panel2 px-3.5 py-3">
          <div className="flex items-center gap-2 text-[12px] font-semibold text-app-text">
            <Copyright size={13} className="shrink-0 text-app-accent" />
            {t('about.copyright')}
          </div>
          <p className="mt-1.5 text-[11.5px] leading-relaxed text-app-text/80">{t('about.copyrightBody')}</p>
        </div>
      </div>
    </Modal>
  );
}
