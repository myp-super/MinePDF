import { MoreVertical, X } from 'lucide-react';
import React, { useEffect, useRef, useState } from 'react';
import { useT } from '../../i18n';
import type { AnnotationRecord } from '../../shared/types';
import { ContextMenu } from '../ui';

/**
 * 高亮标注弹窗：在高亮旁弹出，可写入/编辑标注。
 * 右上角 × 关闭、⋮（编辑/删除标注）；底部「保存」写入。
 */
export function AnnotationNotePopup({
  a,
  x,
  y,
  onClose,
  onSaved,
  onDelete,
}: {
  a: AnnotationRecord;
  x: number;
  y: number;
  onClose: () => void;
  onSaved: (a: AnnotationRecord, note: string) => void;
  onDelete: (a: AnnotationRecord) => void;
}) {
  const t = useT();
  const [note, setNote] = useState(a.note ?? '');
  const [editing, setEditing] = useState(!(a.note && a.note.trim()));
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

  // 点击外部 / Esc 关闭
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  // 编辑模式自动聚焦
  useEffect(() => {
    if (editing) taRef.current?.focus();
  }, [editing]);

  const W = 264;
  const H = 196;
  const style: React.CSSProperties = {
    left: Math.max(8, Math.min(x, window.innerWidth - W - 8)),
    top: Math.max(8, Math.min(y, window.innerHeight - H - 8)),
    width: W,
  };

  return (
    <div
      ref={ref}
      className="fixed z-[80] rounded-xl border border-app-border bg-app-panel shadow-2xl"
      style={style}
    >
      <div className="flex items-center justify-between border-b border-app-border px-3 py-1.5">
        <span className="text-[11px] font-semibold text-app-text/90">{t('viewer.noteTitle')}</span>
        <div className="flex items-center gap-0.5">
          <button
            className="flex h-6 w-6 items-center justify-center rounded-md text-app-muted transition-colors hover:bg-app-panel2 hover:text-app-text"
            onClick={(e) => {
              e.stopPropagation();
              const r = e.currentTarget.getBoundingClientRect();
              setMenu({ x: r.left, y: r.bottom + 4 });
            }}
            title={t('viewer.edit')}
            aria-label={t('viewer.edit')}
          >
            <MoreVertical size={13} />
          </button>
          <button
            className="flex h-6 w-6 items-center justify-center rounded-md text-app-muted transition-colors hover:bg-app-panel2 hover:text-app-text"
            onClick={onClose}
            title="×"
            aria-label="×"
          >
            <X size={14} />
          </button>
        </div>
      </div>
      <div className="p-3">
        <textarea
          ref={taRef}
          className="h-24 w-full resize-none rounded-lg border border-app-border bg-app-base px-2.5 py-2 text-[12px] leading-relaxed outline-none placeholder:text-app-muted/50 focus:border-app-accent/60 disabled:opacity-70"
          value={note}
          readOnly={!editing}
          placeholder={t('viewer.notePlaceholder')}
          onChange={(e) => setNote(e.target.value)}
        />
        <div className="mt-2 flex items-center justify-between">
          <span className="truncate text-[10px] text-app-muted">
            {a.content ? a.content.slice(0, 24) + (a.content.length > 24 ? '…' : '') : ''}
          </span>
          <button
            className="rounded-md bg-app-accent px-3 py-1 text-[11px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
            disabled={!editing}
            onClick={() => {
              setEditing(false);
              onSaved(a, note.trim());
            }}
          >
            {t('viewer.save')}
          </button>
        </div>
      </div>
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={[
            {
              label: t('viewer.edit'),
              onClick: () => {
                setEditing(true);
                setMenu(null);
              },
            },
            {
              label: t('viewer.deleteNote'),
              danger: true,
              onClick: () => {
                setMenu(null);
                onDelete(a);
              },
            },
          ]}
        />
      )}
    </div>
  );
}
