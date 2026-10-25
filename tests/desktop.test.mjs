import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDesktopSettings } from '../desktop/settings.mjs';

// Exercise the storage contract separately from platform-specific Windows DPAPI.
const safeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: text => Buffer.from(text.split('').reverse().join('')),
  decryptString: buffer => buffer.toString().split('').reverse().join(''),
};
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'financecheck-settings-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
test('desktop key is protected through safeStorage and never returned to renderer', t => {
  const dir = fixture(t), settings = createDesktopSettings(dir, safeStorage);
  const result = settings.save({ model: 'gpt-4.1-mini', key: 'test-credential-value' });
  assert.equal(result.configured, true);
  assert.equal('aiKey' in result, false);
  assert.equal(readFileSync(join(dir, 'ai-key.bin'), 'utf8').includes('test-credential-value'), false);
  assert.equal(createDesktopSettings(dir, safeStorage).config().aiKey, 'test-credential-value');
  settings.save({ model: 'other-model' });
  assert.equal(settings.config().aiKey, 'test-credential-value');
  assert.equal(settings.config().aiModel, 'other-model');
  settings.save({ model: 'gpt-4.1-mini', removeKey: true });
  assert.equal(settings.publicSettings().configured, false);
  assert.equal(existsSync(join(dir, 'ai-key.bin')), false);
});
test('desktop refuses to save plaintext when secure storage is unavailable', t => {
  const dir = fixture(t);
  const settings = createDesktopSettings(dir, { isEncryptionAvailable: () => false });
  assert.throws(() => settings.save({ model: 'gpt-4.1-mini', key: 'test-key' }), /недоступно/);
  assert.equal(existsSync(join(dir, 'ai-key.bin')), false);
  assert.equal(settings.publicSettings().configured, false);
});
test('invalid desktop settings cannot overwrite an existing key', t => {
  const settings = createDesktopSettings(fixture(t), safeStorage);
  settings.save({ model: 'gpt-4.1-mini', key: 'existing-key' });
  assert.throws(() => settings.save({ model: '', key: 'replacement' }));
  assert.throws(() => settings.save({ model: 'valid-model', key: 123 }));
  assert.equal(settings.config().aiKey, 'existing-key');
});
