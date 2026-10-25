import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

// Keys are encrypted with Electron safeStorage (Windows DPAPI), never embedded in the installer.
export function createDesktopSettings(directory, safeStorage) {
  mkdirSync(directory, { recursive: true });
  const keyFile = join(directory, 'ai-key.bin');
  const modelFile = join(directory, 'ai-settings.json');
  let aiKey = '', aiModel = 'gpt-4.1-mini';
  if (existsSync(modelFile)) {
    try { aiModel = JSON.parse(readFileSync(modelFile, 'utf8')).model || aiModel; } catch { /* Defaults remain usable after invalid settings. */ }
  }
  if (existsSync(keyFile) && safeStorage.isEncryptionAvailable()) {
    try { aiKey = safeStorage.decryptString(readFileSync(keyFile)); } catch { /* Never use or expose an undecryptable credential. */ }
  }
  const publicSettings = () => ({ configured: Boolean(aiKey), model: aiModel, encryptionAvailable: safeStorage.isEncryptionAvailable() });
  return {
    publicSettings,
    config: () => ({ aiKey, aiModel }),
    save(input) {
      if (!input || typeof input.model !== 'string' || !/^[a-zA-Z0-9._:-]{1,100}$/.test(input.model)) throw Error('Укажите корректное имя модели.');
      if (input.key !== undefined && (typeof input.key !== 'string' || input.key.length > 1000)) throw Error('Некорректный ключ.');
      if (input.key?.trim()) {
        if (!safeStorage.isEncryptionAvailable()) throw Error('Защищенное хранилище Windows недоступно. Ключ не сохранен.');
        writeFileSync(keyFile + '.tmp', safeStorage.encryptString(input.key.trim()), { mode: 0o600 });
        renameSync(keyFile + '.tmp', keyFile);
        aiKey = input.key.trim();
      } else if (input.removeKey) {
        if (existsSync(keyFile)) unlinkSync(keyFile);
        aiKey = '';
      }
      aiModel = input.model;
      writeFileSync(modelFile + '.tmp', JSON.stringify({ model: aiModel }), { mode: 0o600 });
      renameSync(modelFile + '.tmp', modelFile);
      return publicSettings();
    },
  };
}
