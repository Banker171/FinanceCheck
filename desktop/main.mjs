import { app, BrowserWindow, Menu, dialog, ipcMain, safeStorage, shell, session } from 'electron';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { createStore } from '../server/store.mjs';
import { createApp } from '../server/app.mjs';
import { createDesktopSettings } from './settings.mjs';
import updaterPackage from 'electron-updater';
import { createUpdateController, validateTestFeed } from './updates.mjs';

const here = dirname(fileURLToPath(import.meta.url));
if (process.env.FINANCECHECK_DESKTOP_TEST_DIR) app.setPath('userData', process.env.FINANCECHECK_DESKTOP_TEST_DIR);
app.setName('FinanceCheck');
app.setAppUserModelId('com.financecheck.desktop');
let mainWindow, server, store, origin, updates, updateTimer, updateInterval;
const token = randomBytes(32).toString('hex');
const testMode = process.env.FINANCECHECK_DESKTOP_TEST === '1';
// The test switch lets Playwright open two app instances across a persistence test.
if (!testMode && !app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.show(); mainWindow.focus(); } });
  app.whenReady().then(async () => {
    const directory = app.getPath('userData');
    store = createStore(join(directory, 'financecheck.sqlite'), { appVersion: app.getVersion() });
    const settings = createDesktopSettings(directory, safeStorage);
    const api = createApp(store, { staticDir: join(app.getAppPath(), 'dist'), authToken: token, getAiConfig: settings.config });
    server = api.listen(0, '127.0.0.1');
    await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
    origin = `http://127.0.0.1:${server.address().port}`;
    const desktopSession = session.fromPartition('financecheck-private');
    desktopSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
    desktopSession.setPermissionCheckHandler(() => false);
    desktopSession.webRequest.onBeforeSendHeaders((details, callback) => {
      if (mainWindow && details.webContentsId === mainWindow.webContents.id && details.url.startsWith(origin + '/')) details.requestHeaders['X-FinanceCheck-Token'] = token;
      callback({ requestHeaders: details.requestHeaders });
    });
    mainWindow = new BrowserWindow({
      width: 1380, height: 920, minWidth: 800, minHeight: 600, show: false,
      backgroundColor: '#f6f7f3', title: 'FinanceCheck', icon: join(app.getAppPath(), 'build', 'icon.png'),
      webPreferences: { preload: join(here, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, session: desktopSession, devTools: !app.isPackaged || testMode },
    });
    function authorized(event) {
      if (event.sender !== mainWindow?.webContents || event.senderFrame !== mainWindow.webContents.mainFrame || !event.senderFrame.url.startsWith(origin + '/')) throw Error('Недопустимый источник запроса.');
    }
    ipcMain.handle('settings:get', event => { authorized(event); return settings.publicSettings(); });
    ipcMain.handle('settings:save', (event, input) => { authorized(event); return settings.save(input); });
    ipcMain.handle('data:open', async event => { authorized(event); const error = await shell.openPath(directory); if (error) throw Error('Не удалось открыть папку данных.'); });
    ipcMain.handle('app:version', event => { authorized(event); return app.getVersion(); });
    const updateSupported = process.platform === 'win32' && app.isPackaged && !process.env.PORTABLE_EXECUTABLE_DIR;
    const client = updateSupported ? updaterPackage.autoUpdater : null;
    if (client && testMode && process.env.FINANCECHECK_TEST_UPDATE_FEED) client.setFeedURL({ provider: 'generic', url: validateTestFeed(process.env.FINANCECHECK_TEST_UPDATE_FEED), useMultipleRangeRequest: false });
    updates = createUpdateController({
      client, version: app.getVersion(), enabled: updateSupported,
      unavailableReason: process.env.PORTABLE_EXECUTABLE_DIR ? 'Автообновление работает в установленной версии. Один раз установите FinanceCheck через setup.exe поверх прежней версии; данные останутся в вашем профиле.' : 'Автообновление доступно в установленной Windows-версии. В режиме разработки оно отключено.',
      beforeInstall: () => store.backup('before-update'),
    });
    ipcMain.handle('updates:get', event => { authorized(event); return updates.getState(); });
    ipcMain.handle('updates:check', event => { authorized(event); return updates.check(); });
    ipcMain.handle('updates:install', async event => {
      authorized(event);
      if (updates.getState().status !== 'ready') return updates.getState();
      const { response } = await dialog.showMessageBox(mainWindow, { type: 'question', title: 'Установить обновление?', message: 'Программа закроется и откроется после обновления.', detail: 'Сохраните введенные изменения перед продолжением. Перед установкой будет создана резервная копия сохраненных финансовых данных.', buttons: ['Отмена', 'Установить и перезапустить'], defaultId: 0, cancelId: 0, noLink: true });
      return response === 1 ? updates.install() : updates.getState();
    });
    desktopSession.on('will-download', (event, item, webContents) => {
      if (webContents !== mainWindow.webContents || item.getURL() !== origin + '/api/export') { event.preventDefault(); return; }
      item.setSaveDialogOptions({ title: 'Сохранить данные FinanceCheck', defaultPath: join(app.getPath('documents'), 'financecheck-export.json'), filters: [{ name: 'Данные FinanceCheck', extensions: ['json'] }] });
    });
    mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    mainWindow.webContents.on('will-navigate', (event, url) => { if (!url.startsWith(origin + '/')) event.preventDefault(); });
    mainWindow.webContents.on('will-attach-webview', event => event.preventDefault());
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { label: 'Файл', submenu: [{ label: 'Папка данных', click: () => shell.openPath(directory) }, { type: 'separator' }, { label: 'Выход', role: 'quit' }] },
      { label: 'Правка', submenu: [{ label: 'Отменить', role: 'undo' }, { label: 'Повторить', role: 'redo' }, { type: 'separator' }, { label: 'Вырезать', role: 'cut' }, { label: 'Копировать', role: 'copy' }, { label: 'Вставить', role: 'paste' }, { label: 'Выделить все', role: 'selectAll' }] },
      { label: 'Вид', submenu: [{ label: 'Обновить', role: 'reload' }, { label: 'Увеличить', role: 'zoomIn' }, { label: 'Уменьшить', role: 'zoomOut' }, { label: 'Исходный масштаб', role: 'resetZoom' }, { type: 'separator' }, { label: 'На весь экран', role: 'togglefullscreen' }] },
      { label: 'Помощь', submenu: [{ label: 'Проверить обновления', click: async () => { const state = await updates.check(); if (['current', 'unsupported', 'error'].includes(state.status)) await dialog.showMessageBox(mainWindow, { type: state.status === 'error' ? 'warning' : 'info', message: state.status === 'current' ? 'У вас актуальная версия FinanceCheck.' : state.error || state.unavailableReason }); } }, { label: 'О программе', click: () => dialog.showMessageBox(mainWindow, { type: 'info', title: 'FinanceCheck', message: `FinanceCheck ${app.getVersion()}`, detail: 'Личный финансовый план: учет денег, погашение долгов и подушка безопасности.\n\nВсе основные функции доступны без интернета. Внешняя ИИ-модель подключается отдельно и получает сводку только с вашего согласия.' }) }] },
    ]));
    mainWindow.once('ready-to-show', () => mainWindow.show());
    await mainWindow.loadURL(origin);
    if (testMode && app.isPackaged) writeFileSync(join(directory, 'test-ready.json'), JSON.stringify({ pid: process.pid, version: app.getVersion(), executable: process.execPath }));
    if (updateSupported && !testMode) {
      updateTimer = setTimeout(() => { void updates.check(); }, 15000);
      updateInterval = setInterval(() => { void updates.check(); }, 6 * 60 * 60 * 1000);
      updateTimer.unref(); updateInterval.unref();
    }
  }).catch(error => {
    console.error('Desktop startup failed:', error.message);
    dialog.showErrorBox('Не удалось запустить FinanceCheck', 'Не удалось открыть локальное хранилище или окно приложения. Проверьте права доступа к папке данных и свободное место на диске.');
    app.quit();
  });
  app.on('window-all-closed', () => app.quit());
  app.on('will-quit', () => {
    clearTimeout(updateTimer); clearInterval(updateInterval); updates?.dispose();
    if (server) { server.close(); server.closeAllConnections(); }
    store?.db.close();
  });
}
