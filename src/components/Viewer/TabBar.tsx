import { FileText, Inbox, X } from 'lucide-react';
import React, { useState } from 'react';
import { useT } from '../../i18n';
import { useApp } from '../../store';
import { ContextMenu } from '../ui';

/**
 * 网页式文档页签条（3.0.0）
 * - 点击切换、× 关闭、中键关闭
 * - 当前标签高亮（顶部蓝条 + 加深背景）
 * - 右键菜单：关闭 / 关闭其他 / 关闭全部 ｜ 上下分屏 / 左右分屏 / 取消分屏
 */
export function TabBar() {
  const t = useT();
  const tabs = useApp((s) => s.tabs);
  const activeTabId = useApp((s) => s.activeTabId);
  const splits = useApp((s) => s.splits);
  const activateTab = useApp((s) => s.activateTab);
  const closeTab = useApp((s) => s.closeTab);
  const closeAllTabs = useApp((s) => s.closeAllTabs);
  const closeOtherTabs = useApp((s) => s.closeOtherTabs);
  const splitTab = useApp((s) => s.splitTab);
  const unsplitTab = useApp((s) => s.unsplitTab);
  const [menu, setMenu] = useState<{ tabId: string; x: number; y: number } | null>(null);

  if (!tabs.length) return null;

  const menuTab = menu ? tabs.find((tab) => tab.id === menu.tabId) : null;
  const menuSplit = menu ? splits[menu.tabId] : null;
  const menuIsSplit = !!menuSplit && menuSplit.layout !== 'single';

  return (
    <div className="flex h-8 shrink-0 items-stretch overflow-x-auto border-b border-app-border bg-app-panel">
      {tabs.map((tab) => {
        const active = tab.id === activeTabId;
        const split = splits[tab.id];
        const isSplit = !!split && split.layout !== 'single';
        return (
          <div
            key={tab.id}
            className={`group relative flex min-w-0 max-w-[190px] shrink-0 items-center border-r border-app-border ${
              active ? 'bg-app-panel2' : 'hover:bg-app-panel2/40'
            }`}
          >
            <button
              className="flex min-w-0 flex-1 items-center gap-1.5 px-2.5 py-1 text-[11.5px]"
              onClick={() => activateTab(tab.id)}
              onAuxClick={(e) => {
                if (e.button === 1) closeTab(tab.id);
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                setMenu({ tabId: tab.id, x: e.clientX, y: e.clientY });
              }}
              title={tab.title}
            >
              {tab.kind === 'inbox' ? (
                <Inbox size={12} className="shrink-0 text-app-muted" />
              ) : (
                <FileText size={12} className="shrink-0 text-app-muted" />
              )}
              <span className={`min-w-0 flex-1 truncate ${active ? 'text-app-text' : 'text-app-muted'}`}>
                {tab.title}
              </span>
              {isSplit && (
                <span className="shrink-0 rounded bg-app-accent/15 px-1 text-[9px] leading-4 text-app-accent">
                  {t('tab.splitShort')}
                </span>
              )}
            </button>
            <button
              className="flex h-full w-6 shrink-0 items-center justify-center text-app-muted opacity-0 transition-opacity hover:bg-app-panel2 hover:text-app-text group-hover:opacity-100"
              onClick={() => closeTab(tab.id)}
              title={t('tab.close')}
              aria-label={t('tab.close')}
            >
              <X size={12} />
            </button>
            {active && <span className="pointer-events-none absolute inset-x-0 top-0 h-0.5 bg-app-accent" />}
          </div>
        );
      })}

      {menu && menuTab && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={[
            { label: t('tab.close'), onClick: () => closeTab(menu.tabId) },
            { label: t('tab.closeOthers'), onClick: () => closeOtherTabs(menu.tabId) },
            { label: t('tab.closeAll'), onClick: () => closeAllTabs() },
            { label: '', divider: true, onClick: () => undefined },
            { label: t('tab.splitVertical'), onClick: () => splitTab(menu.tabId, 'split-v') },
            { label: t('tab.splitHorizontal'), onClick: () => splitTab(menu.tabId, 'split-h') },
            {
              label: t('tab.unsplit'),
              onClick: () => unsplitTab(menu.tabId),
              disabled: !menuIsSplit,
            },
          ]}
        />
      )}
    </div>
  );
}
