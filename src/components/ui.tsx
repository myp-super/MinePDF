import { clsx } from 'clsx';
import React, { useEffect, useRef } from 'react';
import { useT } from '../i18n';

export function Button({
  variant = 'ghost',
  size = 'md',
  className,
  children,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'ghost' | 'primary' | 'danger' | 'outline';
  size?: 'sm' | 'md';
}) {
  return (
    <button
      className={clsx(
        'inline-flex select-none items-center justify-center gap-1.5 rounded-md font-medium transition-colors outline-none',
        'focus-visible:ring-2 focus-visible:ring-app-accent/60 disabled:opacity-45 disabled:cursor-not-allowed',
        size === 'sm' ? 'h-7 px-2 text-[11.5px]' : 'h-8 px-3 text-xs',
        variant === 'primary' &&
          'bg-app-accent text-white shadow-sm hover:brightness-110 active:brightness-95',
        variant === 'danger' &&
          'bg-app-danger/10 text-app-danger border border-app-danger/30 hover:bg-app-danger/20',
        variant === 'outline' &&
          'border border-app-border bg-transparent text-app-text hover:bg-app-panel2',
        variant === 'ghost' && 'text-app-muted hover:text-app-text hover:bg-app-panel2',
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}

export function IconButton({
  className,
  children,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      className={clsx(
        'inline-flex h-7 w-7 shrink-0 select-none items-center justify-center rounded-md text-app-muted',
        'transition-colors hover:bg-app-panel2 hover:text-app-text',
        'disabled:opacity-40 disabled:cursor-not-allowed',
        'focus-visible:ring-2 focus-visible:ring-app-accent/60',
        'touch-action: manipulation',
        className,
      )}
      aria-label={rest.title ?? rest['aria-label']}
      {...rest}
    >
      {children}
    </button>
  );
}

export function Modal({
  open,
  onClose,
  title,
  children,
  width = 460,
}: {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: React.ReactNode;
  width?: number;
}) {
  const t = useT();
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div
      className="animate-fade fixed inset-0 z-50 flex items-center justify-center bg-black/55"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="animate-pop flex max-h-[80vh] w-full flex-col overflow-hidden rounded-xl border border-app-border bg-app-panel shadow-2xl"
        style={{ maxWidth: width }}
      >
        {title != null && (
          <div className="flex items-center justify-between border-b border-app-border px-4 py-3">
            <h3 className="text-sm font-semibold">{title}</h3>
            <button
              className="text-app-muted transition-colors hover:text-app-text"
              onClick={onClose}
              aria-label={t('common.close')}
            >
              ✕
            </button>
          </div>
        )}
        <div className="overflow-y-auto px-4 py-4">{children}</div>
      </div>
    </div>
  );
}

export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = '确定',
  danger = false,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  message: React.ReactNode;
  confirmLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const t = useT();
  return (
    <Modal open={open} onClose={onCancel} title={title} width={420}>
      <div className="text-[12.5px] leading-relaxed text-app-muted">{message}</div>
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="ghost" onClick={onCancel}>
          {t('common.cancel')}
        </Button>
        <Button
          variant={danger ? 'danger' : 'primary'}
          onClick={() => {
            onConfirm();
            onCancel();
          }}
        >
          {confirmLabel ?? t('common.confirm')}
        </Button>
      </div>
    </Modal>
  );
}

export interface ContextMenuItem {
  label: string;
  icon?: React.ReactNode;
  danger?: boolean;
  disabled?: boolean;
  /** 分隔线项：渲染一条分隔线而不是按钮 */
  divider?: boolean;
  onClick: () => void;
}

/** 右键菜单：fixed 定位并自动约束在视口内 */
export function ContextMenu({
  x,
  y,
  items,
  onClose,
}: {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    window.addEventListener('blur', onClose);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('blur', onClose);
    };
  }, [onClose]);

  const style: React.CSSProperties = {
    left: Math.min(x, window.innerWidth - 200),
    top: Math.min(y, window.innerHeight - items.length * 32 - 12),
  };

  return (
    <div
      ref={ref}
      className="animate-pop fixed z-[60] min-w-[168px] rounded-lg border border-app-border bg-app-panel py-1 shadow-2xl"
      style={style}
    >
      {items.map((item, i) => (
        item.divider ? (
          <div key={i} className="mx-2 my-1 h-px bg-app-border" />
        ) : (
          <button
            key={i}
            className={clsx(
              'flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors',
              item.danger
                ? 'text-app-danger hover:bg-app-danger/10'
                : 'text-app-text hover:bg-app-panel2',
              item.disabled && 'cursor-not-allowed opacity-40',
            )}
            disabled={item.disabled}
            onClick={() => {
              item.onClick();
              onClose();
            }}
          >
            {item.icon}
            {item.label}
          </button>
        )
      ))}
    </div>
  );
}

export function Toggle({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={clsx(
        'relative h-5 w-9 rounded-full transition-colors',
        checked ? 'bg-app-accent' : 'bg-app-border',
      )}
    >
      <span
        className={clsx(
          'absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all',
          checked ? 'left-[18px]' : 'left-0.5',
        )}
      />
    </button>
  );
}

/** 面板边缘拖拽手柄：按住左右拖动调整相邻面板宽度。 */
export function ResizeHandle({
  width,
  min,
  max,
  dir,
  panel,
  onCommit,
  title,
}: {
  width: number;
  min: number;
  max: number;
  /** 1 = 手柄在面板右侧（向右拖变宽）；-1 = 手柄在面板左侧（向左拖变宽） */
  dir: 1 | -1;
  panel: 'sidebar' | 'inspector';
  /** 松手时一次性提交最终宽度 */
  onCommit: (w: number) => void;
  title?: string;
}) {
  const dragRef = useRef<{ startX: number; startWidth: number; lastX: number } | null>(null);

  useEffect(() => {
    const panelEl = () =>
      document.querySelector(`[data-panel="${panel}"]`) as HTMLElement | null;
    const onMove = (e: MouseEvent) => {
      const d = dragRef.current;
      if (!d) return;
      // 拖动过程直接改 DOM 宽度，避免 React 高频重渲染导致的卡顿
      const next = Math.min(max, Math.max(min, Math.round(d.startWidth + (e.clientX - d.startX) * dir)));
      panelEl()?.style.setProperty('width', `${next}px`);
      d.lastX = e.clientX;
    };
    const onUp = () => {
      const d = dragRef.current;
      if (!d) return;
      const next = Math.min(max, Math.max(min, Math.round(d.startWidth + (d.lastX - d.startX) * dir)));
      dragRef.current = null;
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
      onCommit(next);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [min, max, dir, panel, onCommit]);

  return (
    <div
      data-resize={panel}
      title={title}
      className="z-10 w-1 shrink-0 cursor-col-resize bg-transparent transition-colors hover:bg-app-accent/50 active:bg-app-accent"
      onMouseDown={(e) => {
        e.preventDefault();
        dragRef.current = { startX: e.clientX, startWidth: width, lastX: e.clientX };
        document.body.style.userSelect = 'none';
        document.body.style.cursor = 'col-resize';
      }}
    />
  );
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB'];
  let v = n;
  let i = -1;
  do {
    v /= 1024;
    i++;
  } while (v >= 1024 && i < units.length - 1);
  return `${v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`;
}

export function formatDate(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString('zh-CN', { hour12: false });
  } catch {
    return iso;
  }
}
