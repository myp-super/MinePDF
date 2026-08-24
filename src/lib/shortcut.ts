const MODIFIER_CODES: Record<string, string> = {
  AltLeft: 'Alt',
  AltRight: 'Alt',
  ControlLeft: 'Control',
  ControlRight: 'Control',
  ShiftLeft: 'Shift',
  ShiftRight: 'Shift',
  MetaLeft: 'Meta',
  MetaRight: 'Meta',
};

const KEY_LABELS: Record<string, string> = {
  Alt: 'Alt',
  Control: 'Ctrl',
  Shift: 'Shift',
  Meta: 'Win',
  Space: 'Space',
  Enter: 'Enter',
  Escape: 'Esc',
  Backspace: 'Backspace',
  Delete: 'Delete',
  Tab: 'Tab',
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
  PageUp: 'Page Up',
  PageDown: 'Page Down',
  Home: 'Home',
  End: 'End',
  Insert: 'Insert',
  CapsLock: 'Caps Lock',
};

export function normalizeShortcutCode(code: string): string {
  return MODIFIER_CODES[code] ?? code;
}

export function sanitizeShortcutKeys(keys: readonly string[] | undefined): string[] {
  return [...new Set((keys ?? []).map(normalizeShortcutCode).filter(Boolean))].slice(0, 2);
}

export function shortcutKeyLabel(code: string): string {
  if (KEY_LABELS[code]) return KEY_LABELS[code];
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit\d$/.test(code)) return code.slice(5);
  if (/^Numpad\d$/.test(code)) return `Num ${code.slice(6)}`;
  if (/^F\d{1,2}$/.test(code)) return code;
  return code.replace(/([a-z])([A-Z])/g, '$1 $2');
}

export function shortcutLabel(keys: readonly string[] | undefined): string {
  const normalized = sanitizeShortcutKeys(keys);
  return normalized.length ? normalized.map(shortcutKeyLabel).join(' + ') : '—';
}

export function shortcutMatches(pressed: ReadonlySet<string>, keys: readonly string[] | undefined): boolean {
  const normalized = sanitizeShortcutKeys(keys);
  return normalized.length > 0 && pressed.size === normalized.length && normalized.every((key) => pressed.has(key));
}
