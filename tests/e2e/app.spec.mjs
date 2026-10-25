import { test, expect } from '@playwright/test';

test.beforeEach(async ({ request }) => {
  const r = await request.post('/api/reset', { data: { confirm: 'УДАЛИТЬ' } });
  expect(r.ok()).toBeTruthy();
});

test('user configures profile, adds debt and a split payment, then reloads', async ({ page }) => {
  await page.goto('/');
  await page.locator('.welcome-banner').getByRole('button', { name: 'Настроить профиль', exact: true }).click();
  await page.getByLabel('Как к вам обращаться').fill('Мария');
  await page.getByLabel('Плановый доход в месяц, ₽', { exact: true }).fill('80000');
  await page.getByLabel('Необходимые расходы в месяц, ₽', { exact: false }).fill('35000');
  await page.getByLabel('Начальный общий остаток, ₽', { exact: false }).fill('40000');
  await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Изменения сохранены');
  await page.getByRole('button', { name: 'Мои долги', exact: true }).click();
  await page.getByRole('button', { name: 'Добавить долг', exact: true }).first().click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Название долга').fill('Тестовый кредит');
  await dialog.getByLabel('Текущий остаток основного долга, ₽').fill('100000');
  await dialog.getByLabel('Годовая ставка, %').fill('20');
  await dialog.getByLabel('Минимальный платеж, ₽').fill('5000');
  await dialog.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.getByRole('heading', { name: 'Тестовый кредит' })).toBeVisible();
  await page.getByRole('button', { name: 'Операции', exact: true }).click();
  await page.getByRole('button', { name: 'Добавить операцию', exact: true }).click();
  await dialog.getByLabel('Сумма, ₽', { exact: true }).fill('5000');
  await dialog.getByLabel('Связать с долгом').selectOption({ label: 'Тестовый кредит' });
  await dialog.getByLabel('Из платежа в погашение основного долга, ₽', { exact: false }).fill('3500');
  await dialog.getByLabel('Комментарий', { exact: false }).fill('Проверка платежа');
  await dialog.getByRole('button', { name: 'Добавить операцию', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.getByText('Проверка платежа', { exact: true })).toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: 'Мои долги', exact: true }).click();
  await expect(page.locator('.debt-amount')).toContainText(/96\s?500/);
  await page.getByRole('button', { name: 'Обзор', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Мария');
  await expect(page.locator('.stat-card').first()).toContainText(/35\s?000/);
});

test('demo, reserve scenarios, local analyst and export are usable', async ({ page }) => {
  await page.goto('/');
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Посмотреть демо' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Александр');
  await expect(page.locator('.forecast-chart')).toBeVisible();
  await page.screenshot({ path: '/tmp/financecheck-desktop.png', fullPage: true });
  await page.getByRole('button', { name: 'Финансовая подушка', exact: true }).click();
  await page.locator('.scenario').last().getByRole('button', { name: 'Выбрать сценарий' }).click();
  await expect(page.locator('.scenario.chosen')).toContainText('Укрепить подушку');
  await page.getByLabel('Доход в сценарии, ₽ / мес.').fill('85000');
  await page.getByRole('button', { name: 'Рассчитать', exact: true }).click();
  await expect(page.locator('.what-if-result')).toContainText('После расходов и минимальных платежей');
  await expect(page.locator('.what-if-result tbody tr')).toHaveCount(3);
  await page.getByRole('button', { name: 'Финансовый аналитик', exact: false }).click();
  await page.getByRole('button', { name: 'Объясни мой план на месяц' }).click();
  await expect(page.locator('.chat-message.assistant')).toContainText('После необходимых расходов');
  await expect(page.locator('.answer-label')).toContainText('Разбор по правилам');
  await page.getByRole('button', { name: 'Настройки', exact: true }).click();
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('link', { name: 'Скачать данные' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('financecheck-export.json');
});

test('mobile navigation and modal work without horizontal overflow', async ({ page, request }) => {
  await request.post('/api/demo', { data: {} });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Александр');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
  await page.screenshot({ path: '/tmp/financecheck-mobile.png', fullPage: true });
  await page.getByRole('button', { name: 'Добавить операцию', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await page.getByRole('button', { name: 'Финансовая подушка', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Выберите свой темп' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
});
