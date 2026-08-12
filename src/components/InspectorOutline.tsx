import { BookMarked, ChevronDown, ChevronRight, LocateFixed, Search, UnfoldVertical } from 'lucide-react';
import React, { useMemo, useRef, useState } from 'react';
import { useT } from '../i18n';
import type { OutlineNode } from '../lib/pdf';
import { useApp } from '../store';

/** 书签（PDF 内置目录）：支持搜索、定位当前章节、标题折叠/一键展开 */
export function InspectorOutline({ items }: { items: OutlineNode[] }) {
  const t = useT();
  const currentPage = useApp((s) => s.currentPage);
  const requestJump = useApp((s) => s.requestJump);
  const [query, setQuery] = useState('');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [allCollapsed, setAllCollapsed] = useState(false);
  const itemRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  // 收集所有节点 key（index 路径，如 "0_1"）
  const allKeys = (nodes: OutlineNode[], prefix: string): string[] => {
    const keys: string[] = [];
    nodes.forEach((n, i) => {
      const key = prefix ? `${prefix}_${i}` : String(i);
      keys.push(key);
      if (n.children?.length) keys.push(...allKeys(n.children, key));
    });
    return keys;
  };

  // 搜索过滤：保留匹配节点及其祖先
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    const walk = (nodes: OutlineNode[], prefix: string): OutlineNode[] =>
      nodes
        .map((n, i) => {
          const key = prefix ? `${prefix}_${i}` : String(i);
          const children = n.children?.length ? walk(n.children, key) : [];
          const match = n.title.toLowerCase().includes(q);
          if (match || children.length) return { ...n, children };
          return null;
        })
        .filter((x): x is OutlineNode => x != null);
    return walk(items, '');
  }, [items, query]);

  const toggleNode = (key: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  /** 定位当前章节：页码 ≤ 当前页的最近节点，展开其父链并滚动到可视区（不高亮） */
  const locateCurrent = () => {
    type Cand = { key: string; page: number; depth: number };
    const pick = (a: Cand | null, b: Cand): Cand => {
      if (!a) return b;
      if (b.page > a.page || (b.page === a.page && b.depth > a.depth)) return b;
      return a;
    };
    const findBest = (nodes: OutlineNode[], prefix: string, depth: number): Cand | null => {
      let best: Cand | null = null;
      for (let i = 0; i < nodes.length; i++) {
        const n = nodes[i];
        const key = prefix ? `${prefix}_${i}` : String(i);
        if (n.page != null && n.page <= currentPage) {
          best = pick(best, { key, page: n.page, depth });
        }
        if (n.children?.length) {
          const child = findBest(n.children, key, depth + 1);
          if (child) best = pick(best, child);
        }
      }
      return best;
    };
    const best = findBest(items, '', 0);
    if (!best) return;
    // 展开祖先链
    const parts = best.key.split('_');
    setCollapsed((prev) => {
      const next = new Set(prev);
      for (let i = 1; i < parts.length; i++) next.delete(parts.slice(0, i).join('_'));
      return next;
    });
    setAllCollapsed(false);
    setTimeout(() => {
      itemRefs.current.get(best.key)?.scrollIntoView({ block: 'nearest' });
    }, 80);
  };

  const toggleCollapseAll = () => {
    setCollapsed(allCollapsed ? new Set() : new Set(allKeys(items, '')));
    setAllCollapsed(!allCollapsed);
  };

  if (items.length === 0) {
    return (
      <div className="flex h-40 flex-col items-center justify-center gap-2 px-6 text-center">
        <BookMarked size={22} className="text-app-muted/40" />
        <p className="text-[11.5px] text-app-muted">{t('outline.empty')}</p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center gap-1 border-b border-app-border px-2 py-1.5">
        <div className="relative min-w-0 flex-1">
          <Search size={12} className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-app-muted" />
          <input
            className="h-6 w-full rounded-md border border-app-border bg-app-panel2 pl-6 pr-2 text-[11px] outline-none placeholder:text-app-muted/60 focus:border-app-accent/60"
            placeholder={t('outline.search')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <button
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-app-muted transition-colors hover:bg-app-panel2 hover:text-app-text"
          title={t('outline.locate')}
          aria-label={t('outline.locate')}
          onClick={locateCurrent}
        >
          <LocateFixed size={13} />
        </button>
        <button
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-app-muted transition-colors hover:bg-app-panel2 hover:text-app-text"
          title={allCollapsed ? t('outline.expandAll') : t('outline.collapseAll')}
          aria-label={allCollapsed ? t('outline.expandAll') : t('outline.collapseAll')}
          onClick={toggleCollapseAll}
        >
          <UnfoldVertical size={13} />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto py-1">
        {filtered.map((node, i) => (
          <OutlineItem
            key={String(i)}
            node={node}
            depth={0}
            path={String(i)}
            query={query.trim().toLowerCase()}
            collapsed={collapsed}
            itemRefs={itemRefs}
            onJump={requestJump}
            onToggle={toggleNode}
          />
        ))}
      </div>
    </div>
  );
}

function OutlineItem({
  node,
  depth,
  path,
  query,
  collapsed,
  itemRefs,
  onJump,
  onToggle,
}: {
  node: OutlineNode;
  depth: number;
  path: string;
  query: string;
  collapsed: Set<string>;
  itemRefs: React.MutableRefObject<Map<string, HTMLDivElement>>;
  onJump: (page: number, top?: number | null) => void;
  onToggle: (key: string) => void;
}) {
  const hasChildren = !!node.children?.length;
  const isCollapsed = collapsed.has(path);
  const canJump = node.page != null;
  // 搜索模式下匹配的节点保持展开
  const forceOpen = query.length > 0;

  return (
    <div ref={(el) => el && itemRefs.current.set(path, el)}>
      <div className="flex w-full items-center gap-0.5 pr-2 text-left text-[11.5px]" style={{ paddingLeft: 4 + depth * 11 }}>
        {hasChildren ? (
          <button
            className="flex h-4 w-4 shrink-0 items-center justify-center text-app-muted transition-colors hover:text-app-text"
            onClick={() => onToggle(path)}
            aria-label="toggle"
          >
            {isCollapsed && !forceOpen ? <ChevronRight size={11} /> : <ChevronDown size={11} />}
          </button>
        ) : (
          <span className="h-4 w-4 shrink-0" />
        )}
        <button
          className={`min-w-0 flex-1 py-[3px] text-left transition-colors ${
            canJump ? 'text-app-text/85 hover:text-app-text' : 'cursor-default text-app-muted'
          }`}
          disabled={!canJump}
          onClick={() => {
            if (node.page != null) {
              onJump(node.page, node.top ?? null);
            }
          }}
          title={node.title}
        >
          <span className="block break-words leading-snug">{node.title}</span>
        </button>
        {node.page != null && (
          <span className="shrink-0 text-[9.5px] tabular-nums text-app-muted">{node.page}</span>
        )}
      </div>
      {hasChildren &&
        !(isCollapsed && !forceOpen) &&
        node.children!.map((child, i) => (
          <OutlineItem
            key={`${path}_${i}`}
            node={child}
            depth={depth + 1}
            path={`${path}_${i}`}
            query={query}
            collapsed={collapsed}
            itemRefs={itemRefs}
            onJump={onJump}
            onToggle={onToggle}
          />
        ))}
    </div>
  );
}
