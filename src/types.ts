export type Profile = { name: string; monthlyIncome: number; essentials: number; initialBalance: number; payday: number; reserveBalance: number; reserveMonths: number; strategy: string; method: string };
export type Debt = { id: string; name: string; balance: number; apr: number; payment: number; dueDay: number };
export type Transaction = { id: string; type: 'income' | 'expense'; amount: number; category: string; date: string; note: string; debtId: string | null; principal: number; principalReconciled?: boolean };
export type Projection = { strategy: string; debtFreeMonth: number | null; reserveReadyMonth: number | null; interest: number; months: number; reason: string | null; points: { month: number; debt: number; reserve: number }[]; firstAllocation: { minimum: number; extra: number; reserve: number; unallocated: number } | null };
export type Analysis = { today: string; totalBalance: number; debtTotal: number; minimumPayments: number; surplus: number; spendable: number; reserveTarget: number; reserveDays: number | null; monthIncome: number; monthExpense: number; nextIncome: string; daysUntilIncome: number; beforeIncome: number; available: number; dailyBudget: number; categories: Record<string, number>; events: { id: string; date: string; title: string; amount: number; type: string; overdue?: boolean }[]; scenarios: Projection[]; forecast: Projection; warnings: string[] };
export type State = { profile: Profile; debts: Debt[]; transactions: Transaction[]; analysis: Analysis; ai: { enabled: boolean; model: string | null; desktop?: boolean } };
export type DesktopSettings = { configured: boolean; model: string; encryptionAvailable: boolean };
declare global {
  interface Window {
    financecheckDesktop?: {
      getSettings: () => Promise<DesktopSettings>;
      saveSettings: (input: { key?: string; model: string; removeKey?: boolean }) => Promise<DesktopSettings>;
      openDataFolder: () => Promise<void>;
      getVersion: () => Promise<string>;
    };
  }
}
