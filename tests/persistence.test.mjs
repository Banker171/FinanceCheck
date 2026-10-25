import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore, validateImport } from '../server/store.mjs';

function fixture(t, state) {
  const dir = mkdtempSync(join(tmpdir(), 'financecheck-migration-'));
  const path = join(dir, 'financecheck.sqlite');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode=WAL; CREATE TABLE state (id INTEGER PRIMARY KEY, body TEXT NOT NULL)');
  db.prepare('INSERT INTO state VALUES (1,?)').run(JSON.stringify(state)); db.close();
  return { dir, path };
}
const legacy = () => ({
  profile: { name: 'Существующий профиль', monthlyIncome: 80000, essentials: 30000, initialBalance: 50000, payday: 25, reserveBalance: 10000, reserveMonths: 3, strategy: 'balanced', method: 'avalanche' },
  debts: [{ id: 'd', name: 'Кредит', balance: 100, apr: 12, payment: 100, dueDay: 20 }],
  transactions: [{ id: 't', type: 'expense', amount: 900, principal: 800, debtId: 'd', date: '2026-01-01', category: 'Долг', note: 'Исторический платеж' }],
});
test('0.2 database migrates once, keeps every balance and transaction, and backs up the original', t => {
  const old = legacy(), { dir, path } = fixture(t, old);
  let store = createStore(path, { appVersion: '0.3.0', now: new Date('2026-10-25T00:00:00Z') });
  const state = store.read();
  assert.equal(state.schemaVersion, 2);
  assert.deepEqual(state.debts, old.debts);
  assert.deepEqual(state.transactions, old.transactions);
  assert.equal(state.profile.initialBalance, old.profile.initialBalance);
  assert.equal(state.profile.reserveBalance, old.profile.reserveBalance);
  assert.deepEqual(state.monthlyPlans, { '2026-10': { income: 80000, payday: 25 } });
  assert.equal('monthlyIncome' in state.profile, false);
  const backups = readdirSync(join(dir, 'backups'));
  assert.equal(backups.length, 1);
  const backup = JSON.parse(readFileSync(join(dir, 'backups', backups[0]), 'utf8'));
  assert.deepEqual(backup.profile, old.profile);
  assert.deepEqual(backup.transactions, old.transactions);
  store.db.close();
  store = createStore(path, { appVersion: '0.3.0', now: new Date('2026-11-01T00:00:00Z') });
  assert.equal(readdirSync(join(dir, 'backups')).length, 1);
  assert.equal(store.read().monthlyPlans['2026-11'], undefined);
  assert.equal(store.read().profile.name, old.profile.name);
  store.db.close();
});
test('a later application update preserves the schema and creates another recoverable snapshot', t => {
  const { dir, path } = fixture(t, legacy());
  let store = createStore(path, { appVersion: '0.3.0' }); store.db.close();
  store = createStore(path, { appVersion: '0.3.1' });
  assert.equal(readdirSync(join(dir, 'backups')).length, 2);
  assert.equal(store.read().profile.initialBalance, 50000);
  store.db.close();
});
test('backup failure stops migration without changing financial state', t => {
  const old = legacy(), { dir, path } = fixture(t, old);
  writeFileSync(join(dir, 'backups'), 'A file blocks the backup directory.');
  assert.throws(() => createStore(path, { appVersion: '0.3.0' }));
  const db = new DatabaseSync(path);
  assert.deepEqual(JSON.parse(db.prepare('SELECT body FROM state').get().body), old);
  db.close();
});
test('newer schemas are never downgraded or overwritten', t => {
  const state = { ...legacy(), schemaVersion: 99 }, { path } = fixture(t, state);
  assert.throws(() => createStore(path), /неподдерживаемой/);
  const db = new DatabaseSync(path);
  assert.deepEqual(JSON.parse(db.prepare('SELECT body FROM state').get().body), state);
  db.close();
});
test('restoring an old export keeps historical principal even if current debt is smaller', t => {
  const { dir, path } = fixture(t, legacy());
  const store = createStore(path, { appVersion: '0.3.0' });
  const state = validateImport({ version: 1, ...legacy() });
  store.replace(state);
  assert.deepEqual(store.read().transactions, legacy().transactions);
  assert.equal(store.read().debts[0].balance, 100);
  assert.equal(readdirSync(join(dir, 'backups')).length, 2);
  store.db.close();
});
