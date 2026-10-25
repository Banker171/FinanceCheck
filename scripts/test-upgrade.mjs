// A real silent NSIS installation + update on the disposable Windows CI runner.
// It uses an isolated data directory; never run this against a user's installation.
import { _electron as electron } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';

if (process.platform !== 'win32') throw Error('The installation-upgrade test must run on the disposable Windows CI runner.');
const directory = mkdtempSync(join(tmpdir(), 'financecheck-upgrade-'));
const installDirectory = join(directory, 'installed');
const dataDirectory = join(directory, 'user-data');
const env = { ...process.env, FINANCECHECK_DESKTOP_TEST: '1', FINANCECHECK_DESKTOP_TEST_DIR: dataDirectory };
delete env.ELECTRON_RUN_AS_NODE;
let application;
async function install(executable) {
  await new Promise((resolve, reject) => {
    const child = spawn(executable, ['/S', '/D=' + installDirectory], { stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(Error('Installer exit: ' + code)));
  });
}
async function launch() {
  application = await electron.launch({ executablePath: join(installDirectory, 'FinanceCheck.exe'), args: [], env, timeout: 45000 });
  const page = await application.firstWindow();
  await page.getByRole('heading', { level: 1 }).waitFor();
  return page;
}
async function close() { await application.close(); application = undefined; }
try {
  const oldInstaller = join(directory, 'previous-setup.exe');
  const response = await fetch('https://github.com/Banker171/FinanceCheck/releases/download/v0.2.0/FinanceCheck-0.2.0-x64-setup.exe');
  assert.ok(response.ok, 'Previous installer must be accessible');
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.equal(createHash('sha256').update(bytes).digest('hex'), 'e8e3fb155fb2f140de8cb049deb238e46ecd3af49b0c7d28ac189f64370e9e7a');
  writeFileSync(oldInstaller, bytes);
  await install(oldInstaller);
  let page = await launch();
  const oldState = await page.evaluate(async () => {
    const call = async (path, body, method = 'POST') => {
      const response = await fetch('/api' + path, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (!response.ok) throw Error('Test fixture request failed: ' + path);
      return response.json();
    };
    const initial = await (await fetch('/api/state')).json();
    await call('/profile', { ...initial.profile, name: 'Проверка обновления', monthlyIncome: 88000, essentials: 32000, initialBalance: 45000, reserveBalance: 12000, payday: 26 }, 'PUT');
    let state = await call('/debts', { name: 'Существующий кредит', balance: 90000, apr: 20, payment: 5000, dueDay: 15 });
    state = await call('/transactions', { type: 'expense', amount: 5000, principal: 3500, debtId: state.debts[0].id, date: initial.analysis.today, category: 'Платеж по долгу', note: 'Платеж до обновления' });
    await window.financecheckDesktop.saveSettings({ key: 'upgrade-test-not-a-real-api-key', model: 'gpt-4.1-mini' });
    return state;
  });
  const encryptedKey = readFileSync(join(dataDirectory, 'ai-key.bin'));
  await close();
  const version = JSON.parse(readFileSync('package.json', 'utf8')).version;
  await install(resolve(`release/FinanceCheck-${version}-x64-setup.exe`));
  page = await launch();
  const current = await page.evaluate(async () => (await fetch('/api/state')).json());
  assert.equal(current.profile.name, oldState.profile.name);
  for (const key of ['essentials', 'initialBalance', 'reserveBalance', 'reserveMonths', 'strategy', 'method']) assert.deepEqual(current.profile[key], oldState.profile[key]);
  assert.deepEqual(current.debts, oldState.debts);
  assert.deepEqual(current.transactions, oldState.transactions);
  assert.equal(current.analysis.totalBalance, oldState.analysis.totalBalance);
  assert.equal(current.analysis.spendable, oldState.analysis.spendable);
  assert.equal(current.monthlyPlans[current.analysis.currentMonth].income, 88000);
  assert.equal(current.monthlyPlans[current.analysis.currentMonth].payday, 26);
  assert.equal(Object.keys(current.monthlyPlans).length, 1);
  assert.equal((await page.evaluate(() => window.financecheckDesktop.getSettings())).configured, true);
  assert.deepEqual(readFileSync(join(dataDirectory, 'ai-key.bin')), encryptedKey);
  const copies = readdirSync(join(dataDirectory, 'backups'));
  assert.equal(copies.length, 1);
  const backup = JSON.parse(readFileSync(join(dataDirectory, 'backups', copies[0]), 'utf8'));
  assert.deepEqual(backup.profile, oldState.profile);
  assert.deepEqual(backup.debts, oldState.debts);
  assert.deepEqual(backup.transactions, oldState.transactions);
  await close();
  page = await launch();
  assert.equal(readdirSync(join(dataDirectory, 'backups')).length, 1, 'Restart must not rerun migration');
  assert.match(await page.getByRole('heading', { level: 1 }).innerText(), /Проверка обновления/);
  await close();
  console.log('Windows upgrade PASS: actual 0.2.0 installation updated in place; profile, balances, debts, payments and DPAPI key preserved; original snapshot recoverable; migration runs once.');
} finally {
  if (application) await close();
  rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
}
