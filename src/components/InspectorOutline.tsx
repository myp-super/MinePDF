import { BookMarked } from 'lucide-react';
import React from 'react';
import { useT } from '../i18n';
import type { OutlineNode } from '../lib/pdf';
import { useApp } from '../store';

/** 信息面板内的书签（PDF 内置目录）列表：点击快速跳转。 */
export function InspectorOutline({ items }: { items: OutlineNode[] }) {
  const t = useT();
  const currentPage = useApp((s) => s.currentPage);
  const requestJump = useApp((s) => s.requestJump);

  if (items.length === 0) {
    return (
      <div className="flex h-40 flex-col items-center justify-center gap-2 px-6 text-center">
        <BookMarked size={22} className="text-app-muted/40" />
        <p className="text-[11.5px] text-app-muted">{t('outline.empty')}</p>
      </div>
    );
  }

  return (
    <div className="py-1">
      {items.map((node, i) => (
        <OutlineItem key={i} node={node} depth={0} currentPage={currentPage} onJump={requestJump} />
      ))}
    </div>
  );
}

function OutlineItem({
  node,
  depth,
  currentPage,
  onJump,
}: {
  node: OutlineNode;
  depth: number;
  currentPage: number;
  onJump: (page: number) => void;
}) {
  const active = node.page != null && node.page === currentPage;
  const canJump = node.page != null;
  return (
    <div>
      <button
        className={`flex w-full items-center gap-1.5 py-[3px] pr-2 text-left text-[11.5px] transition-colors ${
          active
            ? 'bg-app-accent/15 text-app-accent'
            : canJump
              ? 'text-app-text/85 hover:bg-app-panel2'
              : 'cursor-default text-app-muted'
        }`}
        style={{ paddingLeft: 8 + depth * 12 }}
        disabled={!canJump}
        onClick={() => node.page != null && onJump(node.page)}
        title={node.title}
      >
        <span className="min-w-0 flex-1 truncate">{node.title}</span>
        {node.page != null && (
          <span className="shrink-0 text-[9.5px] tabular-nums text-app-muted">{node.page}</span>
        )}
      </button>
      {node.children.map((child, i) => (
        <OutlineItem key={i} node={child} depth={depth + 1} currentPage={currentPage} onJump={onJump} />
      ))}
    </div>
  );
}
