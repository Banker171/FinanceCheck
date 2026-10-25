import test from 'node:test';
import assert from 'node:assert/strict';
import { analyze, project, dateAtDay, defaultProfile } from '../server/finance.mjs';

const profile = overrides => ({ ...defaultProfile, monthlyIncome: 10000, essentials: 4000, initialBalance: 10000, ...overrides });
const debt = overrides => ({ id: 'd1', name: 'Кредит', balance: 12000, apr: 0, payment: 1000, dueDay: 15, ...overrides });
const state = (p, debts = [], transactions = []) => ({ profile: p, debts, transactions, monthlyPlans: { '2026-10': { income: p.monthlyIncome, payday: p.payday ?? 10 } } });

test('zero interest debt is repaid exactly with monthly allocations conserved', () => {
  const result = project(profile({ reserveMonths: 1 }), [debt()]);
  assert.equal(result.debtFreeMonth, 3);
  assert.equal(result.interest, 0);
  assert.equal(result.points.at(-1).debt, 0);
  assert.equal(result.points.at(-1).reserve, 4000);
  const a = result.firstAllocation;
  assert.equal(a.minimum + a.extra + a.reserve + a.unallocated, 6000);
});
test('interest accrues before payment and extra allocation targets higher APR first', () => {
  const p = profile({ monthlyIncome: 5000, essentials: 4000, reserveBalance: 4000, reserveMonths: 1 });
  const result = project(p, [debt({ balance: 1000, apr: 120, payment: 100 })], 'debt');
  assert.equal(result.interest, 110);
  assert.equal(result.debtFreeMonth, 2);
  assert.equal(result.points[1].debt, 100);
});
test('avalanche reduces interest compared with snowball for differing balances', () => {
  const debts = [debt({ id: 'large', balance: 50000, apr: 48 }), debt({ id: 'small', balance: 5000, apr: 5 })];
  const p = profile({ monthlyIncome: 12000, reserveBalance: 12000 });
  assert.ok(project(p, debts).interest < project({ ...p, method: 'snowball' }, debts).interest);
});
test('budget deficit prevents fabricated payoff dates', () => {
  const result = project(profile({ monthlyIncome: 4500 }), [debt()]);
  assert.equal(result.reason, 'deficit');
  assert.equal(result.debtFreeMonth, null);
  assert.equal(result.firstAllocation, null);
});
test('without debts all available funds go to reserve, not just the strategy share', () => {
  const result = project(profile({ reserveMonths: 3 }), []);
  assert.equal(result.reserveReadyMonth, 2);
  assert.equal(result.firstAllocation.reserve, 6000);
  assert.equal(result.debtFreeMonth, 0);
});
test('reaching reserve target redirects all surplus toward debt', () => {
  const p = profile({ reserveBalance: 12000 });
  const result = project(p, [debt()]);
  assert.equal(result.firstAllocation.reserve, 0);
  assert.equal(result.firstAllocation.extra, 5000);
  assert.equal(result.debtFreeMonth, 2);
});
test('income and expenses change cash, reserve allocation is not an expense', () => {
  const a = analyze(state(profile({ reserveBalance: 3000 }), [], [
    { type: 'income', amount: 0.1, date: '2026-10-01', category: 'Доход' },
    { type: 'income', amount: 0.2, date: '2026-10-01', category: 'Доход' },
    { type: 'expense', amount: 2000, date: '2026-10-02', category: 'Жилье' },
  ]), new Date('2026-10-03T12:00:00Z'));
  assert.equal(a.totalBalance, 8000.3);
  assert.equal(a.spendable, 5000.3);
  assert.equal(a.monthIncome, 0.3);
  assert.equal(a.monthExpense, 2000);
  assert.equal(a.reserveDays, 22);
});
test('calendar clamps dates and never invents income for an unfilled month', () => {
  assert.equal(dateAtDay(2026, 1, 31).toISOString().slice(0, 10), '2026-02-28');
  assert.equal(dateAtDay(2028, 1, 31).toISOString().slice(0, 10), '2028-02-29');
  const s = state(profile());
  s.monthlyPlans = { '2026-02': { income: 10000, payday: 31 } };
  const a = analyze(s, new Date('2026-02-28T09:00:00Z'));
  assert.equal(a.nextIncome, '2026-02-28');
  assert.equal(a.events.some(e => e.type === 'income' && e.date.startsWith('2026-03')), false);
});
test('partial debt payment is not subtracted twice from current balance', () => {
  const a = analyze(state(profile({ payday: 28 }), [debt({ balance: 50, payment: 100, dueDay: 27 })], [
    { type: 'expense', amount: 50, principal: 50, debtId: 'd1', date: '2026-10-20', category: 'Долг' },
  ]), new Date('2026-10-25T12:00:00Z'));
  assert.equal(a.events.find(e => e.date === '2026-10-27').amount, 50);
  assert.equal(a.beforeIncome, 50);
});
test('unrecorded past payment stays visible and triggers warning', () => {
  const a = analyze(state(profile(), [debt()]), new Date('2026-10-25T12:00:00Z'));
  assert.equal(a.events.find(e => e.date === '2026-10-15').overdue, true);
  assert.ok(a.warnings.some(w => w.includes('прошедшие даты')));
});
test('non-amortizing debt has no guaranteed payoff and stops at horizon', () => {
  const result = project(profile({ monthlyIncome: 5000, reserveBalance: 12000 }), [debt({ balance: 10000, payment: 1000, apr: 120 })]);
  assert.equal(result.debtFreeMonth, null);
  assert.equal(result.reason, 'horizon');
  assert.equal(result.months, 600);
});
test('scenario projections never mutate their source objects', () => {
  const p = profile(), debts = [debt()];
  const before = JSON.stringify({ p, debts });
  project(p, debts);
  assert.equal(JSON.stringify({ p, debts }), before);
});
test('completed goals leave the monthly surplus unallocated', () => {
  const result = project(profile({ reserveBalance: 12000 }), []);
  assert.equal(result.firstAllocation.unallocated, 6000);
  assert.equal(result.months, 0);
});
test('actual income reduces remaining scheduled income and is not added to the plan', () => {
  const s = state(profile({ initialBalance: 5000, monthlyIncome: 50000, payday: 28 }), [], [
    { type: 'income', amount: 20000, date: '2026-10-10', category: 'Зарплата' },
  ]);
  const a = analyze(s, new Date('2026-10-25T12:00:00Z'));
  assert.equal(a.plannedIncome, 50000);
  assert.equal(a.totalBalance, 25000);
  assert.equal(a.events.find(e => e.type === 'income').amount, 30000);
  assert.equal(a.nextIncome, '2026-10-28');
});
test('a new month stays unset instead of copying the previous income or treating it as zero', () => {
  const a = analyze(state(profile()), new Date('2026-11-01T00:00:00Z'));
  assert.equal(a.plannedIncome, null);
  assert.equal(a.surplus, null);
  assert.equal(a.forecast.reason, 'missing-income');
  assert.equal(a.nextIncome, null);
  assert.equal(a.dailyBudget, null);
});
test('known monthly income changes are used and projections stop at the first gap', () => {
  const s = state(profile(), [debt()]);
  s.monthlyPlans['2026-11'] = { income: 5000, payday: 10 };
  let a = analyze(s, new Date('2026-10-01T00:00:00Z'));
  assert.equal(a.forecast.months, 2);
  assert.equal(a.forecast.reason, 'missing-income');
  assert.equal(a.forecast.points.at(-1).debt, 7000);
  s.monthlyPlans['2026-11'].income = 20000;
  a = analyze(s, new Date('2026-10-01T00:00:00Z'));
  assert.equal(a.forecast.debtFreeMonth, 2);
  assert.equal(a.forecast.points.at(-1).debt, 0);
});
test('zero surplus in one known month does not hide a later larger income', () => {
  const p = profile();
  const s = state(p);
  s.monthlyPlans = { '2026-10': { income: 4000, payday: 10 }, '2026-11': { income: 20000, payday: 10 } };
  const a = analyze(s, new Date('2026-10-01T00:00:00Z'));
  assert.equal(a.forecast.reserveReadyMonth, 2);
});
