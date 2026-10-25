import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { defaultProfile, round } from './finance.mjs';
import { emptyState, migrateState, monthKey } from './state.mjs';

export function createStore(path, { now = new Date(), appVersion } = {}) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS state (id INTEGER PRIMARY KEY CHECK (id = 1), body TEXT NOT NULL)');
  const empty = () => ({ ...emptyState(), ...(appVersion ? { appVersion } : {}) });
  if (!db.prepare('SELECT id FROM state WHERE id=1').get()) db.prepare('INSERT INTO state VALUES (1, ?)').run(JSON.stringify(empty()));
  const read = () => JSON.parse(db.prepare('SELECT body FROM state WHERE id=1').get().body);
  const write = state => db.prepare('UPDATE state SET body=? WHERE id=1').run(JSON.stringify(state));
  const backup = (reason, state = read()) => {
    if (path === ':memory:') return null;
    const directory = join(dirname(path), 'backups');
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const name = `${new Date().toISOString().replace(/[:.]/g, '-')}-${reason}-${randomUUID()}.json`;
    writeFileSync(join(directory, name), JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), ...state }, null, 2), { flag: 'wx', mode: 0o600 });
    return name;
  };
  try {
    db.exec('BEGIN IMMEDIATE');
    const original = read();
    const state = migrateState(original, now);
    if (original.schemaVersion !== state.schemaVersion || (appVersion && original.appVersion !== appVersion)) {
      // A JSON snapshot includes the entire single-row application state, including data still in WAL.
      // If the backup cannot be written, rollback rather than upgrade without a recoverable copy.
      backup('before-upgrade', original);
      if (appVersion) state.appVersion = appVersion;
      write(state);
    }
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); db.close(); throw error; }
  const replace = state => {
    db.exec('BEGIN IMMEDIATE');
    try {
      backup('before-restore');
      if (appVersion) state.appVersion = appVersion;
      write(state);
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  };
  return { db, read, write, empty, backup, replace, id: randomUUID };
}

export function demoState(now = new Date()) {
  const year = now.getUTCFullYear(), month = now.getUTCMonth();
  const date = day => new Date(Date.UTC(year, month, Math.min(day, now.getUTCDate()))).toISOString().slice(0, 10);
  return {
    schemaVersion: 2,
    profile: { ...defaultProfile, name: 'Александр', essentials: 43000, initialBalance: 48500, reserveBalance: 25000 },
    monthlyPlans: { [monthKey(now)]: { income: 95000, payday: 28 } },
    debts: [
      { id: 'demo-credit', name: 'Потребительский кредит', balance: 245000, apr: 24.9, payment: 12500, dueDay: 27 },
      { id: 'demo-card', name: 'Кредитная карта', balance: 68000, apr: 39.9, payment: 4500, dueDay: 30 },
    ],
    transactions: [
      { id: 'demo-1', type: 'income', amount: 47500, category: 'Зарплата', date: date(10), note: 'Первая часть зарплаты', debtId: null, principal: 0 },
      { id: 'demo-2', type: 'expense', amount: 23000, category: 'Жилье', date: date(11), note: 'Аренда квартиры', debtId: null, principal: 0 },
      { id: 'demo-3', type: 'expense', amount: 4250, category: 'Продукты', date: date(15), note: 'Продукты на неделю', debtId: null, principal: 0 },
      { id: 'demo-4', type: 'expense', amount: 1800, category: 'Транспорт', date: date(18), note: 'Проезд', debtId: null, principal: 0 },
      { id: 'demo-5', type: 'expense', amount: 1690, category: 'Здоровье', date: date(20), note: 'Аптека', debtId: null, principal: 0 },
      { id: 'demo-6', type: 'expense', amount: 890, category: 'Отдых', date: date(22), note: 'Кофе и прогулка', debtId: null, principal: 0 },
    ],
  };
}

export function validateProfile(body) {
  const p = { ...body };
  if (typeof p.name !== 'string' || p.name.length > 80) throw Error('Имя: не более 80 символов.');
  for (const key of ['essentials', 'initialBalance', 'reserveBalance']) {
    if (!Number.isFinite(p[key]) || p[key] < 0 || p[key] > 1e9) throw Error('Суммы должны быть от 0 до 1 млрд ₽.');
    p[key] = round(p[key]);
  }
  if (!Number.isInteger(p.reserveMonths) || p.reserveMonths < 1 || p.reserveMonths > 24) throw Error('Цель подушки: от 1 до 24 месяцев.');
  if (!['debt', 'balanced', 'reserve'].includes(p.strategy)) throw Error('Неизвестный сценарий.');
  if (!['avalanche', 'snowball'].includes(p.method)) throw Error('Неизвестный метод погашения.');
  return Object.fromEntries(Object.keys(defaultProfile).map(k => [k, p[k]]));
}

