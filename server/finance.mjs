export const round = n => Math.round((n + Number.EPSILON) * 100) / 100;
export const toCents = n => Math.round(n * 100);
export const fromCents = n => n / 100;
export const defaultProfile = {
  name: '', monthlyIncome: 0, essentials: 0, initialBalance: 0,
  payday: 10, reserveBalance: 0, reserveMonths: 3,
  strategy: 'balanced', method: 'avalanche',
};
export const shares = { debt: 0.1, balanced: 0.4, reserve: 0.8 };

export function dateAtDay(year, month, day) {
  return new Date(Date.UTC(year, month, Math.min(day, new Date(Date.UTC(year, month + 1, 0)).getUTCDate())));
}
const iso = date => date.toISOString().slice(0, 10);

export function project(profile, inputDebts, strategy = profile.strategy, limit = 600) {
  let debts = inputDebts.filter(d => d.balance > 0).map(d => ({ ...d, cents: toCents(d.balance) }));
  let reserve = toCents(profile.reserveBalance);
  const target = toCents(profile.essentials * profile.reserveMonths);
  const pool = toCents(profile.monthlyIncome) - toCents(profile.essentials);
  let interest = 0;
  let months = 0;
  let firstAllocation = null;
  const points = [{ month: 0, debt: fromCents(debts.reduce((s, d) => s + d.cents, 0)), reserve: fromCents(reserve) }];
  let debtFreeMonth = debts.length ? null : 0;
  let reserveReadyMonth = reserve >= target ? 0 : null;
  let reason = null;
  if (!debts.length && reserve >= target && pool >= 0) firstAllocation = { minimum: 0, extra: 0, reserve: 0, unallocated: fromCents(pool) };
  for (let month = 1; month <= limit && (debts.length || reserve < target); month++) {
    const minDue = debts.reduce((sum, d) => sum + Math.min(d.cents + Math.round(d.cents * d.apr / 1200), toCents(d.payment)), 0);
    if (pool < 0 || minDue > pool) { reason = 'deficit'; break; }
    let available = pool;
    let paid = 0;
    for (const debt of debts) {
      const added = Math.round(debt.cents * debt.apr / 1200);
      interest += added;
      debt.cents += added;
      const payment = Math.min(debt.cents, toCents(debt.payment));
      debt.cents -= payment;
      available -= payment;
      paid += payment;
    }
    debts = debts.filter(d => d.cents > 0);
    const saved = Math.min(Math.max(0, target - reserve), debts.length ? Math.round(available * shares[strategy]) : available);
    reserve += saved;
    available -= saved;
    debts.sort(profile.method === 'snowball' ? (a, b) => a.cents - b.cents : (a, b) => b.apr - a.apr || a.cents - b.cents);
    let extra = 0;
    for (const debt of debts) {
      const payment = Math.min(available, debt.cents);
      debt.cents -= payment;
      available -= payment;
      extra += payment;
    }
    // Redirect unused debt allocation to the reserve after the last debt is repaid.
    const finalSaving = Math.min(available, Math.max(0, target - reserve));
    reserve += finalSaving;
    available -= finalSaving;
    debts = debts.filter(d => d.cents > 0);
    if (!firstAllocation) firstAllocation = { minimum: fromCents(paid), extra: fromCents(extra), reserve: fromCents(saved + finalSaving), unallocated: fromCents(available) };
    months = month;
    if (!debts.length && debtFreeMonth === null) debtFreeMonth = month;
    if (reserve >= target && reserveReadyMonth === null) reserveReadyMonth = month;
    points.push({ month, debt: fromCents(debts.reduce((s, d) => s + d.cents, 0)), reserve: fromCents(reserve) });
    if (pool === 0 && (debts.length || reserve < target)) { reason = 'no-surplus'; break; }
  }
  if (!reason && (debts.length || reserve < target)) reason = 'horizon';
  return { strategy, debtFreeMonth, reserveReadyMonth, interest: fromCents(interest), months, points, firstAllocation, reason };
}

