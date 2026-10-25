import { useState, type FormEvent, type ChangeEvent } from 'react';
import { Download, Upload } from 'lucide-react';
import type { ReactNode } from 'react';
type Props = {
  busy: boolean;
  mutate: (path: string, method: string, body?: unknown) => Promise<boolean>;
  Modal: (props: { title: string; close: () => void; children: ReactNode }) => ReactNode;
};
export default function BackupControls({ busy, mutate, Modal }: Props) {
  const [payload, setPayload] = useState<unknown>(null), [filename, setFilename] = useState(''), [error, setError] = useState('');
  async function choose(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]; event.target.value = ''; if (!file) return;
    setError('');
    if (file.size > 5 * 1024 * 1024) { setError('Максимальный размер копии — 5 МБ.'); return; }
    try {
      const parsed = JSON.parse(await file.text());
      if (!parsed || parsed.version !== 1 || !parsed.profile || !Array.isArray(parsed.transactions) || !Array.isArray(parsed.debts)) throw Error();
      setFilename(file.name); setPayload(parsed);
    } catch { setError('Не удалось прочитать копию. Выберите JSON-экспорт FinanceCheck.'); }
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const confirm = new FormData(event.currentTarget).get('confirm');
    if (await mutate('/import', 'POST', { payload, confirm })) setPayload(null);
  }
  return <section className="card"><span className="soft-icon"><Download size={23} /></span><h2>Резервные копии и обновления</h2><p className="muted small">Данные хранятся отдельно от программы. Перед обновлением формата базы или восстановлением автоматически создается JSON-копия в папке данных → backups. Если копию создать не удалось, обновление базы не выполняется.</p><p className="muted small">Дополнительно сохраните экспорт в надежном месте. Обновление устанавливайте поверх прежней версии в той же учетной записи Windows. Переустановка Windows, другая учетная запись и удаление папки данных требуют отдельного переноса.</p><a className="button secondary full" href="/api/export"><Download size={17} />Скачать данные</a><label className="button secondary full import-button"><Upload size={17} />Восстановить из файла<input aria-label="Файл резервной копии" type="file" accept=".json,application/json" disabled={busy} onChange={event => void choose(event)} /></label>{error && <p className="negative small" role="alert">{error}</p>}<p className="small muted">Копия содержит профиль, историю, долги и месячные планы. Ключ ИИ хранится отдельно и в экспорт не входит. Автокопии на том же диске не защищают от поломки диска.</p>{payload !== null && <Modal title="Восстановить резервную копию?" close={() => { if (!busy) setPayload(null); }}><p className="small muted">Файл: {filename}. Текущие финансовые данные будут заменены содержимым файла. Перед заменой будет сохранена копия текущих данных. Ключ ИИ останется прежним.</p><form className="form" onSubmit={submit}><label className="field"><span>Для подтверждения введите ВОССТАНОВИТЬ</span><input name="confirm" required pattern="ВОССТАНОВИТЬ" autoComplete="off" /></label><button type="submit" className="button primary" disabled={busy}>Восстановить данные</button><button type="button" className="button secondary" disabled={busy} onClick={() => setPayload(null)}>Отмена</button></form></Modal>}</section>;
}
