import { CheckCircle2, Download, Loader2, X } from 'lucide-react';
import React, { useEffect, useState } from 'react';
import { useT } from '../i18n';
import type { UpdateResult } from '../shared/types';
import { useApp } from '../store';
import { Button, Modal } from './ui';

export function UpdateModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useT();
  const toast = useApp((s) => s.toast);
  const [res, setRes] = useState<UpdateResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [downloading, setDownloading] = useState(false);

  const check = async () => {
    setBusy(true);
    try {
      setRes(await window.pkm.checkForUpdates());
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (open) {
      setRes(null);
      void check();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const download = async () => {
    if (!res?.latest) return;
    setDownloading(true);
    try {
      await window.pkm.openExternalUrl(res.latest.url);
      toast('success', t('update.downloading'));
    } catch (err) {
      toast('error', err instanceof Error ? err.message : String(err));
    } finally {
      setDownloading(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title={t('update.available')} width={460}>
      {busy || !res ? (
        <div className="flex items-center justify-center gap-2 py-8 text-app-muted">
          <Loader2 size={15} className="animate-spin" />
          {t('update.checking')}
        </div>
      ) : res.status === 'disabled' ? (
        <div className="py-2 text-[12.5px] leading-relaxed text-app-muted">{t('update.disabled')}</div>
      ) : res.status === 'error' ? (
        <div className="rounded-lg border border-app-danger/40 bg-app-danger/10 p-3 text-[12.5px] text-app-danger">
          {t('update.error', { msg: res.error ?? '' })}
        </div>
      ) : res.status === 'up-to-date' ? (
        <div className="flex items-center gap-2.5 py-2 text-[12.5px] text-app-text/90">
          <CheckCircle2 size={18} className="shrink-0 text-emerald-400" />
          {t('update.upToDate')}
          <span className="ml-auto rounded border border-app-border px-1.5 py-0.5 text-[10.5px] text-app-muted">
            {t('update.current')} {res.currentVersion}
          </span>
        </div>
      ) : (
        <div>
          <div className="mb-3 flex items-center gap-3">
            <div className="flex-1 rounded-lg border border-app-border bg-app-panel2 px-3 py-2">
              <div className="text-[10.5px] text-app-muted">{t('update.current')}</div>
              <div className="mt-0.5 text-sm font-semibold tabular-nums">{res.currentVersion}</div>
            </div>
            <span className="text-app-muted">→</span>
            <div className="flex-1 rounded-lg border border-app-accent/50 bg-app-accent/10 px-3 py-2">
              <div className="text-[10.5px] text-app-accent">{t('update.latest')}</div>
              <div className="mt-0.5 text-sm font-semibold tabular-nums text-app-accent">
                {res.latest?.version}
              </div>
            </div>
          </div>

          {res.latest && res.latest.notes.length > 0 && (
            <div className="mb-3">
              <div className="mb-1 text-[10.5px] font-medium uppercase tracking-wide text-app-muted">
                {t('update.notes')}
              </div>
              <ul className="space-y-1 rounded-lg bg-app-panel2 px-3 py-2">
                {res.latest.notes.map((n, i) => (
                  <li key={i} className="flex gap-1.5 text-[12px] leading-relaxed text-app-text/90">
                    <span className="text-app-accent">•</span>
                    <span className="min-w-0">{n}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="mt-4 flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>
              {t('update.later')}
            </Button>
            <Button variant="primary" disabled={downloading} onClick={() => void download()}>
              <Download size={13} />
              {t('update.download')}
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}