export function analyze(state, now = new Date()) {
  const { profile, debts, transactions } = state;
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const todayIso = iso(today);
  const monthStart = todayIso.slice(0, 7);
  const actual = transactions.filter(t => t.date <= todayIso);
  const monthTx = actual.filter(t => t.date.startsWith(monthStart));
  const totalBalance = fromCents(toCents(profile.initialBalance) + actual.reduce((s, t) => s + (t.type === 'income' ? 1 : -1) * toCents(t.amount), 0));
  const debtTotal = round(debts.reduce((s, d) => s + d.balance, 0));
  const minimumPayments = round(debts.filter(d => d.balance > 0).reduce((s, d) => s + Math.min(d.balance + round(d.balance * d.apr / 1200), d.payment), 0));
  const surplus = round(profile.monthlyIncome - profile.essentials - minimumPayments);
  let nextIncome = dateAtDay(today.getUTCFullYear(), today.getUTCMonth(), profile.payday);
  if (nextIncome <= today) nextIncome = dateAtDay(today.getUTCFullYear(), today.getUTCMonth() + 1, profile.payday);
  const events = [];
  for (const debt of debts.filter(d => d.balance > 0)) {
    for (let offset = 0; offset <= 1; offset++) {
      const date = dateAtDay(today.getUTCFullYear(), today.getUTCMonth() + offset, debt.dueDay);
      const paid = transactions.filter(t => t.debtId === debt.id && t.date.startsWith(iso(date).slice(0, 7)) && t.date <= todayIso).reduce((s, t) => s + toCents(t.amount), 0);
      const amount = round(Math.min(Math.max(0, debt.payment - fromCents(paid)), debt.balance + round(debt.balance * debt.apr / 1200)));
      if (amount > 0) events.push({ id: `${debt.id}-${iso(date)}`, date: iso(date), title: debt.name, amount, type: 'expense', overdue: date < today });
    }
  }
  events.push({ id: 'income', date: iso(nextIncome), title: 'Плановый доход', amount: profile.monthlyIncome, type: 'income' });
  events.sort((a, b) => a.date.localeCompare(b.date));
  const beforeIncome = round(events.filter(e => e.type === 'expense' && e.date <= iso(nextIncome)).reduce((s, e) => s + e.amount, 0));
  const spendable = round(totalBalance - profile.reserveBalance);
  const days = Math.max(1, Math.round((nextIncome - today) / 86400000));
  const available = round(spendable - beforeIncome);
  const categories = {};
  for (const t of monthTx.filter(t => t.type === 'expense')) categories[t.category] = round((categories[t.category] || 0) + t.amount);
  const scenarios = Object.keys(shares).map(strategy => project(profile, debts, strategy));
  const forecast = scenarios.find(s => s.strategy === profile.strategy);
  const warnings = [];
  if (events.some(e => e.overdue)) warnings.push('В текущем месяце есть прошедшие даты с незаписанными платежами. Уточните, оплачен ли долг: календарь не знает банковский статус и показывает возможный пропуск.');
  if (surplus < 0) warnings.push('Плановые доходы не покрывают необходимые расходы и минимальные платежи. Сначала нужно устранить ежемесячный дефицит.');
  if (available < 0) warnings.push('До следующего дохода может не хватить денег на платежи. Проверьте даты и суммы, свяжитесь с кредитором заранее, если платеж под угрозой.');
  if (profile.reserveBalance > totalBalance) warnings.push('Заявленный резерв превышает общий остаток денег. Уточните остатки или уменьшите сумму резерва.');
  if (debts.some(d => d.balance > 0 && d.payment <= round(d.balance * d.apr / 1200))) warnings.push('У одного из долгов минимальный платеж не превышает расчетные месячные проценты. Без дополнительных платежей долг может расти.');
  return {
    today: todayIso, totalBalance, debtTotal, minimumPayments, surplus, spendable,
    reserveTarget: round(profile.essentials * profile.reserveMonths),
    reserveDays: profile.essentials ? Math.floor(profile.reserveBalance / profile.essentials * 30) : null,
    monthIncome: round(monthTx.filter(t => t.type === 'income').reduce((s, t) => s + t.amount, 0)),
    monthExpense: round(monthTx.filter(t => t.type === 'expense').reduce((s, t) => s + t.amount, 0)),
    nextIncome: iso(nextIncome), daysUntilIncome: days, beforeIncome, available,
    dailyBudget: round(Math.max(0, available) / days), categories, events, scenarios, forecast, warnings,
  };
}

export function localAdvice(analysis, profile) {
  const money = n => new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'RUB', maximumFractionDigits: 0 }).format(n);
  if (!profile.monthlyIncome && !profile.essentials) return 'Начните с финансового профиля: укажите ожидаемый доход, необходимые расходы и текущий остаток. Затем добавьте долги. Это позволит рассчитать реалистичный план.';
  const parts = [];
  if (analysis.warnings.length) parts.push(...analysis.warnings);
  parts.push(`После необходимых расходов и минимальных платежей по плану остается ${money(analysis.surplus)} в месяц.`);
  if (analysis.forecast.firstAllocation) {
    const a = analysis.forecast.firstAllocation;
    parts.push(`В первом месяце выбранный сценарий направляет ${money(a.reserve)} в подушку и ${money(a.extra)} на досрочное погашение сверх минимальных платежей.`);
  }
  if (analysis.reserveDays !== null) parts.push(`Текущий резерв покрывает примерно ${analysis.reserveDays} дней необходимых расходов. Цель — ${profile.reserveMonths} мес. (${money(analysis.reserveTarget)}).`);
  if (analysis.forecast.debtFreeMonth !== null && analysis.debtTotal > 0) parts.push(`При неизменных доходах, расходах и ставках расчетный срок погашения долгов — ${analysis.forecast.debtFreeMonth} мес.`);
  if (analysis.forecast.reason === 'horizon') parts.push('В горизонте 50 лет полная цель не достигается. Сравните другие сценарии или пересмотрите план.');
  parts.push('Проверьте суммы по банковским выпискам: прогноз использует ежемесячное начисление процентов, без комиссий, штрафов и льготных периодов.');
  return parts.join('\n\n');
}
