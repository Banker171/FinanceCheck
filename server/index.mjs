import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createStore } from './store.mjs';
import { createApp } from './app.mjs';

if (existsSync('.env')) process.loadEnvFile('.env');
const databasePath = process.env.FINANCECHECK_DB || 'data/financecheck.sqlite';
const store = createStore(databasePath === ':memory:' ? databasePath : resolve(databasePath));
const app = createApp(store, { aiKey: process.env.FINANCECHECK_AI_KEY, aiModel: process.env.FINANCECHECK_AI_MODEL || 'gpt-4.1-mini' });
const port = Number(process.env.PORT || 3001);
const server = app.listen(port, process.env.HOST || '127.0.0.1', () => console.log(`FinanceCheck listening on port ${port}. Database ready. AI: ${process.env.FINANCECHECK_AI_KEY ? 'configured' : 'local rules'}.`));
function stop() { server.close(() => { store.db.close(); process.exit(0); }); }
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
