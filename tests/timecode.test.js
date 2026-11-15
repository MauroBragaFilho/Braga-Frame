'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { fmt, parseTime, secs } = require('../src/core/projects/timecode');

test('fmt: m:ss.d abaixo de 1 hora e h:mm:ss.d a partir dela (antes uma live de 3 h aparecia como "184:23.4")', () => {
  assert.equal(fmt(0), '0:00.0');
  assert.equal(fmt(3.2), '0:03.2');
  assert.equal(fmt(83.5), '1:23.5');
  assert.equal(fmt(3599.9), '59:59.9');
  assert.equal(fmt(3600), '1:00:00.0');
  assert.equal(fmt(3 * 3600 + 4 * 60 + 23.4), '3:04:23.4');
  assert.equal(fmt(10800), '3:00:00.0');
  assert.equal(fmt(3725.4), '1:02:05.4');
  assert.equal(fmt(36000), '10:00:00.0');
});

test('fmt: arredonda ANTES de separar minutos (nunca "0:60.0") e tolera entrada ruim', () => {
  assert.equal(fmt(59.96), '1:00.0');
  assert.equal(fmt(119.97), '2:00.0');
  assert.equal(fmt(3599.96), '1:00:00.0');
  assert.equal(fmt(-5), '0:00.0');
  assert.equal(fmt(NaN), '0:00.0');
  assert.equal(fmt(undefined), '0:00.0');
  assert.equal(fmt(null), '0:00.0');
  assert.equal(fmt('83.5'), '1:23.5');
  assert.equal(fmt(Infinity), '0:00.0');
});

test('parseTime: aceita h:mm:ss(.d), m:ss(.d), segundos, vírgula decimal; recusa o resto', () => {
  assert.equal(parseTime('3:04:23'), 3 * 3600 + 4 * 60 + 23);
  assert.equal(parseTime('1:05:30'), 3930, 'o caso do relatório: editar o fim de um corte de uma live com "1:05:30"');
  assert.equal(parseTime('1:02:03,5'), 3723.5);
  assert.equal(parseTime('0:00:07.25'), 7.25);
  assert.equal(parseTime('1:23.5'), 83.5);
  assert.equal(parseTime('1:23'), 83);
  assert.equal(parseTime('83,5'), 83.5);
  assert.equal(parseTime(' 83 '), 83);
  assert.equal(parseTime('0:99.0'), 99, 'segundos acima de 59 em "m:ss" continuam valendo (a interface confere o fim do vídeo)');
  for (const bad of ['', '   ', 'abc', '1:75:00', '-5', '1:2:3:4', '1::2', ':30', '1:', '1.2.3', '1e3', null, undefined]) {
    assert.ok(Number.isNaN(parseTime(bad)), `deveria recusar ${JSON.stringify(bad)}`);
  }
});

test('ida e volta: parseTime(fmt(x)) devolve x arredondado ao décimo, incluindo 59,96 e horas', () => {
  const samples = [0, 0.04, 0.05, 59.94, 59.96, 119.97, 3599.94, 3599.95, 3600, 3600.04, 3723.4, 11063.4, 36000, 86399.9, 123456.7];
  for (let i = 0; i < 400; i += 1) samples.push((i * 9973) % 400000 / 10 + (i % 7) / 100);
  for (const x of samples) {
    const text = fmt(x);
    assert.equal(Math.round(parseTime(text) * 10), Math.round(x * 10), `${x} -> ${text} -> ${parseTime(text)}`);
  }
});

test('fmt nunca produz segundos "60" nem minutos "60" ao lado de horas (varredura)', () => {
  for (let k = 0; k <= 400000; k += 7) {
    const text = fmt(k / 100);
    assert.doesNotMatch(text, /:60\.\d$/, `${k / 100} -> ${text}`);
    assert.doesNotMatch(text, /^\d+:60:/, `${k / 100} -> ${text}`);
  }
});

test('secs: duração por extenso com vírgula (pt-BR)', () => {
  assert.equal(secs(6), '6,0 s');
  assert.equal(secs(4.5), '4,5 s');
  assert.equal(secs(0), '0,0 s');
  assert.equal(secs(12.345, 2), '12,35 s');
  assert.equal(secs(NaN), '0,0 s');
  assert.equal(secs(undefined), '0,0 s');
});

test('carregado como <script> no renderer (sem module), expõe window.BFTime com o mesmo comportamento', () => {
  const code = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'projects', 'timecode.js'), 'utf8');
  const sandbox = {};
  vm.runInNewContext(code, sandbox);
  assert.ok(sandbox.BFTime, 'BFTime definido');
  assert.deepEqual(Object.keys(sandbox.BFTime).sort(), ['fmt', 'parseTime', 'secs']);
  assert.equal(sandbox.BFTime.fmt(3723.4), '1:02:03.4');
  assert.equal(sandbox.BFTime.parseTime('1:02:03.4'), 3723.4);
});
