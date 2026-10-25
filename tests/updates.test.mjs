import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createUpdateController, validateTestFeed } from '../desktop/updates.mjs';

function fixture(options = {}) {
  const client = new EventEmitter();
  const calls = [];
  client.checkForUpdates = async () => { calls.push('check'); client.emit('update-not-available'); };
  client.quitAndInstall = (silent, restart) => calls.push(['install', silent, restart]);
  const controller = createUpdateController({ client, enabled: true, version: '0.4.0', beforeInstall: () => calls.push('backup'), ...options });
  return { client, controller, calls };
}
test('installed updates are automatic to download, require confirmation to install and never downgrade', async () => {
  const { client, controller } = fixture();
  assert.equal(client.autoDownload, true);
  assert.equal(client.autoInstallOnAppQuit, false);
  assert.equal(client.allowDowngrade, false);
  assert.equal(client.allowPrerelease, false);
  await controller.check();
  assert.equal(controller.getState().status, 'current');
});
test('download progress and ready state come only from updater events', async () => {
  const { client, controller, calls } = fixture();
  client.checkForUpdates = async () => {
    client.emit('update-available', { version: '0.4.1' });
    client.emit('download-progress', { percent: 43.5 });
    assert.equal(controller.getState().percent, 43.5);
    return { downloadPromise: Promise.resolve().then(() => client.emit('update-downloaded', { version: '0.4.1' })) };
  };
  await controller.check();
  assert.equal(controller.getState().status, 'ready');
  assert.equal(controller.getState().availableVersion, '0.4.1');
  assert.equal(controller.getState().percent, 100);
  assert.equal(calls.length, 0, 'No installation without an explicit install call');
});
test('unavailable or corrupt downloads never become installable and error details are sanitized', async () => {
  const { client, controller, calls } = fixture();
  client.checkForUpdates = async () => ({ downloadPromise: Promise.reject(Error('Private provider URL or credential must not leak')) });
  await controller.check();
  assert.equal(controller.getState().status, 'error');
  assert.doesNotMatch(controller.getState().error, /Private provider/);
  await controller.install();
  assert.equal(calls.length, 0);
});
test('a backup is completed before a single silent install and restart', async () => {
  const { client, controller, calls } = fixture();
  client.emit('update-downloaded', { version: '0.4.1' });
  await Promise.all([controller.install(), controller.install()]);
  assert.deepEqual(calls, ['backup', ['install', true, true]]);
  assert.equal(controller.getState().status, 'installing');
});
test('backup failure blocks installation and allows retry without losing a verified download', async () => {
  let fail = true;
  const { client, controller, calls } = fixture({ beforeInstall: () => { if (fail) throw Error('disk full'); calls.push('backup'); } });
  client.emit('update-downloaded', { version: '0.4.1' });
  await controller.install();
  assert.equal(controller.getState().status, 'ready');
  assert.match(controller.getState().error, /резервную копию/);
  assert.equal(calls.length, 0);
  fail = false;
  await controller.install();
  assert.deepEqual(calls, ['backup', ['install', true, true]]);
});
test('simultaneous checks do not start duplicate downloads', async () => {
  const { client, controller, calls } = fixture();
  let complete;
  client.checkForUpdates = () => { calls.push('check'); return new Promise(resolve => { complete = resolve; }); };
  const first = controller.check();
  await controller.check();
  assert.equal(calls.length, 1);
  complete(); await first;
});
test('an installer error reported by the updater allows a later install retry', async () => {
  const { client, controller, calls } = fixture();
  client.emit('update-downloaded', { version: '0.4.1' });
  client.quitAndInstall = () => client.emit('error', Error('Installer launch failed'));
  await controller.install();
  assert.equal(controller.getState().status, 'error');
  client.quitAndInstall = () => calls.push('retry-installed');
  client.emit('update-downloaded', { version: '0.4.1' });
  await controller.install();
  assert.ok(calls.includes('retry-installed'));
});
test('portable and development modes never contact the update server', async () => {
  const { controller, calls } = fixture({ enabled: false, unavailableReason: 'Use installed Windows version' });
  assert.equal(controller.getState().status, 'unsupported');
  await controller.check(); await controller.install();
  assert.equal(calls.length, 0);
});
test('test feed is limited to loopback and cannot be replaced with an external HTTP source', () => {
  assert.equal(validateTestFeed('http://127.0.0.1:12345/updates/'), 'http://127.0.0.1:12345/updates/');
  for (const url of ['http://example.com/updates/', 'https://example.com/updates/', 'file:///tmp/updates', 'http://user:secret@127.0.0.1:1234/']) assert.throws(() => validateTestFeed(url));
});
