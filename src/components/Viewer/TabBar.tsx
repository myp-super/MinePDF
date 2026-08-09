import { FileText, Inbox, X } from 'lucide-react';
import React, { useState } from 'react';
import { useT } from '../../i18n';
import type { ReaderScreen } from '../../store';
import { useApp } from '../../store';
import { ContextMenu } from '../ui';

/**
 * 单个阅读屏的标签栏（3.1.0）
 * - 一行横向标签：点击切换、× 关闭、中键关闭
 * - 只有选中屏的标签带有高亮标记；未选中屏整体变暗，便于区分当前屏
 * - 右键菜单：关闭 / 关闭其他 / 关闭全部 ｜ 上下分屏 / 左右分屏 / 取消分屏
 */
export function TabBar({ screen, active }: { screen: ReaderScreen; active: boolean }) {
  const t = useT();
  const splitLayout = useApp((s) => s.splitLayout);
  const screenCount = useApp((s) => s.screens.length);
  const activateTab = useApp((s) => s.activateTab);
  const closeTab = useApp((s) => s.closeTab);
  const closeAllTabs = useApp((s) => s.closeAllTabs);
  const closeOtherTabs = useApp((s) => s.closeOtherTabs);
  const splitScreen = useApp((s) => s.splitScreen);
  const unsplitScreen = useApp((s) => s.unsplitScreen);
  const [menu, setMenu] = useState<{ tabId: string; x: number; y: number } | null>(null);

  if (!screen.tabs.length) return null;
  const isSplit = splitLayout !== 'single' && screenCount > 1;

  return (
    <div
      className={`flex h-8 shrink-0 items-stretch overflow-x-auto border-b bg-app-panel ${
        active
          ? 'border-b-2 border-b-app-accent/70'
          : 'border-b-app-border bg-app-panel/40'
      }`}
    >
      {screen.tabs.map((tab) => {
        const isTabActive = tab.id === screen.activeTabId;
        return (
          <div
            key={tab.id}
            className={`group relative flex min-w-0 max-w-[190px] shrink-0 items-center border-r border-app-border ${
              active && isTabActive ? 'bg-app-panel2' : 'hover:bg-app-panel2/40'
            }`}
          >
            <button
              className="flex min-w-0 flex-1 items-center gap-1.5 px-2.5 py-1 text-[11.5px]"
              onClick={() => activateTab(screen.id, tab.id)}
              onAuxClick={(e) => {
                if (e.button === 1) closeTab(screen.id, tab.id);
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
              <span
                className={`min-w-0 flex-1 truncate ${
                  active && isTabActive ? 'text-app-text' : 'text-app-muted'
                }`}
              >
                {tab.title}
              </span>
            </button>
            <button
              className="flex h-full w-6 shrink-0 items-center justify-center text-app-muted opacity-0 transition-opacity hover:bg-app-panel2 hover:text-app-text group-hover:opacity-100"
              onClick={() => closeTab(screen.id, tab.id)}
              title={t('tab.close')}
              aria-label={t('tab.close')}
            >
              <X size={12} />
            </button>
            {active && isTabActive && (
              <span className="pointer-events-none absolute inset-x-0 top-0 h-0.5 bg-app-accent" />
            )}
          </div>
        );
      })}

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={[
            { label: t('tab.close'), onClick: () => closeTab(screen.id, menu.tabId) },
            { label: t('tab.closeOthers'), onClick: () => closeOtherTabs(screen.id, menu.tabId) },
            { label: t('tab.closeAll'), onClick: () => closeAllTabs(screen.id) },
            { label: '', divider: true, onClick: () => undefined },
            { label: t('tab.splitVertical'), onClick: () => splitScreen('split-v') },
            { label: t('tab.splitHorizontal'), onClick: () => splitScreen('split-h') },
            { label: t('tab.unsplit'), onClick: () => unsplitScreen(), disabled: !isSplit },
          ]}
        />
      )}
    </div>
  );
}
