import React, { useRef, useState } from 'react';
import { useT } from '../i18n';

/** Obsidian 风格笔记编辑器：Markdown 源码 + 右键格式/段落/剪贴板菜单。 */
export function NoteEditor({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  const t = useT();
  const taRef = useRef<HTMLTextAreaElement>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);

  const update = (next: string, selStart?: number, selEnd?: number) => {
    onChange(next);
    requestAnimationFrame(() => {
      const ta = taRef.current;
      if (ta) {
        ta.focus();
        if (selStart != null && selEnd != null) ta.setSelectionRange(selStart, selEnd);
      }
    });
  };

  const selection = () => {
    const ta = taRef.current;
    if (!ta) return { start: 0, end: 0, text: '' };
    return {
      start: ta.selectionStart,
      end: ta.selectionEnd,
      text: value.slice(ta.selectionStart, ta.selectionEnd),
    };
  };

  const wrap = (before: string, after: string) => {
    const { start, end, text } = selection();
    const selected = text || '文本';
    update(
      value.slice(0, start) + before + selected + after + value.slice(end),
      start + before.length,
      start + before.length + selected.length,
    );
    setMenu(null);
  };

  const setBlock = (level: number | 'paragraph') => {
    const ta = taRef.current;
    if (!ta) return;
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    const lineStart = value.lastIndexOf('\n', start - 1) + 1;
    const lineEndIdx = value.indexOf('\n', end);
    const blockEnd = lineEndIdx === -1 ? value.length : lineEndIdx;
    const block = value.slice(lineStart, blockEnd);
    const nextLines =
      level === 'paragraph'
        ? block.split('\n').map((l) => l.replace(/^#{1,6}\s*/, ''))
        : block.split('\n').map((l) => (l.startsWith('#'.repeat(level) + ' ') ? l : '#'.repeat(level) + ' ' + l));
    update(value.slice(0, lineStart) + nextLines.join('\n') + value.slice(blockEnd), start, end);
    setMenu(null);
  };

  const stripFormat = () => {
    const { start, end, text } = selection();
    let out = text;
    const pairs: Array<[string, string]> = [
      ['**', '**'],
      ['==', '=='],
      ['~~', '~~'],
      ['*', '*'],
      ['$', '$'],
    ];
    let changed = true;
    while (changed) {
      changed = false;
      for (const [b, a] of pairs) {
        if (out.startsWith(b) && out.endsWith(a) && out.length > b.length + a.length) {
          out = out.slice(b.length, out.length - a.length);
          changed = true;
        }
      }
      if (out.startsWith('`') && out.endsWith('`') && out.length > 2) {
        out = out.slice(1, -1);
        changed = true;
      }
    }
    update(value.slice(0, start) + out + value.slice(end), start, start + out.length);
    setMenu(null);
  };

  const clipboard = async (op: 'cut' | 'copy' | 'paste') => {
    const { start, end, text } = selection();
    try {
      if (op === 'cut' || op === 'copy') {
        await navigator.clipboard.writeText(text);
        if (op === 'cut') update(value.slice(0, start) + value.slice(end), start, start);
      } else {
        const clip = await navigator.clipboard.readText();
        update(value.slice(0, start) + clip + value.slice(end), start + clip.length, start + clip.length);
      }
    } catch {
      /* ignore */
    }
    setMenu(null);
  };

  const menuItem = (label: string, onClick: () => void, shortcut?: string) => (
    <button
      className="flex w-full items-center justify-between gap-4 px-3 py-1.5 text-left text-xs text-app-text transition-colors hover:bg-app-panel2"
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
    >
      <span>{label}</span>
      {shortcut && <span className="text-[10px] text-app-muted">{shortcut}</span>}
    </button>
  );

  const group = (title: string, children: React.ReactNode) => (
    <div className="py-0.5">
      <div className="px-3 py-1 text-[10px] font-medium uppercase tracking-wide text-app-muted">{title}</div>
      {children}
    </div>
  );

  const divider = <div className="mx-2 my-0.5 h-px bg-app-border" />;

  return (
    <>
      <textarea
        ref={taRef}
        className="min-h-0 flex-1 resize-none bg-transparent px-3.5 py-3 font-mono text-[12.5px] leading-relaxed outline-none placeholder:text-app-muted/60"
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onContextMenu={(e) => {
          e.preventDefault();
          setMenu({ x: e.clientX, y: e.clientY });
        }}
        onKeyDown={(e) => {
          if (e.key === 'Tab') {
            e.preventDefault();
            const ta = e.target as HTMLTextAreaElement;
            const { selectionStart, selectionEnd } = ta;
            const next = value.slice(0, selectionStart) + '  ' + value.slice(selectionEnd);
            update(next, selectionStart + 2, selectionStart + 2);
          }
        }}
      />
      {menu && (
        <div
          className="animate-pop fixed z-[70] max-h-[70vh] w-52 overflow-y-auto rounded-lg border border-app-border bg-app-panel py-1 shadow-2xl"
          style={{ left: Math.min(menu.x, window.innerWidth - 220), top: Math.min(menu.y, window.innerHeight - 420) }}
          onMouseLeave={() => setMenu(null)}
        >
          {group(t('note.editor.format'), (
            <>
              {menuItem(t('note.editor.bold'), () => wrap('**', '**'), 'Ctrl+B')}
              {menuItem(t('note.editor.italic'), () => wrap('*', '*'), 'Ctrl+I')}
              {menuItem(t('note.editor.strike'), () => wrap('~~', '~~'), 'Ctrl+Shift+X')}
              {menuItem(t('note.editor.highlight'), () => wrap('==', '=='), 'Ctrl+Shift+H')}
              {menuItem(t('note.editor.code'), () => wrap('`', '`'), 'Ctrl+E')}
              {menuItem(t('note.editor.math'), () => wrap('$', '$'))}
              {menuItem(t('note.editor.comment'), () => wrap('<!-- ', ' -->'))}
              {menuItem(t('note.editor.clear'), stripFormat)}
            </>
          ))}
          {divider}
          {group(t('note.editor.paragraph'), (
            <>
              {menuItem(t('note.editor.paragraphText'), () => setBlock('paragraph'), 'Ctrl+0')}
              {menuItem(t('note.editor.h1'), () => setBlock(1), 'Ctrl+1')}
              {menuItem(t('note.editor.h2'), () => setBlock(2), 'Ctrl+2')}
              {menuItem(t('note.editor.h3'), () => setBlock(3), 'Ctrl+3')}
              {menuItem(t('note.editor.h4'), () => setBlock(4), 'Ctrl+4')}
              {menuItem(t('note.editor.h5'), () => setBlock(5), 'Ctrl+5')}
              {menuItem(t('note.editor.h6'), () => setBlock(6), 'Ctrl+6')}
            </>
          ))}
          {divider}
          {group(t('note.editor.actions'), (
            <>
              {menuItem(t('note.editor.cut'), () => void clipboard('cut'), 'Ctrl+X')}
              {menuItem(t('note.editor.copy'), () => void clipboard('copy'), 'Ctrl+C')}
              {menuItem(t('note.editor.paste'), () => void clipboard('paste'), 'Ctrl+V')}
              {menuItem(t('note.editor.pasteText'), () => void clipboard('paste'), 'Ctrl+Shift+V')}
              {menuItem(t('note.editor.selectAll'), () => {
                taRef.current?.select();
                setMenu(null);
              }, 'Ctrl+A')}
            </>
          ))}
        </div>
      )}
    </>
  );
}
