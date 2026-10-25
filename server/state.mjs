import { defaultProfile } from './finance.mjs';

export const SCHEMA_VERSION = 2;
export const monthKey = (date = new Date()) => date.toISOString().slice(0, 7);
export function emptyState() {
  return { schemaVersion: SCHEMA_VERSION, profile: { ...defaultProfile }, monthlyPlans: {}, debts: [], transactions: [] };
}
export function migrateState(input, now = new Date()) {
  if (!input || typeof input !== 'object' || !input.profile || !Array.isArray(input.debts) || !Array.isArray(input.transactions)) throw Error('Некорректный формат финансовых данных.');
  if (input.schemaVersion !== undefined && (!Number.isInteger(input.schemaVersion) || input.schemaVersion < 1 || input.schemaVersion > SCHEMA_VERSION)) throw Error('Эта база создана более новой или неподдерживаемой версией программы. Данные не изменены.');
  if (input.schemaVersion === SCHEMA_VERSION) {
    if (!input.monthlyPlans || typeof input.monthlyPlans !== 'object' || Array.isArray(input.monthlyPlans)) throw Error('Некорректный формат месячных доходов.');
    return structuredClone(input);
  }
  const state = structuredClone(input);
  state.schemaVersion = SCHEMA_VERSION;
  state.monthlyPlans = {};
  // A legacy recurring amount belongs only to the month of this one-time migration.
  // Missing future months remain unknown; they never inherit this value.
  if (Number.isFinite(state.profile.monthlyIncome) && state.profile.monthlyIncome > 0) {
    state.monthlyPlans[monthKey(now)] = { income: state.profile.monthlyIncome, payday: state.profile.payday || 10 };
  }
  delete state.profile.monthlyIncome;
  delete state.profile.payday;
  state.profile = { ...defaultProfile, ...state.profile };
  return state;
}
