import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { CheckCheck, Download, LoaderCircle, RefreshCw } from 'lucide-react';
import type { UpdateState } from './types';

type Context = { state: UpdateState | null; pending: boolean; check: () => Promise<void>; install: () => Promise<void> };
const UpdatesContext = createContext<Context>({ state: null, pending: false, check: async () => {}, install: async () => {} });
export function UpdatesProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<UpdateState | null>(null), [pending, setPending] = useState(false);
  const bridge = window.financecheckDesktop;
  useEffect(() => {
    if (!bridge) return;
    let alive = true;
    const refresh = () => bridge.getUpdateState().then(s => { if (alive) setState(s); }).catch(() => {});
    void refresh();
    const timer = setInterval(() => { void refresh(); }, 1500);
    return () => { alive = false; clearInterval(timer); };
  }, [bridge]);
  const check = useCallback(async () => {
    if (!bridge) return;
    setPending(true);
    try { setState(await bridge.checkForUpdates()); }
    finally { setPending(false); }
  }, [bridge]);
  const install = useCallback(async () => {
    if (!bridge) return;
    setPending(true);
    try { setState(await bridge.installUpdate()); }
    finally { setPending(false); }
  }, [bridge]);
  const value = useMemo(() => ({ state, pending, check, install }), [state, pending, check, install]);
  return <UpdatesContext.Provider value={value}>{children}</UpdatesContext.Provider>;
}
function description(state: UpdateState) {
  switch (state.status) {
    case 'checking': return 'Проверяем наличие новой версии…';
    case 'available': return `Найдена версия ${state.availableVersion}. Начинаем загрузку…`;
    case 'downloading': return `Загружаем версию ${state.availableVersion}: ${Math.floor(state.percent)}%`;
    case 'ready': return `Версия ${state.availableVersion} загружена и готова к установке.`;
    case 'installing': return 'Создана резервная копия. Программа перезапускается для установки…';
    case 'current': return 'У вас актуальная версия программы.';
    case 'unsupported': return state.unavailableReason;
    case 'error': return state.error;
    default: return 'Новые версии проверяются при запуске и загружаются автоматически.';
  }
}
function InstallButton({ disabled }: { disabled?: boolean }) {
  const { install, pending } = useContext(UpdatesContext);
  return <button className="button primary" disabled={disabled || pending} onClick={() => void install().catch(() => {})}><RefreshCw size={16} />Установить и перезапустить</button>;
}
export function UpdateNotice({ busy }: { busy: boolean }) {
  const { state } = useContext(UpdatesContext);
  if (!state || !['available', 'downloading', 'ready', 'installing'].includes(state.status)) return null;
  return <div className="update-notice" role="status"><div className="soft-icon">{state.status === 'ready' ? <CheckCheck size={21} /> : <Download size={21} />}</div><div className="update-notice-text"><strong>Обновление FinanceCheck</strong><p>{description(state)}</p>{state.error && <p className="negative">{state.error}</p>}</div>{state.status === 'ready' && <InstallButton disabled={busy} />}</div>;
}
export function UpdatesCard({ busy }: { busy: boolean }) {
  const { state, pending, check } = useContext(UpdatesContext);
  if (!state) return null;
  const downloading = ['checking', 'available', 'downloading', 'installing'].includes(state.status);
  return <section className="card updates-card"><div className="section-heading"><h2>Обновления программы</h2><span className="pill">{state.currentVersion}</span></div><p className="small" role="status">{description(state)}</p>{state.status === 'downloading' && <div className="progress-track" role="progressbar" aria-label="Загрузка обновления" aria-valuenow={Math.floor(state.percent)} aria-valuemin={0} aria-valuemax={100}><span style={{ width: `${state.percent}%` }} /></div>}{state.error && state.status !== 'error' && <p className="negative small">{state.error}</p>}{state.supported && <><p className="muted small">Новые файлы вручную скачивать не нужно. Установка выполняется после вашего подтверждения. Сначала сохраните изменения; перед перезапуском программа создаст резервную копию данных.</p>{state.status === 'ready' ? <InstallButton disabled={busy} /> : <button className="button secondary full" disabled={pending || downloading} onClick={() => void check().catch(() => {})}>{pending || downloading ? <LoaderCircle size={17} className="spin" /> : <RefreshCw size={17} />}Проверить обновления</button>}</>}{state.lastChecked && <p className="muted small update-last-check">Проверено: {new Date(state.lastChecked).toLocaleString('ru-RU')}</p>}</section>;
}
