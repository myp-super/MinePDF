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
const CHANGELOG_TEXT = `3.6.0（当前版本）
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
