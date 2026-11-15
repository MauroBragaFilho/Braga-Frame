'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const { setupSingleInstance, focusWindow } = require('../src/singleInstance');

function fakeApp(hasLock) {
  const app = new EventEmitter();
  app.calls = { lock: 0, quit: 0 };
  app.requestSingleInstanceLock = () => { app.calls.lock += 1; return hasLock; };
  app.quit = () => { app.calls.quit += 1; };
  return app;
}

function fakeWindow({ minimized = false, visible = true, destroyed = false } = {}) {
  const calls = [];
  return {
    calls,
    isDestroyed: () => destroyed,
    isMinimized: () => minimized,
    isVisible: () => visible,
    restore() { calls.push('restore'); minimized = false; },
    show() { calls.push('show'); visible = true; },
    focus() { calls.push('focus'); }
  };
}

test('sem a trava (já existe uma instância neste perfil): encerra e não segue', () => {
  const app = fakeApp(false);
  let focused = 0;
  assert.equal(setupSingleInstance(app, () => { focused += 1; }), false);
  assert.deepEqual(app.calls, { lock: 1, quit: 1 });
  assert.equal(app.listenerCount('second-instance'), 0, 'quem não é a principal não escuta nada');
  app.emit('second-instance');
  assert.equal(focused, 0);
});

test('com a trava: segue, e uma segunda tentativa de abrir traz a janela para a frente', () => {
  const app = fakeApp(true);
  const win = fakeWindow({ minimized: true });
  assert.equal(setupSingleInstance(app, () => focusWindow(win)), true);
  assert.equal(app.calls.quit, 0);
  app.emit('second-instance', {}, ['app.exe'], 'C:\\');
  assert.deepEqual(win.calls, ['restore', 'focus'], 'minimizada: restaura e foca');
  app.emit('second-instance');
  assert.deepEqual(win.calls, ['restore', 'focus', 'focus'], 'já restaurada: só foca');
});

test('focusWindow: janela escondida aparece; sem janela ou destruída não faz nada nem lança erro', () => {
  const hidden = fakeWindow({ visible: false });
  assert.equal(focusWindow(hidden), true);
  assert.deepEqual(hidden.calls, ['show', 'focus']);
  assert.equal(focusWindow(null), false);
  assert.equal(focusWindow(fakeWindow({ destroyed: true })), false);
});

test('um erro ao focar a janela não derruba o app', () => {
  const app = fakeApp(true);
  setupSingleInstance(app, () => { throw new Error('janela inválida'); });
  assert.doesNotThrow(() => app.emit('second-instance'));
});

test('o main.js liga a trava antes de criar a janela (nada de whenReady fora do ramo da instância principal)', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.match(main, /setupSingleInstance\(app,/);
  assert.ok(main.indexOf('setupSingleInstance(app,') < main.indexOf('app.whenReady()'), 'a trava vem antes de whenReady');
  assert.match(main, /if \(setupSingleInstance\(app[^)]*\)[^{]*\) \{\s*app\.whenReady\(\)/s, 'whenReady só dentro do ramo em que a trava foi obtida');
});
