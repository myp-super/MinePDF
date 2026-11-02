import { ImagePlus, Pin, PinOff, Sigma, X } from 'lucide-react';
import React, { useEffect, useRef, useState } from 'react';
import { AnnotationPreview, clampPreviewScale } from './AnnotationPreview';
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
  initialLayout,
  pdfId,
  x,
  y,
  onClose,
  onSaved,
}: {
  target: NoteTarget;
  initialNote?: string;
  initialLayout?: string;
  pdfId: number;
  x: number;
  y: number;
  onClose: () => void;
  onSaved: (target: NoteTarget, note: string, layout: string) => void;
}) {
  const t = useT();
  const [note, setNote] = useState(initialNote ?? '');
  const [mode, setMode] = useState<'edit' | 'preview'>('edit');
  const [pinned, setPinned] = useState(false);
  const [assetBase, setAssetBase] = useState<string | null>(null);
  const [box, setBox] = useState(() => readLayout(initialLayout, x, y));
  const [previewScale, setPreviewScale] = useState(box.previewScale);
  const ref = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const dragRef = useRef<{ kind: 'move' | 'resize'; x: number; y: number; box: PopupLayout } | null>(null);

  useEffect(() => {
    try {
      const parsed = JSON.parse(initialLayout ?? '{}') as Partial<PopupLayout>;
      if (typeof parsed.pinned === 'boolean') setPinned(parsed.pinned);
    } catch {
      // Legacy annotations have no popup layout.
    }
  }, [initialLayout]);

  useEffect(() => {
    void window.pkm.getNote(pdfId).then((record) => {
      const dir = record?.noteDir?.replace(/\\/g, '/');
      if (dir) setAssetBase(`file://${dir}`);
    }).catch(() => undefined);
  }, [pdfId]);

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

  useEffect(() => {
    const move = (event: PointerEvent) => {
      const active = dragRef.current;
      if (!active) return;
      const dx = event.clientX - active.x;
      const dy = event.clientY - active.y;
      if (active.kind === 'move') {
        setBox((current) => ({ ...current, left: clamp(active.box.left + dx, 8, window.innerWidth - current.width - 8), top: clamp(active.box.top + dy, 8, window.innerHeight - current.height - 8) }));
      } else {
        setBox((current) => ({ ...current, width: clamp(active.box.width + dx, 264, window.innerWidth - current.left - 8), height: clamp(active.box.height + dy, 184, window.innerHeight - current.top - 8) }));
      }
    };
    const up = () => { dragRef.current = null; };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    return () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
  }, []);

  const save = () => onSaved(target, note.trim(), JSON.stringify({ ...box, pinned, previewScale }));
  const insertFormula = () => {
    const textarea = taRef.current;
    const value = '\n$$\n\\boxed{}\n$$\n';
    if (!textarea) { setNote((current) => `${current}${value}`); return; }
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    setNote((current) => `${current.slice(0, start)}${value}${current.slice(end)}`);
    requestAnimationFrame(() => { textarea.focus(); textarea.selectionStart = textarea.selectionEnd = start + value.length - 4; });
  };
  const insertImage = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    const dataUrl = await readFileAsDataUrl(file);
    const relative = await window.pkm.saveNoteImage(pdfId, dataUrl);
    const record = await window.pkm.getNote(pdfId);
    const dir = record?.noteDir?.replace(/\\/g, '/');
    if (dir) setAssetBase(`file://${dir}`);
    setNote((current) => `${current}${current.trim() ? '\n\n' : ''}![${file.name}](${relative})\n`);
  };
  const style: React.CSSProperties = { left: box.left, top: box.top, width: box.width, height: box.height, zIndex: pinned ? 120 : 80 };

  return (
    <div
      ref={ref}
      className="fixed z-[80] rounded-xl border border-app-border bg-app-panel shadow-2xl"
      style={style}
    >
      <div
        className="flex cursor-move items-center justify-between border-b border-app-border px-3 py-1.5"
        onPointerDown={(event) => { if ((event.target as HTMLElement).closest('button')) return; dragRef.current = { kind: 'move', x: event.clientX, y: event.clientY, box }; }}
      >
        <span className="text-[11px] font-semibold text-app-text/90">{t('viewer.noteTitle')}</span>
        <div className="flex items-center gap-1">
          <button
            className="flex h-6 w-6 items-center justify-center rounded-md text-app-muted transition-colors hover:bg-app-panel2 hover:text-app-text"
            onClick={() => setPinned((value) => !value)}
            title={pinned ? t('viewer.unpin') : t('viewer.pin')}
            aria-label={pinned ? t('viewer.unpin') : t('viewer.pin')}
          >
            {pinned ? <Pin size={13} /> : <PinOff size={13} />}
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
      <div className="flex h-[calc(100%-37px)] flex-col p-3">
        <div className="mb-2 flex items-center justify-between">
          <div className="flex items-center gap-1 rounded-md bg-app-base p-0.5">
            <button className={`rounded px-2 py-1 text-[10px] ${mode === 'edit' ? 'bg-app-panel2 text-app-text' : 'text-app-muted'}`} onClick={() => setMode('edit')}>{t('viewer.edit')}</button>
            <button className={`rounded px-2 py-1 text-[10px] ${mode === 'preview' ? 'bg-app-panel2 text-app-text' : 'text-app-muted'}`} onClick={() => setMode('preview')}>{t('viewer.preview')}</button>
          </div>
          {mode === 'edit' && <div className="flex items-center gap-1">
            <button className="flex h-6 w-6 items-center justify-center rounded-md text-app-muted hover:bg-app-panel2 hover:text-app-text" onClick={insertFormula} title={t('viewer.insertFormula')} aria-label={t('viewer.insertFormula')}><Sigma size={13} /></button>
            <label className="flex h-6 w-6 cursor-pointer items-center justify-center rounded-md text-app-muted hover:bg-app-panel2 hover:text-app-text" title={t('viewer.insertImage')} aria-label={t('viewer.insertImage')}><ImagePlus size={13} /><input type="file" accept="image/*" className="hidden" onChange={(event) => void insertImage(event)} /></label>
          </div>}
        </div>
        {mode === 'edit' ? <textarea
          ref={taRef}
          className="min-h-0 flex-1 w-full resize-none rounded-lg border border-app-border bg-app-base px-2.5 py-2 text-[12px] leading-relaxed outline-none placeholder:text-app-muted/50 focus:border-app-accent/60 disabled:opacity-70"
          value={note}
          placeholder={t('viewer.notePlaceholder')}
          onChange={(e) => setNote(e.target.value)}
        /> : <div className="min-h-0 flex-1 overflow-hidden rounded-lg border border-app-border bg-app-base">
          <AnnotationPreview note={note} assetBase={assetBase} scale={previewScale} onScaleChange={setPreviewScale} />
        </div>}
        <div className="mt-2 flex items-center justify-end">
          <button
            className="rounded-md bg-app-accent px-3 py-1 text-[11px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
            onClick={() => {
              save();
            }}
          >
            {t('viewer.save')}
          </button>
        </div>
      </div>
      <div className="absolute bottom-0 right-0 h-3 w-3 cursor-se-resize" onPointerDown={(event) => { event.stopPropagation(); dragRef.current = { kind: 'resize', x: event.clientX, y: event.clientY, box }; }} />
    </div>
  );
}

type PopupLayout = { left: number; top: number; width: number; height: number; pinned: boolean; previewScale: number };

function readLayout(raw: string | undefined, x: number, y: number): PopupLayout {
  try {
    const value = JSON.parse(raw ?? '{}') as Partial<PopupLayout>;
    return { left: clamp(Number(value.left) || x, 8, window.innerWidth - 272), top: clamp(Number(value.top) || y, 8, window.innerHeight - 192), width: clamp(Number(value.width) || 320, 264, window.innerWidth - 16), height: clamp(Number(value.height) || 300, 184, window.innerHeight - 16), pinned: Boolean(value.pinned), previewScale: clampPreviewScale(Number(value.previewScale) || 1) };
  } catch {
    return { left: Math.max(8, Math.min(x, window.innerWidth - 328)), top: Math.max(8, Math.min(y, window.innerHeight - 308)), width: 320, height: 300, pinned: false, previewScale: 1 };
  }
}

function clamp(value: number, min: number, max: number): number { return Math.max(min, Math.min(value, Math.max(min, max))); }

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('读取图片失败'));
    reader.readAsDataURL(file);
  });
}
