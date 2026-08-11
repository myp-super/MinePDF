import { X } from 'lucide-react';
import React, { useEffect, useRef, useState } from 'react';
import { useT } from '../../i18n';
import type { Quad } from '../../shared/types';

/** 标注目标：已有高亮 / 从选区新建高亮 */
export type NoteTarget =
  | { kind: 'existing'; id: number }
  | { kind: 'new'; pages: { page: number; quads: Quad[] }[]; content: string; color: string };

/**
 * 高亮标注弹窗：在高亮旁弹出，直接进入编辑。
 * 右上角 × 关闭；底部「保存」写入。删除/删除标注走右键菜单。
 */
export function AnnotationNotePopup({
  target,
  initialNote,
  x,
  y,
  onClose,
  onSaved,
}: {
  target: NoteTarget;
  initialNote?: string;
  x: number;
  y: number;
  onClose: () => void;
  onSaved: (target: NoteTarget, note: string) => void;
}) {
  const t = useT();
  const [note, setNote] = useState(initialNote ?? '');
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

  // 打开即聚焦编辑
  useEffect(() => {
    taRef.current?.focus();
  }, []);

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
        <button
          className="flex h-6 w-6 items-center justify-center rounded-md text-app-muted transition-colors hover:bg-app-panel2 hover:text-app-text"
          onClick={onClose}
          title="×"
          aria-label="×"
        >
          <X size={14} />
        </button>
      </div>
      <div className="p-3">
        <textarea
          ref={taRef}
          className="h-24 w-full resize-none rounded-lg border border-app-border bg-app-base px-2.5 py-2 text-[12px] leading-relaxed outline-none placeholder:text-app-muted/50 focus:border-app-accent/60 disabled:opacity-70"
          value={note}
          placeholder={t('viewer.notePlaceholder')}
          onChange={(e) => setNote(e.target.value)}
        />
        <div className="mt-2 flex items-center justify-end">
          <button
            className="rounded-md bg-app-accent px-3 py-1 text-[11px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
            onClick={() => {
              onSaved(target, note.trim());
            }}
          >
            {t('viewer.save')}
          </button>
        </div>
      </div>
    </div>
  );
}
