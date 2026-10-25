import { _electron as electron } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const directory = mkdtempSync(join(tmpdir(), 'financecheck-electron-'));
const env = { ...process.env, FINANCECHECK_DESKTOP_TEST: '1', FINANCECHECK_DESKTOP_TEST_DIR: directory };
delete env.ELECTRON_RUN_AS_NODE;
let application;
async function launch() {
  const args = ['.'];
  if (process.platform === 'linux') args.push('--no-sandbox', '--ozone-platform=headless', '--disable-gpu');
  const app = await electron.launch({ args, env, timeout: 30000 });
  return app;
}
try {
  application = await launch();
  let page = await application.firstWindow();
  await page.getByRole('heading', { level: 1 }).waitFor();
  assert.ok(await page.getByText('Данные на этом устройстве', { exact: true }).isVisible());
  const settings = await page.evaluate(() => window.financecheckDesktop.getSettings());
  assert.equal(settings.configured, false);
  const origin = new URL(page.url()).origin;
  const outsideResponse = await fetch(origin + '/api/state');
  assert.equal(outsideResponse.status, 401);
  const preferences = await application.evaluate(({ BrowserWindow }) => {
    const p = BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences();
    return { sandbox: p.sandbox, contextIsolation: p.contextIsolation, nodeIntegration: p.nodeIntegration };
  });
  assert.deepEqual(preferences, { sandbox: true, contextIsolation: true, nodeIntegration: false });
  const saved = await page.evaluate(async () => {
    const state = await (await fetch('/api/state')).json();
    const response = await fetch('/api/profile', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...state.profile, name: 'Проверка Windows', essentials: 40000, initialBalance: 25000 }) });
    await fetch('/api/monthly-plans/' + state.analysis.currentMonth, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ income: 90000, payday: 20 }) });
    return { status: response.status, data: await response.json() };
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.data.profile.name, 'Проверка Windows');
  await page.getByRole('button', { name: 'Настройки', exact: true }).click();
  await page.getByRole('heading', { name: 'Подключение ИИ', exact: true }).waitFor();
  await page.reload();
  await page.getByRole('heading', { level: 1 }).waitFor();
  assert.match(await page.getByRole('heading', { level: 1 }).innerText(), /Проверка Windows/);
  await application.close(); application = undefined;
  application = await launch();
  page = await application.firstWindow();
  await page.getByRole('heading', { level: 1 }).waitFor();
  assert.match(await page.getByRole('heading', { level: 1 }).innerText(), /Проверка Windows/);
  assert.equal((await page.evaluate(async () => (await (await fetch('/api/state')).json()).analysis.plannedIncome)), 90000);
  console.log('Electron PASS: window, sandbox, preload IPC, private API, settings screen, local data persistence across restart.');
} finally {
  if (application) await application.close();
  rmSync(directory, { recursive: true, force: true });
}
