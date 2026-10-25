// Keep the update state machine independent of Electron so failures and install
// preconditions can be tested without ever executing an installer.
export function createUpdateController({ client, version, enabled, unavailableReason = '', beforeInstall, onChange = () => {} }) {
  let state = { supported: enabled, currentVersion: version, status: enabled ? 'idle' : 'unsupported', availableVersion: null, percent: 0, lastChecked: null, error: '', unavailableReason };
  let checking = false;
  let installing = false;
  const handlers = [];
  const getState = () => ({ ...state });
  const change = patch => { state = { ...state, ...patch }; onChange(getState()); };
  const listen = (event, handler) => { client.on(event, handler); handlers.push([event, handler]); };
  const fail = () => { installing = false; change({ status: 'error', error: 'Не удалось завершить обновление. Проверьте интернет, доступ к папке программы и повторите попытку. Финансовые данные не изменены.' }); };
  if (enabled) {
    client.autoDownload = true;
    // An ordinary close must never install something the user did not confirm.
    client.autoInstallOnAppQuit = false;
    client.allowPrerelease = false;
    client.allowDowngrade = false;
    client.disableWebInstaller = true;
    // Stable full-file downloads work with GitHub's latest/download redirects.
    // electron-updater still verifies the file's SHA512 and configured publisher signature.
    client.disableDifferentialDownload = true;
    listen('checking-for-update', () => change({ status: 'checking', error: '' }));
    listen('update-available', info => change({ status: 'available', availableVersion: String(info.version).slice(0, 60), error: '', percent: 0, lastChecked: new Date().toISOString() }));
    listen('update-not-available', () => change({ status: 'current', error: '', lastChecked: new Date().toISOString() }));
    listen('download-progress', info => change({ status: 'downloading', percent: Number.isFinite(info.percent) ? Math.max(0, Math.min(100, info.percent)) : 0 }));
    listen('update-downloaded', info => change({ status: 'ready', availableVersion: String(info.version).slice(0, 60), percent: 100, error: '' }));
    listen('error', fail);
  }
  return {
    getState,
    async check() {
      if (!enabled || checking || ['ready', 'installing', 'downloading'].includes(state.status)) return getState();
      checking = true;
      change({ status: 'checking', error: '' });
      try {
        const result = await client.checkForUpdates();
        if (result?.downloadPromise) await result.downloadPromise;
      } catch { fail(); }
      finally { checking = false; }
      return getState();
    },
    async install() {
      if (!enabled || installing || state.status !== 'ready') return getState();
      installing = true;
      try { await beforeInstall(); }
      catch {
        installing = false;
        change({ error: 'Не удалось создать резервную копию. Установка отменена. Проверьте доступ к папке данных и свободное место, затем повторите попытку.' });
        return getState();
      }
      change({ status: 'installing', error: '' });
      try { client.quitAndInstall(true, true); }
      catch { installing = false; change({ status: 'ready', error: 'Не удалось запустить обновление. Программа и данные сохранены. Попробуйте еще раз.' }); }
      return getState();
    },
    dispose() { for (const [event, handler] of handlers) client.removeListener(event, handler); },
  };
}

export function validateTestFeed(url) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1' || !parsed.port || parsed.username || parsed.password || parsed.search || parsed.hash) throw Error('Test update feed must use an explicit loopback port.');
  return parsed.href;
}
