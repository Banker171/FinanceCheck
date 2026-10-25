import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../server/store.mjs';
import { createApp } from '../server/app.mjs';

async function fixture(t, options = {}) {
  const store = createStore(':memory:');
  const server = createApp(store, options).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); store.db.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (path, method = 'GET', body) => {
    const r = await fetch(base + '/api' + path, { method, headers: body !== undefined ? { 'Content-Type': 'application/json' } : {}, body: body !== undefined ? JSON.stringify(body) : undefined });
    return { status: r.status, data: await r.json() };
  };
  return { store, base, call };
}
test('profile, debt payment split, deletion, export and reset work through HTTP', async t => {
  const { call } = await fixture(t);
  let { data } = await call('/state');
  assert.equal(data.profile.monthlyIncome, 0);
  let r = await call('/profile', 'PUT', { ...data.profile, monthlyIncome: 50000, essentials: 20000, initialBalance: 20000, reserveBalance: 5000 });
  assert.equal(r.status, 200);
  r = await call('/debts', 'POST', { name: 'Банк', balance: 10000, apr: 12, payment: 1000, dueDay: 28 });
  const debtId = r.data.debts[0].id;
  r = await call('/transactions', 'POST', { type: 'expense', amount: 1000, principal: 900, debtId, date: new Date().toISOString().slice(0, 10), category: 'Платеж', note: '900 долг, 100 проценты' });
  assert.equal(r.status, 201);
  assert.equal(r.data.debts[0].balance, 9100);
  assert.equal(r.data.analysis.totalBalance, 19000);
  assert.equal(r.data.analysis.spendable, 14000);
  const txId = r.data.transactions[0].id;
  r = await call('/transactions/' + txId, 'DELETE', {});
  assert.equal(r.data.debts[0].balance, 10000);
  assert.equal(r.data.analysis.totalBalance, 20000);
  r = await call('/export');
  assert.equal(r.data.version, 1);
  assert.equal(r.data.debts.length, 1);
  assert.equal((await call('/reset', 'POST', {})).status, 400);
  r = await call('/reset', 'POST', { confirm: 'УДАЛИТЬ' });
  assert.equal(r.data.debts.length, 0);
  assert.equal(r.data.profile.monthlyIncome, 0);
});
test('reject invalid money, invalid date, future operations and impossible principal', async t => {
  const { call } = await fixture(t);
  const { data } = await call('/state');
  assert.equal((await call('/profile', 'PUT', { ...data.profile, monthlyIncome: -1 })).status, 400);
  assert.equal((await call('/profile', 'PUT', { ...data.profile, strategy: 'unknown' })).status, 400);
  const debt = await call('/debts', 'POST', { name: 'Кредит', balance: 100, apr: 0, payment: 10, dueDay: 31 });
  const tx = { type: 'expense', amount: 10, principal: 0, date: '2026-02-30', category: 'Продукты', note: '' };
  assert.equal((await call('/transactions', 'POST', tx)).status, 400);
  assert.equal((await call('/transactions', 'POST', { ...tx, date: '2999-01-01' })).status, 400);
  assert.equal((await call('/transactions', 'POST', { ...tx, date: '2026-01-01', amount: -10 })).status, 400);
  assert.equal((await call('/transactions', 'POST', { ...tx, date: '2026-01-01', debtId: debt.data.debts[0].id, principal: 11 })).status, 400);
  assert.equal((await call('/transactions', 'POST', { ...tx, date: '2026-01-01', amount: 0.001 })).status, 400);
  assert.equal((await call('/profile', 'PUT', null)).status, 400);
});
test('balance reconciliation prevents reversal of older principal against updated balance', async t => {
  const { call } = await fixture(t);
  let r = await call('/debts', 'POST', { name: 'Кредит', balance: 1000, apr: 0, payment: 100, dueDay: 10 });
  const d = r.data.debts[0];
  r = await call('/transactions', 'POST', { type: 'expense', amount: 100, principal: 100, debtId: d.id, date: '2026-01-01', category: 'Долг', note: '' });
  const id = r.data.transactions[0].id;
  await call('/debts/' + d.id, 'PUT', { ...d, balance: 750 });
  r = await call('/transactions/' + id, 'DELETE', {});
  assert.equal(r.data.debts[0].balance, 750);
});
test('editing a debt name does not stop ordinary payment reversal', async t => {
  const { call } = await fixture(t);
  const r = await call('/debts', 'POST', { name: 'Кредит', balance: 1000, apr: 0, payment: 100, dueDay: 10 });
  const d = r.data.debts[0];
  const payment = await call('/transactions', 'POST', { type: 'expense', amount: 100, principal: 100, debtId: d.id, date: '2026-01-01', category: 'Долг', note: '' });
  await call('/debts/' + d.id, 'PUT', { ...d, name: 'Новое имя', balance: 900 });
  const result = await call('/transactions/' + payment.data.transactions[0].id, 'DELETE', {});
  assert.equal(result.data.debts[0].balance, 1000);
});
test('demo does not overwrite user data and deleting a debt preserves expenses', async t => {
  const { call } = await fixture(t);
  let r = await call('/demo', 'POST', {});
  assert.equal(r.status, 200);
  assert.ok(r.data.transactions.length > 0);
  assert.equal((await call('/demo', 'POST', {})).status, 409);
  const count = r.data.transactions.length;
  r = await call('/debts/' + r.data.debts[0].id, 'DELETE', {});
  assert.equal(r.data.transactions.length, count);
});
test('cross-site mutation and non-JSON request are rejected', async t => {
  const { base } = await fixture(t);
  const r = await fetch(base + '/api/demo', { method: 'POST', headers: { Origin: 'https://malicious.example', 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(r.status, 403);
  assert.equal((await fetch(base + '/api/reset', { method: 'POST', body: 'confirm=УДАЛИТЬ' })).status, 415);
});
test('local analyst works without any provider calls; consent is required even with a key', async t => {
  let called = false;
  const { call } = await fixture(t, { aiKey: 'test-only', fetchImpl: async () => { called = true; throw Error(); } });
  const r = await call('/analyst', 'POST', { question: 'Как быть?', consent: false });
  assert.equal(r.status, 200);
  assert.equal(r.data.mode, 'local');
  assert.equal(called, false);
  assert.match(r.data.answer, /профиля/);
});
test('AI sends only aggregates and the question, with provider storage disabled', async t => {
  let payload;
  const { call, store } = await fixture(t, { aiKey: 'test-only', fetchImpl: async (_url, options) => {
    payload = JSON.parse(options.body);
    return { ok: true, json: async () => ({ choices: [{ message: { content: 'Проверенный тестовый ответ' } }] }) };
  } });
  const state = store.read();
  state.profile.name = 'SECRET_NAME';
  state.transactions.push({ type: 'expense', amount: 10, date: '2026-01-01', category: 'SECRET_CATEGORY', note: 'SECRET_NOTE' });
  state.debts.push({ id: 'd', name: 'SECRET_BANK', balance: 100, apr: 10, payment: 10, dueDay: 10 });
  store.write(state);
  const r = await call('/analyst', 'POST', { question: 'Мой план?', consent: true });
  assert.equal(r.data.mode, 'ai');
  assert.equal(payload.store, false);
  assert.doesNotMatch(JSON.stringify(payload), /SECRET_/);
  assert.match(JSON.stringify(payload), /Мой план/);
});
test('provider failure has a usable local fallback and leaks no provider details', async t => {
  const { call } = await fixture(t, { aiKey: 'test-only', fetchImpl: async () => { throw Error('SECRET_CREDENTIAL'); } });
  const r = await call('/analyst', 'POST', { question: 'Мой план?', consent: true });
  assert.equal(r.status, 502);
  assert.ok(r.data.fallback);
  assert.doesNotMatch(JSON.stringify(r.data), /SECRET_CREDENTIAL/);
});
test('SQLite data survives closing and reopening the database', () => {
  const directory = mkdtempSync(join(tmpdir(), 'financecheck-test-'));
  const path = join(directory, 'state.sqlite');
  try {
    let store = createStore(path);
    const state = store.read(); state.profile.name = 'Тест сохранения';
    store.write(state); store.db.close();
    store = createStore(path);
    assert.equal(store.read().profile.name, 'Тест сохранения');
    store.db.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
test('what-if calculations do not change the saved profile', async t => {
  const { call } = await fixture(t);
  const original = (await call('/state')).data;
  await call('/profile', 'PUT', { ...original.profile, monthlyIncome: 50000, essentials: 20000 });
  const scenario = await call('/scenario', 'POST', { monthlyIncome: 40000, essentials: 15000 });
  assert.equal(scenario.status, 200);
  assert.equal(scenario.data.surplus, 25000);
  assert.equal(scenario.data.scenarios.length, 3);
  const after = (await call('/state')).data;
  assert.equal(after.profile.monthlyIncome, 50000);
  assert.equal(after.profile.essentials, 20000);
  assert.equal((await call('/scenario', 'POST', { monthlyIncome: -1, essentials: 0 })).status, 400);
});
test('desktop API requires its private session token and can refresh AI config', async t => {
  let current = { aiKey: '', aiModel: 'test-model' };
  const { base } = await fixture(t, { authToken: 'private-session-token', getAiConfig: () => current });
  const request = headers => fetch(base + '/api/state', { headers });
  assert.equal((await request({})).status, 401);
  assert.equal((await request({ 'X-FinanceCheck-Token': 'wrong' })).status, 401);
  let response = await request({ 'X-FinanceCheck-Token': 'private-session-token' });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('Content-Security-Policy'), /frame-ancestors 'none'/);
  let data = await response.json();
  assert.equal(data.ai.desktop, true);
  assert.equal(data.ai.enabled, false);
  current = { aiKey: 'test-only', aiModel: 'changed-model' };
  data = await (await request({ 'X-FinanceCheck-Token': 'private-session-token' })).json();
  assert.equal(data.ai.enabled, true);
  assert.equal(data.ai.model, 'changed-model');
  assert.equal(JSON.stringify(data).includes('test-only'), false);
});
