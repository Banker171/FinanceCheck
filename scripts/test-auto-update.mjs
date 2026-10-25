// End-to-end update on a disposable Windows runner: two actual NSIS versions,
// real SHA512 rejection, normal quit without installation, confirmed update and restart.
import { _electron as electron } from '@playwright/test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createReadStream, mkdtempSync, readFileSync, existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

if (process.platform !== 'win32' || process.env.GITHUB_ACTIONS !== 'true') throw Error('Use the disposable Windows CI runner for automatic-installation tests.');
const directory = mkdtempSync(join(tmpdir(), 'financecheck-auto-update-'));
const installDirectory = join(directory, 'installed');
// NSIS restarts via the Windows shell, so process-local environment overrides
// are not inherited. Use the actual Windows profile on this disposable runner.
const dataDirectory = join(process.env.APPDATA, 'FinanceCheck');
const hadDataDirectory = existsSync(dataDirectory);
const fixtureDirectory = join(directory, 'fixture-build');
const version = JSON.parse(readFileSync('package.json', 'utf8')).version;
const parts = version.split('.').map(Number); parts[2]++;
const targetVersion = parts.join('.');
const filename = `FinanceCheck-${targetVersion}-x64-setup.exe`;
let application, server, restartedPid;
let phase = 'build fixture';
const execFileAsync = promisify(execFile);
function run(executable, args, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { stdio: 'inherit', env });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(Error(`${executable} exited ${code}`)));
  });
}
async function waitFor(check, label, timeout = 90000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await check(); if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw Error('Timed out waiting for ' + label);
}
async function close() { if (application) { await application.close(); application = undefined; } }
try {
  await run(process.execPath, [resolve('node_modules/electron-builder/cli.js'), '--win', 'nsis', '--x64', '--publish', 'never', `--config.extraMetadata.version=${targetVersion}`, `--config.directories.output=${fixtureDirectory}`], { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' });
  const fixturePath = join(fixtureDirectory, filename);
  const digest = createHash('sha512'); for await (const chunk of createReadStream(fixturePath)) digest.update(chunk);
  const sha512 = digest.digest('base64');
  let corrupt = true;
  server = createServer((req, res) => {
    const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
    if (pathname === '/updates/latest.yml') {
      const checksum = corrupt ? Buffer.alloc(64).toString('base64') : sha512;
      res.setHeader('Content-Type', 'application/yaml');
      res.end(JSON.stringify({ version: targetVersion, files: [{ url: filename, sha512: checksum, size: statSync(fixturePath).size }], path: filename, sha512: checksum }));
    } else if (pathname === '/updates/' + filename) {
      res.setHeader('Content-Type', 'application/octet-stream'); res.setHeader('Content-Length', statSync(fixturePath).size);
      createReadStream(fixturePath).pipe(res);
    } else { res.statusCode = 404; res.end(); }
  }).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const env = { ...process.env, FINANCECHECK_DESKTOP_TEST: '1', FINANCECHECK_TEST_UPDATE_FEED: `http://127.0.0.1:${server.address().port}/updates/` };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.FINANCECHECK_DESKTOP_TEST_DIR;
  phase = 'install bootstrap';
  await run(resolve(`release/FinanceCheck-${version}-x64-setup.exe`), ['/S', '/D=' + installDirectory]);
  async function launch() {
    application = await electron.launch({ executablePath: join(installDirectory, 'FinanceCheck.exe'), args: [], env, timeout: 45000 });
    const page = await application.firstWindow(); await page.getByRole('heading', { level: 1 }).waitFor(); return page;
  }
  let page = await launch();
  const actualDataPath = await application.evaluate(({ app }) => app.getPath('userData'));
  assert.equal(actualDataPath.toLowerCase(), dataDirectory.toLowerCase());
  assert.equal((await page.evaluate(() => window.financecheckDesktop.getUpdateState())).supported, true);
  const initial = await page.evaluate(async () => (await fetch('/api/state')).json());
  assert.equal(initial.profile.name, '', 'Do not overwrite a pre-existing profile');
  assert.equal(initial.transactions.length, 0);
  assert.equal(initial.debts.length, 0);
  assert.equal(initial.profile.initialBalance, 0);
  assert.equal(initial.profile.reserveBalance, 0);
  assert.equal(Object.keys(initial.monthlyPlans).length, 0);
  phase = 'seed isolated CI profile';
  const before = await page.evaluate(async () => {
    const state = await (await fetch('/api/state')).json();
    const post = (path, method, body) => fetch('/api' + path, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(response => { if (!response.ok) throw Error(path); return response.json(); });
    await post('/profile', 'PUT', { ...state.profile, name: 'Автообновление: данные сохранить', initialBalance: 50000, essentials: 25000, reserveBalance: 10000 });
    await post('/monthly-plans/' + state.analysis.currentMonth, 'PUT', { income: 85000, payday: 25 });
    let result = await post('/debts', 'POST', { name: 'Кредит до обновления', balance: 100000, apr: 20, payment: 5000, dueDay: 15 });
    result = await post('/transactions', 'POST', { type: 'expense', amount: 5000, principal: 3000, debtId: result.debts[0].id, date: state.analysis.today, category: 'Долг', note: 'Не потерять платеж' });
    await window.financecheckDesktop.saveSettings({ key: 'automatic-update-test-key-not-real', model: 'gpt-4.1-mini' });
    return result;
  });
  const encryptedKey = readFileSync(join(dataDirectory, 'ai-key.bin'));
  phase = 'reject corrupt SHA512';
  await page.getByRole('button', { name: 'Настройки', exact: true }).click();
  await page.getByRole('button', { name: 'Проверить обновления', exact: true }).click();
  await waitFor(async () => (await page.evaluate(() => window.financecheckDesktop.getUpdateState())).status === 'error', 'corrupt installer rejection');
  assert.equal(await page.evaluate(() => window.financecheckDesktop.getVersion()), version);
  assert.equal((await page.evaluate(() => window.financecheckDesktop.getUpdateState())).status, 'error', 'Corrupt installer must never be ready');
  console.log('Automatic update: corrupt SHA512 was rejected.');
  corrupt = false;
  phase = 'download verified update';
  await page.evaluate(() => window.financecheckDesktop.checkForUpdates());
  await waitFor(async () => (await page.evaluate(() => window.financecheckDesktop.getUpdateState())).status === 'ready', 'verified download');
  await close();
  page = await launch();
  phase = 'verify ordinary quit and canceled confirmation';
  assert.equal(await page.evaluate(() => window.financecheckDesktop.getVersion()), version, 'Closing without confirmation must not install');
  await page.evaluate(() => window.financecheckDesktop.checkForUpdates());
  assert.equal((await page.evaluate(() => window.financecheckDesktop.getUpdateState())).status, 'ready');
  await application.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 0 }); });
  await page.evaluate(() => window.financecheckDesktop.installUpdate());
  assert.equal(await page.evaluate(() => window.financecheckDesktop.getVersion()), version, 'Cancel must leave current app running');
  await application.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1 }); });
  phase = 'install and observe Windows-shell restart';
  const closed = application.waitForEvent('close', { timeout: 45000 });
  void page.evaluate(() => window.financecheckDesktop.installUpdate()).catch(() => {});
  await closed; application = undefined;
  const observed = await waitFor(async () => {
    let db;
    try {
      db = new DatabaseSync(join(dataDirectory, 'financecheck.sqlite'), { readOnly: true });
      if (JSON.parse(db.prepare('SELECT body FROM state WHERE id=1').get().body).appVersion !== targetVersion) return null;
    } catch { return null; } finally { db?.close(); }
    const script = "Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $env:FINANCECHECK_AUTO_TEST_EXE -and $_.CommandLine -notmatch '--type=' } | ForEach-Object { $p = Get-Process -Id $_.ProcessId; if ($p.MainWindowHandle -ne 0) { $p.Id } } | ConvertTo-Json -Compress";
    const { stdout } = await execFileAsync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { env: { ...process.env, FINANCECHECK_AUTO_TEST_EXE: join(installDirectory, 'FinanceCheck.exe') } });
    if (!stdout.trim()) return null;
    const pids = JSON.parse(stdout); return Array.isArray(pids) ? pids[0] : pids;
  }, 'new version with an actual visible Windows window');
  assert.ok(Number.isInteger(observed) && observed > 0 && observed !== process.pid);
  restartedPid = observed;
  await execFileAsync('powershell', ['-NoProfile', '-NonInteractive', '-Command', '$p = Get-Process -Id $env:FINANCECHECK_AUTO_TEST_PID; $null = $p.CloseMainWindow(); if (-not $p.WaitForExit(10000)) { throw "Test window did not close" }'], { env: { ...process.env, FINANCECHECK_AUTO_TEST_PID: String(restartedPid) } });
  restartedPid = undefined;
  phase = 'verify preserved data and credentials';
  page = await launch();
  assert.equal(await page.evaluate(() => window.financecheckDesktop.getVersion()), targetVersion);
  const after = await page.evaluate(async () => (await fetch('/api/state')).json());
  for (const field of ['profile', 'debts', 'transactions', 'monthlyPlans']) assert.deepEqual(after[field], before[field]);
  assert.equal(after.analysis.totalBalance, before.analysis.totalBalance);
  assert.equal((await page.evaluate(() => window.financecheckDesktop.getSettings())).configured, true);
  assert.deepEqual(readFileSync(join(dataDirectory, 'ai-key.bin')), encryptedKey);
  const backups = readdirSync(join(dataDirectory, 'backups'));
  assert.ok(backups.some(name => name.includes('before-update')));
  assert.ok(backups.some(name => name.includes('before-upgrade')));
  console.log(`Windows automatic update PASS: ${version} -> ${targetVersion}, real downloaded installer, canceled confirmation respected, restart observed, all financial data and DPAPI key preserved.`);
} catch (error) {
  const details = `${phase}: ${error.stack || error}`.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
  console.error('::error title=Automatic update validation::' + details);
  throw error;
} finally {
  await close();
  if (restartedPid) await run('taskkill', ['/PID', String(restartedPid), '/T', '/F']).catch(() => {});
  if (existsSync(installDirectory)) {
    const uninstaller = readdirSync(installDirectory).find(name => /^Uninstall.*\.exe$/i.test(name));
    if (uninstaller) await run(join(installDirectory, uninstaller), ['/S', '_?=' + installDirectory]);
  }
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  if (!hadDataDirectory) rmSync(dataDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
}
