import { useRef } from 'react';
import type { PdfRecord } from '../../shared/types';
import type { ReaderScreen } from '../../store';
import { useApp } from '../../store';
import { EmptyState } from '../EmptyState';
import { PdfViewer } from './PdfViewer';
import { TabBar } from './TabBar';

/**
 * 单个阅读屏（3.1.0）：独立标签栏 + 一个 PDF 阅读器。
 * 点击屏内任意位置即选中该屏；只有选中的屏拥有高亮标记，
 * 且只有选中的屏响应信息面板的书签跳转/页码同步。
 */
export function ScreenViewer({
  screen,
  active,
  onMissing,
}: {
  screen: ReaderScreen;
  active: boolean;
  onMissing: (p: PdfRecord) => void;
}) {
  const activateScreen = useApp((s) => s.activateScreen);
  const pdfs = useApp((s) => s.pdfs);
  const inboxPdfs = useApp((s) => s.inboxPdfs);
  const activeTab = screen.tabs.find((t) => t.id === screen.activeTabId) ?? screen.tabs[0];
  const pdf = activeTab
    ? activeTab.kind === 'inbox'
      ? inboxPdfs.find((p) => p.id === activeTab.pdfId)
      : pdfs.find((p) => p.id === activeTab.pdfId)
    : undefined;

  return (
    <div
      className="flex min-h-0 min-w-0 flex-1 flex-col"
      onClick={() => activateScreen(screen.id)}
    >
      <TabBar screen={screen} active={active} />
      {pdf ? (
        <PdfViewer pdf={pdf} paneId={screen.id} onMissing={onMissing} paneActive={active} />
      ) : (
        <div className="flex min-h-0 flex-1">
          <EmptyState />
        </div>
      )}
    </div>
  );
}

/** 分屏分隔线：可拖拽调整相邻屏的宽/高 */
export function SplitDivider({
  orientation,
  ratio,
  onRatio,
}: {
  orientation: 'v' | 'h';
  ratio: number;
  onRatio: (r: number) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; ratio: number } | null>(null);

  const onMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    drag.current = { x: e.clientX, y: e.clientY, ratio };
    const onMove = (ev: MouseEvent) => {
      const d = drag.current;
      const el = ref.current;
      if (!d || !el) return;
      const parent = el.parentElement;
      if (!parent) return;
      const size = orientation === 'v' ? parent.clientWidth : parent.clientHeight;
      const delta = orientation === 'v' ? ev.clientX - d.x : ev.clientY - d.y;
      if (size > 0) onRatio(d.ratio + delta / size);
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      drag.current = null;
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  return (
    <div
      ref={ref}
      data-split-divider="true"
      className={`shrink-0 bg-app-border transition-colors hover:bg-app-accent/60 active:bg-app-accent ${
        orientation === 'v' ? 'w-1 cursor-col-resize' : 'h-1 cursor-row-resize'
      }`}
      onMouseDown={onMouseDown}
    />
  );
}
