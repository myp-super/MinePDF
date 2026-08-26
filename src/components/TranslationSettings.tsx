import { Check, ChevronDown, ChevronRight, Database, KeyRound, Keyboard, Languages, Settings2, Trash2 } from 'lucide-react';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useT } from '../i18n';
import { normalizeShortcutCode, shortcutLabel } from '../lib/shortcut';
import type { AppSettings, FormulaModelStatus, TranslationCacheStats, TranslationProviderStatus } from '../shared/types';
import { useApp } from '../store';
import { Button, Toggle } from './ui';

const inputClass = 'h-8 min-w-0 rounded-md border border-app-border bg-app-base px-2.5 text-[11.5px] outline-none focus:border-app-accent/70';

export function TranslationSettings({
  settings,
  update,
}: {
  settings: AppSettings;
  update: (patch: Partial<AppSettings>) => Promise<void>;
}) {
  const t = useT();
  const toast = useApp((s) => s.toast);
  const [providers, setProviders] = useState<TranslationProviderStatus[]>([]);
  const [cache, setCache] = useState<TranslationCacheStats>({ entries: 0, bytes: 0 });
  const [formulaModel, setFormulaModel] = useState<FormulaModelStatus | null>(null);
  const [formulaSourcesText, setFormulaSourcesText] = useState((settings.translation.formulaModelSources ?? []).join('\\n'));
  const [providersOpen, setProvidersOpen] = useState(false);
  const [configuring, setConfiguring] = useState<'niutrans' | 'openai-compatible' | null>(null);
  const [niuKey, setNiuKey] = useState('');
  const [openAIKey, setOpenAIKey] = useState('');
  const [openAIConfig, setOpenAIConfig] = useState(settings.translation.openAICompatible);
  const [recordingShortcut, setRecordingShortcut] = useState(false);
  const [capturedShortcut, setCapturedShortcut] = useState<string[]>([]);
  const capturedShortcutRef = useRef<string[]>([]);

  const reload = useCallback(async () => {
    const [providerRows, cacheStats, formulaStatus] = await Promise.all([
      window.pkm.getTranslationProviders(),
      window.pkm.getTranslationCacheStats(),
      window.pkm.getFormulaModelStatus(),
    ]);
    setProviders(providerRows);
    setCache(cacheStats);
    setFormulaModel(formulaStatus);
  }, []);

  useEffect(() => {
    void reload().catch(() => undefined);
  }, [reload]);

  useEffect(() => window.pkm.onFormulaModelProgress(setFormulaModel), []);

  useEffect(() => {
    setFormulaSourcesText((settings.translation.formulaModelSources ?? []).join('\\n'));
  }, [settings.translation.formulaModelSources]);

  useEffect(() => {
    setOpenAIConfig(settings.translation.openAICompatible);
  }, [
    settings.translation.openAICompatible.name,
    settings.translation.openAICompatible.endpoint,
    settings.translation.openAICompatible.model,
  ]);

  const updateTranslation = async (patch: Partial<AppSettings['translation']>): Promise<void> => {
    await update({
      translation: {
        ...settings.translation,
        ...patch,
        openAICompatible: {
          ...settings.translation.openAICompatible,
          ...patch.openAICompatible,
        },
      },
    });
    await reload();
  };

  const saveKey = async (provider: 'niutrans' | 'openai-compatible', apiKey: string): Promise<void> => {
    try {
      if (provider === 'openai-compatible') await updateTranslation({ openAICompatible: openAIConfig });
      if (apiKey.trim()) await window.pkm.saveProviderCredential({ provider, apiKey });
      if (provider === 'niutrans') setNiuKey('');
      else setOpenAIKey('');
      await reload();
      toast('success', t(provider === 'openai-compatible' ? 'translation.configSaved' : 'translation.keySaved'));
    } catch (error) {
      toast('error', error instanceof Error ? error.message : String(error));
    }
  };

  const clearCache = async (): Promise<void> => {
    await window.pkm.clearTranslationCache();
    await reload();
    toast('success', t('translation.cacheCleared'));
  };

  const providerState = (provider: TranslationProviderStatus): string => {
    if (provider.state === 'configured') return t('translation.configured');
    if (provider.state === 'available') return t('translation.available');
    if (provider.state === 'not-configured') return t('translation.notConfigured');
    if (provider.state === 'error') return t('translation.error');
    return t('translation.unavailable');
  };

  const beginShortcutRecording = (): void => {
    capturedShortcutRef.current = [];
    setCapturedShortcut([]);
    setRecordingShortcut(true);
  };

  const commitShortcut = (keys: string[]): void => {
    setRecordingShortcut(false);
    capturedShortcutRef.current = [];
    setCapturedShortcut([]);
    void updateTranslation({ shortcutKeys: keys, shortcutEnabled: true });
  };

  const captureShortcutKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>): void => {
    if (!recordingShortcut || event.repeat) return;
    event.preventDefault();
    event.stopPropagation();
    const code = normalizeShortcutCode(event.code);
    const next = [...new Set([...capturedShortcutRef.current, code])].slice(0, 2);
    capturedShortcutRef.current = next;
    setCapturedShortcut(next);
    if (next.length === 2) commitShortcut(next);
  };

  const captureShortcutKeyUp = (event: React.KeyboardEvent<HTMLButtonElement>): void => {
    if (!recordingShortcut) return;
    event.preventDefault();
    event.stopPropagation();
    const current = capturedShortcutRef.current;
    if (current.length === 1 && current[0] === normalizeShortcutCode(event.code)) commitShortcut(current);
  };

  const currentProvider = providers.find((provider) => provider.id === settings.translation.provider);
  const implementedProviders = providers.filter((provider) => provider.implemented);

  return (
    <section className="mb-4 overflow-hidden rounded-xl border border-app-border bg-app-panel">
      <div className="flex items-center gap-2 border-b border-app-border px-4 py-3 text-xs font-semibold">
        <Languages size={14} className="text-app-accent" /> {t('translation.settingsTitle')}
      </div>

      <div className="px-4">
        <div className="flex items-center justify-between gap-3 border-b border-app-border py-3">
          <div>
            <div className="text-[11.5px] text-app-text/90">{t('translation.enable')}</div>
            <div className="text-[10.5px] text-app-muted">{t('translation.privacy')}</div>
          </div>
          <Toggle checked={settings.translation.enabled} onChange={(enabled) => void updateTranslation({ enabled })} />
        </div>

        <div className="grid grid-cols-2 gap-3 border-b border-app-border py-3">
          <label className="min-w-0 text-[10.5px] text-app-muted">
            {t('translation.defaultProvider')}
            <select className={`${inputClass} mt-1 w-full`} value={settings.translation.provider} onChange={(event) => void updateTranslation({ provider: event.target.value as AppSettings['translation']['provider'] })}>
              {implementedProviders.map((provider) => <option key={provider.id} value={provider.id}>{provider.name}</option>)}
            </select>
          </label>
          <label className="min-w-0 text-[10.5px] text-app-muted">
            {t('translation.targetLanguage')}
            <select className={`${inputClass} mt-1 w-full`} value={settings.translation.targetLanguage} onChange={(event) => void updateTranslation({ targetLanguage: event.target.value })}>
              <option value="zh-CN">简体中文</option><option value="en-US">English</option><option value="ja">日本語</option><option value="ko">한국어</option>
            </select>
          </label>
          <label className="min-w-0 text-[10.5px] text-app-muted">
            {t('translation.context')}
            <select className={`${inputClass} mt-1 w-full`} value={settings.translation.contextMode} onChange={(event) => void updateTranslation({ contextMode: event.target.value as 'none' | 'auto' })}>
              <option value="auto">{t('translation.contextAuto')}</option><option value="none">{t('translation.contextNone')}</option>
            </select>
          </label>
          <div className="flex items-end justify-between gap-2 pb-1">
            <div className="min-w-0">
              <div className="text-[10.5px] text-app-muted">{t('translation.shortcut')}</div>
            </div>
            <button
              className={`flex h-8 min-w-20 shrink-0 items-center justify-center gap-1.5 rounded-md border px-2 text-[10.5px] transition-colors ${recordingShortcut ? 'border-app-accent bg-app-accent/10 text-app-accent' : 'border-app-border bg-app-base text-app-text hover:border-app-accent/60'}`}
              type="button"
              aria-pressed={recordingShortcut}
              title={t('translation.shortcutRecordHint')}
              onPointerDown={(event) => {
                if (event.button !== 0) return;
                event.preventDefault();
                event.currentTarget.focus();
                beginShortcutRecording();
              }}
              onKeyDown={captureShortcutKeyDown}
              onKeyUp={captureShortcutKeyUp}
              onBlur={() => {
                if (recordingShortcut) {
                  capturedShortcutRef.current = [];
                  setCapturedShortcut([]);
                  setRecordingShortcut(false);
                }
              }}
            >
              <Keyboard size={12} />
              {recordingShortcut ? (capturedShortcut.length ? `${shortcutLabel(capturedShortcut)} …` : t('translation.shortcutRecording')) : shortcutLabel(settings.translation.shortcutKeys)}
            </button>
            <Toggle checked={settings.translation.shortcutEnabled} onChange={(shortcutEnabled) => void updateTranslation({ shortcutEnabled })} />
          </div>
        </div>

        <div className="border-b border-app-border py-3">
          <button className="flex w-full items-center gap-2 text-left" onClick={() => setProvidersOpen((value) => !value)} aria-expanded={providersOpen}>
            {providersOpen ? <ChevronDown size={13} className="text-app-muted" /> : <ChevronRight size={13} className="text-app-muted" />}
            <span className="text-[10.5px] font-semibold uppercase text-app-muted">{t('translation.providers')}</span>
            <span className="ml-auto truncate text-[10px] text-app-muted/70">{currentProvider?.name ?? '—'} · {implementedProviders.length}</span>
          </button>

          {providersOpen && <div className="mt-2 overflow-hidden rounded-lg border border-app-border/70 bg-app-base/35">
            <div className="border-b border-app-border/60 px-3 py-2 text-[9.5px] leading-4 text-app-muted/75">{t('translation.fallbackHint')}</div>
            {implementedProviders.map((provider) => {
              const configurable = provider.id === 'niutrans' || provider.id === 'openai-compatible';
              const isConfiguring = configuring === provider.id;
              return <div key={provider.id} className="border-t border-app-border/60 first:border-0">
                <div className="flex min-h-11 items-center justify-between gap-3 px-3 py-1.5">
                  <div className="min-w-0">
                    <div className="flex min-w-0 items-center gap-1.5">
                      <span className="truncate text-[11.5px] text-app-text/90">{provider.name}</span>
                      {provider.freeWithoutKey && <span className="shrink-0 rounded border border-app-accent2/40 px-1 text-[9px] text-app-accent2">{t('translation.freeNoKey')}</span>}
                      {provider.experimental && <span className="shrink-0 rounded border border-amber-500/40 px-1 text-[9px] text-amber-500">{t('translation.experimental')}</span>}
                    </div>
                    {provider.detail && <div className="truncate text-[9.5px] text-app-muted/70" title={provider.detail}>{provider.detail}</div>}
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <span className={`text-[10px] ${provider.state === 'configured' || provider.state === 'available' ? 'text-app-accent2' : provider.state === 'error' ? 'text-app-danger' : 'text-app-muted'}`}>
                      {(provider.state === 'configured' || provider.state === 'available') && <Check className="mr-1 inline" size={11} />}{providerState(provider)}
                    </span>
                    {configurable && <Button size="sm" variant="ghost" onClick={() => setConfiguring(isConfiguring ? null : provider.id as typeof configuring)}><Settings2 size={12} />{t('translation.configure')}</Button>}
                  </div>
                </div>

                {provider.id === 'niutrans' && isConfiguring && <div className="grid grid-cols-[1fr_auto_auto] gap-2 border-t border-app-border/60 bg-app-panel/45 p-3">
                  <input className={inputClass} type="password" autoComplete="new-password" value={niuKey} placeholder="NiuTrans API Key" onChange={(event) => setNiuKey(event.target.value)} />
                  <Button size="sm" variant="outline" disabled={!niuKey.trim()} onClick={() => void saveKey('niutrans', niuKey)}><KeyRound size={12} />{t('translation.saveKey')}</Button>
                  <Button size="sm" variant="ghost" title={t('translation.deleteKey')} onClick={() => void window.pkm.deleteProviderCredential('niutrans').then(reload)}><Trash2 size={12} /></Button>
                </div>}

                {provider.id === 'openai-compatible' && isConfiguring && <div className="space-y-2 border-t border-app-border/60 bg-app-panel/45 p-3">
                  <div className="text-[9.5px] leading-4 text-app-muted/75">
                    {t('formula.visionHint')}
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <input className={inputClass} value={openAIConfig.name} placeholder="Provider name" onChange={(event) => setOpenAIConfig((value) => ({ ...value, name: event.target.value }))} />
                    <input className={inputClass} value={openAIConfig.model} placeholder="Model" onChange={(event) => setOpenAIConfig((value) => ({ ...value, model: event.target.value }))} />
                  </div>
                  <input className={`${inputClass} w-full`} value={openAIConfig.endpoint} placeholder="https://example.com/v1" onChange={(event) => setOpenAIConfig((value) => ({ ...value, endpoint: event.target.value }))} />
                  <div className="grid grid-cols-[1fr_auto_auto] gap-2">
                    <input className={inputClass} type="password" autoComplete="new-password" value={openAIKey} placeholder="API Key（已保存时可留空）" onChange={(event) => setOpenAIKey(event.target.value)} />
                    <Button size="sm" variant="outline" disabled={!openAIConfig.endpoint.trim() || !openAIConfig.model.trim()} onClick={() => void saveKey('openai-compatible', openAIKey)}><KeyRound size={12} />{t('translation.saveConfig')}</Button>
                    <Button size="sm" variant="ghost" title={t('translation.deleteKey')} onClick={() => void window.pkm.deleteProviderCredential('openai-compatible').then(reload)}><Trash2 size={12} /></Button>
                  </div>
                </div>}
              </div>;
            })}
          </div>}
        </div>

        <div className="flex items-center gap-3 py-3">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-app-panel2 text-app-muted"><Database size={14} /></div>
          <div className="min-w-0 flex-1">
            <div className="text-[11.5px] text-app-text/90">{t('translation.cache')}</div>
            <div className="text-[10px] leading-4 text-app-muted/75">{t('translation.cacheHint')} · {cache.entries} {t('translation.cacheEntries')} · {(cache.bytes / 1024).toFixed(1)} KB</div>
          </div>
          <Toggle checked={settings.translation.cacheEnabled} onChange={(cacheEnabled) => void updateTranslation({ cacheEnabled })} />
          <Button size="sm" variant="ghost" disabled={!cache.entries} onClick={() => void clearCache()}>{t('translation.clearCache')}</Button>
        </div>

        <div className="flex items-start gap-3 border-t border-app-border/60 py-3">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-app-panel2 text-app-muted"><Settings2 size={14} /></div>
        <div className="min-w-0 flex-1">
          <div className="text-[11.5px] text-app-text/90">{t('formula.localModelTitle')}</div>
          <div className="mt-0.5 text-[10px] leading-4 text-app-muted/75">{formulaModel?.state === 'ready' ? t('formula.localModelReady') : `${formulaModel?.state === 'downloading' ? t('formula.localModelDownloading') : t('formula.localModelDownload')} · ${Math.round((formulaModel?.progress ?? 0) * 100)}%`}</div>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <select className={inputClass} value={settings.translation.formulaEngine} onChange={(event) => void updateTranslation({ formulaEngine: event.target.value as AppSettings['translation']['formulaEngine'] })}>
              <option value="local">{t('formula.localModelTitle')}</option>
              <option value="online">{t('formula.localModelUseOnline')}</option>
            </select>
            <textarea className="h-8 min-w-[240px] resize-x rounded-md border border-app-border bg-app-base px-2.5 py-1.5 text-[10px] outline-none focus:border-app-accent/70" value={formulaSourcesText} placeholder={t('formula.localModelSourcesHint')} onChange={(event) => setFormulaSourcesText(event.target.value)} onBlur={() => void updateTranslation({ formulaModelSources: formulaSourcesText.split(/\\r?\\n|,/).map((value) => value.trim()).filter(Boolean) })} />
            {formulaModel?.state !== 'ready' && <Button size="sm" variant="outline" disabled={formulaModel?.state === 'downloading'} onClick={() => void window.pkm.downloadFormulaModel().then(setFormulaModel).catch((error) => toast('error', error instanceof Error ? error.message : String(error)))}>{t('formula.localModelDownload')}</Button>}
            {formulaModel?.state === 'ready' && <Button size="sm" variant="ghost" onClick={() => void window.pkm.deleteFormulaModel().then(() => reload())}><Trash2 size={12} />{t('formula.localModelDelete')}</Button>}
          </div>
        </div>
        </div>
      </div>
    </section>
  );
}