export function validateMonthPlan(month, body) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw Error('Некорректный месяц.');
  if (!Number.isFinite(body.income) || body.income < 0 || body.income > 1e9) throw Error('Суммы дохода должны быть от 0 до 1 млрд ₽.');
  if (!Number.isInteger(body.payday) || body.payday < 1 || body.payday > 31) throw Error('День дохода должен быть от 1 до 31.');
  return { income: round(body.income), payday: body.payday };
}

export function validateImport(input) {
  if (!input || input.version !== 1) throw Error('Некорректный файл: используйте JSON-экспорт FinanceCheck.');
  const state = migrateState(input);
  state.profile = validateProfile(state.profile);
  if (state.debts.length > 200 || state.transactions.length > 10000 || Object.keys(state.monthlyPlans).length > 2400) throw Error('Слишком много записей в файле.');
  const ids = new Set();
  const id = value => {
    if (typeof value !== 'string' || !/^[a-zA-Z0-9._:-]{1,100}$/.test(value) || ids.has(value)) throw Error('Некорректные или повторяющиеся идентификаторы в файле.');
    ids.add(value); return value;
  };
  state.monthlyPlans = Object.fromEntries(Object.entries(state.monthlyPlans).map(([month, plan]) => [month, validateMonthPlan(month, plan)]));
  state.debts = state.debts.map(d => ({ id: id(d.id), ...validateDebt(d) }));
  // Historical principal is checked against the payment, not today's already-reduced debt balance.
  const historical = { debts: state.debts.map(d => ({ ...d, balance: 1e9 })) };
  state.transactions = state.transactions.map(t => ({ id: id(t.id), ...validateTransaction(t, historical), ...(t.principalReconciled === true ? { principalReconciled: true } : {}) }));
  delete state.version;
  delete state.exportedAt;
  return state;
}

export function validateDebt(b) {
  if (typeof b.name !== 'string' || !b.name.trim() || b.name.length > 100) throw Error('Укажите название долга (до 100 символов).');
  for (const k of ['balance', 'apr', 'payment']) if (!Number.isFinite(b[k]) || b[k] < 0 || b[k] > (k === 'apr' ? 1000 : 1e9)) throw Error('Проверьте сумму, ставку и платеж.');
  if (b.balance > 0 && b.payment <= 0) throw Error('Укажите минимальный ежемесячный платеж.');
  if (!Number.isInteger(b.dueDay) || b.dueDay < 1 || b.dueDay > 31) throw Error('День платежа должен быть от 1 до 31.');
  return { name: b.name.trim(), balance: round(b.balance), apr: round(b.apr), payment: round(b.payment), dueDay: b.dueDay };
}

export function validateTransaction(b, state) {
  if (!['income', 'expense'].includes(b.type)) throw Error('Неизвестный тип операции.');
  if (!Number.isFinite(b.amount) || b.amount <= 0 || b.amount > 1e9) throw Error('Сумма операции должна быть положительной и не больше 1 млрд ₽.');
  if (typeof b.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(b.date) || !Number.isFinite(Date.parse(b.date)) || new Date(b.date).toISOString().slice(0, 10) !== b.date) throw Error('Некорректная дата.');
  if (b.date > new Date().toISOString().slice(0, 10)) throw Error('Для будущих платежей используйте календарь. Операции отражают уже совершенные действия.');
  if (typeof b.category !== 'string' || !b.category.trim() || b.category.length > 60 || typeof b.note !== 'string' || b.note.length > 500) throw Error('Проверьте категорию и комментарий.');
  const debt = b.debtId ? state.debts.find(d => d.id === b.debtId) : null;
  if (b.debtId && (!debt || b.type !== 'expense')) throw Error('Платеж можно привязать только к существующему долгу.');
  const principal = debt ? b.principal : 0;
  if (!Number.isFinite(principal) || principal < 0 || principal > b.amount || (debt && principal > debt.balance)) throw Error('Погашение основного долга не может превышать платеж или остаток долга.');
  if (round(b.amount) <= 0) throw Error('Минимальная сумма — 0,01 ₽.');
  return { type: b.type, amount: round(b.amount), date: b.date, category: b.category.trim(), note: b.note.trim(), debtId: debt?.id || null, principal: round(principal) };
}
