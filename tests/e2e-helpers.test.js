'use strict';

/**
 * Testes dos utilitários dos e2e (tests/e2e/helpers.js) que lidam com a limpeza: no Windows os processos auxiliares do
 * Electron seguram a pasta do perfil por alguns segundos depois que o app fecha (EPERM/EBUSY), e a limpeza antiga (10 x 300 ms)
 * desistia e deixava uma pasta bf-e2e-* para trás ou reprovava um teste que já tinha passado.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const h = require('./e2e/helpers');

const HOLD_SECONDS = 6;

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'bf-helpers-')); }

/** Processo que segura `dir` como pasta atual (impede apagá-la) por `seconds`; `citeDir` põe o caminho na linha de comando. */
function holder(dir, seconds, citeDir) {
  const code = `setTimeout(() => {}, ${seconds * 1000}); process.on('SIGTERM', () => process.exit(0));`;
  const args = ['-e', code, ...(citeDir ? [dir] : [])];
  return spawn(process.execPath, args, { cwd: dir, stdio: 'ignore', windowsHide: true });
}

const alive = (proc) => proc.exitCode === null && proc.signalCode === null;
const killQuietly = (proc) => { try { execFileSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch { /* já saiu */ } };
const exited = (proc) => new Promise((resolve) => { if (!alive(proc)) resolve(); else proc.once('exit', resolve); });

test('removeDir apaga a pasta normalmente e aceita pasta que não existe', () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, 'a', 'b'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'a', 'b', 'x.txt'), 'x');
  assert.equal(h.removeDir(dir), true);
  assert.equal(fs.existsSync(dir), false);
  assert.equal(h.removeDir(dir), true, 'já removida: nada a fazer');
});

test('removeDir encerra o processo auxiliar que ainda cita a pasta e termina de apagar (o que deixava bf-e2e-* para trás)', { skip: process.platform !== 'win32' ? 'cenário do Windows (pasta em uso)' : false }, async () => {
  const dir = tmp();
  const proc = holder(dir, 60, true);
  try {
    await new Promise((resolve) => setTimeout(resolve, 600));
    assert.ok(alive(proc));
    assert.throws(() => fs.rmSync(dir, { recursive: true, force: true }), /EPERM|EBUSY|ENOTEMPTY/, 'sanidade: com o processo vivo a pasta não pode ser apagada');
    const t0 = Date.now();
    assert.equal(h.removeDir(dir), true);
    assert.ok(Date.now() - t0 < 25000, `demorou ${Date.now() - t0} ms`);
    assert.equal(fs.existsSync(dir), false);
    await exited(proc);
    assert.equal(alive(proc), false, 'o processo que segurava a pasta foi encerrado');
  } finally { killQuietly(proc); fs.rmSync(dir, { recursive: true, force: true }); }
});

test(`removeDir espera por mais tempo que as 10 tentativas de 300 ms antigas quando o processo some sozinho (${HOLD_SECONDS} s)`, { skip: process.platform !== 'win32' ? 'cenário do Windows (pasta em uso)' : false }, async () => {
  const dir = tmp();
  const proc = holder(dir, HOLD_SECONDS, false); // não cita a pasta: só dá para esperar
  try {
    await new Promise((resolve) => setTimeout(resolve, 400));
    // as 10 tentativas de 300 ms feitas à mão: o recuo do próprio rmSync cresce a cada tentativa e no Node 24 já passa dos 6 s
    let lastErr = null;
    for (let i = 0; i < 10; i++) {
      try { fs.rmSync(dir, { recursive: true, force: true }); lastErr = null; break; }
      catch (e) { lastErr = e; Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300); }
    }
    assert.ok(lastErr && /EPERM|EBUSY|ENOTEMPTY/.test(lastErr.code || lastErr.message), 'a limpeza antiga (10 tentativas de 300 ms) desistia aqui');
    assert.equal(h.removeDir(dir), true);
    assert.equal(fs.existsSync(dir), false);
  } finally { killQuietly(proc); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('removeDir que não consegue apagar dentro do prazo AVISA e devolve false, sem lançar erro nem reprovar o teste', { skip: process.platform !== 'win32' ? 'cenário do Windows (pasta em uso)' : false }, async () => {
  const dir = tmp();
  const proc = holder(dir, 30, false);
  const warnings = [];
  const originalWarn = console.warn;
  try {
    await new Promise((resolve) => setTimeout(resolve, 400));
    console.warn = (...args) => warnings.push(args.join(' '));
    assert.equal(h.removeDir(dir, { timeoutMs: 1500 }), false);
  } finally { console.warn = originalWarn; killQuietly(proc); }
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /não foi possível remover/);
  await exited(proc);
  assert.equal(h.removeDir(dir), true, 'com o processo encerrado a limpeza funciona');
});

test('processesUsing acha só os processos que citam o caminho', { skip: process.platform !== 'win32' ? 'usa o Windows' : false }, async () => {
  const dir = tmp();
  const other = tmp();
  const mine = holder(dir, 30, true);
  const unrelated = holder(other, 30, false);
  try {
    await new Promise((resolve) => setTimeout(resolve, 600));
    const found = h.processesUsing(dir);
    assert.deepEqual(found.map((p) => p.pid), [mine.pid]);
    assert.deepEqual(h.processesUsing(path.join(dir, 'nao-existe-nesta-pasta')), []);
  } finally { killQuietly(mine); killQuietly(unrelated); await Promise.all([exited(mine), exited(unrelated)]); h.removeDir(dir); h.removeDir(other); }
});
