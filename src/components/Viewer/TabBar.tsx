import { FileText, Inbox, X } from 'lucide-react';
import React, { useRef, useState } from 'react';
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
  const reorderTab = useApp((s) => s.reorderTab);
  const splitScreen = useApp((s) => s.splitScreen);
  const unsplitScreen = useApp((s) => s.unsplitScreen);
  // 标签标题不各自保存快照，统一从 File Metadata 派生（重命名后自动同步）
  const pdfs = useApp((s) => s.pdfs);
  const inboxPdfs = useApp((s) => s.inboxPdfs);
  const [menu, setMenu] = useState<{ tabId: string; x: number; y: number } | null>(null);
  // 浏览器标签页式拖拽排序：按下即移动（位移超过极小阈值立即进入拖拽），无长按计时
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const downRef = useRef<{ x: number; y: number; tabId: string } | null>(null);
  const dragStartedRef = useRef(false);
  const draggingIdRef = useRef<string | null>(null);
  /** 上一次实时插入索引，避免同一位置反复 reorder 抖动 */
  const lastReorderRef = useRef(-1);
  const suppressClickRef = useRef(false);

  const onTabPointerDown = (e: React.PointerEvent, tabId: string) => {
    if (e.button !== 0) return;
    downRef.current = { x: e.clientX, y: e.clientY, tabId };
    dragStartedRef.current = false;

    const onMove = (e: PointerEvent) => {
      const down = downRef.current;
      if (!down) return;
      // 未进入拖拽：一旦发生实际位移（>5px），立即进入拖拽排序（无需长按）
      if (!dragStartedRef.current) {
        const dx = e.clientX - down.x;
        const dy = e.clientY - down.y;
        if (Math.abs(dx) + Math.abs(dy) <= 5) return;
        dragStartedRef.current = true;
        suppressClickRef.current = true; // 本次 click 禁止触发切换/跳转
        draggingIdRef.current = down.tabId;
        lastReorderRef.current = -1;
        setDraggingId(down.tabId);
      }
      const from = draggingIdRef.current;
      if (!from) return;
      // 其他标签的插入槽位：指针 X 与各标签中心比较，越过后移一位；实时让位
      const els = Array.from(document.querySelectorAll('[data-tab-id]')).filter(
        (el) => el.getAttribute('data-tab-id') !== from,
      );
      if (!els.length) return;
      const x = e.clientX;
      let toIndex = els.length;
      for (let i = 0; i < els.length; i++) {
        const r = els[i].getBoundingClientRect();
        if (x < r.left + r.width / 2) {
          toIndex = i;
          break;
        }
      }
      if (toIndex === lastReorderRef.current) return;
      lastReorderRef.current = toIndex;
      reorderTab(screen.id, from, toIndex);
    };

    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      downRef.current = null;
      dragStartedRef.current = false;
      draggingIdRef.current = null;
      lastReorderRef.current = -1;
      setDraggingId(null);
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

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
        const pdf =
          tab.kind === 'inbox'
            ? inboxPdfs.find((p) => p.id === tab.pdfId)
            : pdfs.find((p) => p.id === tab.pdfId);
        const tabTitle = pdf?.title || pdf?.filename || '';
        return (
          <div
            key={tab.id}
            data-tab-id={tab.id}
            onPointerDown={(e) => onTabPointerDown(e, tab.id)}
            className={`group relative flex min-w-0 max-w-[190px] shrink-0 select-none items-center border-r border-app-border ${
              active && isTabActive ? 'bg-app-panel2' : 'hover:bg-app-panel2/40'
            } ${draggingId === tab.id ? 'z-10 opacity-80 shadow-md' : ''}`}
          >
            <button
              className="flex min-w-0 flex-1 items-center gap-1.5 px-2.5 py-1 text-[11.5px]"
              onClick={() => {
                if (suppressClickRef.current) {
                  suppressClickRef.current = false;
                  return;
                }
                activateTab(screen.id, tab.id);
              }}
              onAuxClick={(e) => {
                if (e.button === 1) closeTab(screen.id, tab.id);
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                setMenu({ tabId: tab.id, x: e.clientX, y: e.clientY });
              }}
              title={tabTitle}
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
                {tabTitle}
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
