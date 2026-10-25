import { defineConfig } from '@playwright/test';
import { existsSync } from 'node:fs';

const executablePath = process.env.CHROMIUM_PATH || (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined);
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 30000,
  use: { baseURL: 'http://127.0.0.1:3101', headless: true, launchOptions: { executablePath, args: ['--no-sandbox'] } },
  webServer: { command: 'npm run build && node server/index.mjs', url: 'http://127.0.0.1:3101/api/health', timeout: 60000, reuseExistingServer: false, env: { PORT: '3101', HOST: '127.0.0.1', FINANCECHECK_DB: ':memory:', FINANCECHECK_AI_KEY: '' } },
});
