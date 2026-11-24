'use strict';

/** O canal timeline:export com o ctx de verdade (createContext) e um Electron falso: grava na pasta, nunca sobrescreve, recusa o que não dá. */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createContext } = require('../src/ipc/context');
const { loadHandlers } = require('../src/ipc');
const { safeName } = require('../src/ipc/handlers/timeline');

const silent = { log() {}, info() {}, warn() {}, error() {} };

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-timeline-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const handlers = new Map();
  const deps = {
    ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) },
    app: { getPath: () => path.join(dir, 'ud'), getVersion: () => '9.9.9', on() {} },
    dialog: {}, shell: {}, getWindow: () => ({ isDestroyed: () => false, webContents: { send() {} } }), logger: silent
  };
  const ctx = createContext(deps);
  assert.deepEqual(loadHandlers(ctx).failed, []);
  const out = path.join(dir, 'saida');
  fs.mkdirSync(out);
  const call = (payload) => handlers.get('timeline:export')({}, payload);
  return { dir, out, call, handlers };
}

const CUTS = [
  { id: 'a', title: 'Primeiro', start: 10, end: 20, status: 'approved', subtitles: { basedOn: { start: 10, end: 20 }, cues: [{ start: 1, end: 2, text: 'Olá' }], style: {} } },
  { id: 'b', title: 'Segundo', start: 40, end: 55.5, status: 'approved' },
  { id: 'c', title: 'Pendente', start: 70, end: 80, status: 'pending' }
];
const SOURCE = { path: path.join(os.tmpdir(), 'nao-existe.mp4'), duration: 300, fps: 30, width: 1920, height: 1080, hasAudio: true };

test('o canal carrega com os outros handlers', (t) => {
  assert.ok(setup(t).handlers.has('timeline:export'));
});

test('grava XML, EDL, tempos e legendas na pasta escolhida, só com os cortes aprovados', async (t) => {
  const s = setup(t);
  const res = await s.call({ cuts: CUTS, source: SOURCE, dir: s.out, name: 'Minha live' });
  assert.equal(res.ok, true);
  assert.deepEqual(res.files, ['Minha live.xml', 'Minha live.edl', 'Minha live - tempos.txt', 'Minha live.srt', 'Minha live.ass', 'Minha live - estilo da legenda.json']);
  assert.deepEqual(fs.readdirSync(s.out).sort(), [...res.files].sort());
  assert.equal(res.summary.clips, 2);
  assert.equal(res.summary.cues, 1);
  const xml = fs.readFileSync(path.join(s.out, 'Minha live.xml'), 'utf8');
  assert.match(xml, /^<\?xml version="1.0" encoding="UTF-8"\?>/);
  assert.ok(!xml.includes('Pendente'));
  assert.equal(fs.readFileSync(path.join(s.out, 'Minha live - tempos.txt'), 'utf8'), '00:00:10.000 -> 00:00:20.000\n00:00:40.000 -> 00:00:55.500\n');
});

test('nunca sobrescreve: com o nome já usado o conjunto inteiro ganha (2), inclusive o título dentro dos arquivos', async (t) => {
  const s = setup(t);
  const first = await s.call({ cuts: CUTS, source: SOURCE, dir: s.out, name: 'Live' });
  const before = fs.readFileSync(path.join(s.out, 'Live.xml'), 'utf8');
  const second = await s.call({ cuts: CUTS, source: SOURCE, dir: s.out, name: 'Live' });
  assert.equal(first.ok && second.ok, true);
  assert.ok(second.files.every((f) => f.startsWith('Live (2)')), second.files.join(', '));
  assert.equal(fs.readFileSync(path.join(s.out, 'Live.xml'), 'utf8'), before, 'o primeiro conjunto não foi tocado');
  assert.match(fs.readFileSync(path.join(s.out, 'Live (2).xml'), 'utf8'), /<sequence id="sequence-1">\s*<name>Live \(2\)<\/name>/);
  assert.match(fs.readFileSync(path.join(s.out, 'Live (2).edl'), 'utf8'), /^TITLE: Live \(2\)/);
  const third = await s.call({ cuts: CUTS, source: SOURCE, dir: s.out, name: 'Live' });
  assert.ok(third.files.every((f) => f.startsWith('Live (3)')));
});

test('formatos escolhidos, "todos" inclui pendentes e o nome é limpo', async (t) => {
  const s = setup(t);
  const res = await s.call({ cuts: CUTS, source: SOURCE, dir: s.out, name: 'a/b:c*?"<>|', formats: ['edl'], status: 'all' });
  assert.equal(res.ok, true);
  assert.deepEqual(res.files, ['a b c.edl']);
  assert.equal(res.summary.clips, 3);
  assert.equal(safeName('  '), 'Braga Frame');
  assert.equal(safeName('x'.repeat(200)).length, 80);
});

test('erros claros: sem cortes, sem aprovados, pasta que não existe ou relativa, formato inválido', async (t) => {
  const s = setup(t);
  const code = async (payload) => { const r = await s.call(payload); return r.ok === false ? r.code : 'ok'; };
  assert.equal(await code({ cuts: [], source: SOURCE, dir: s.out }), 'INVALID_ARGS');
  assert.equal(await code({ cuts: CUTS, source: {}, dir: s.out }), 'INVALID_ARGS');
  assert.equal(await code({ cuts: CUTS, source: SOURCE, dir: 'relativa' }), 'INVALID_ARGS');
  assert.equal(await code({ cuts: CUTS, source: SOURCE, dir: path.join(s.dir, 'nao-existe') }), 'INPUT_MISSING');
  assert.equal(await code({ cuts: CUTS, source: SOURCE, dir: path.join(s.dir, 'ud') + path.sep + 'x' }), 'INPUT_MISSING');
  assert.equal(await code({ cuts: CUTS, source: SOURCE, dir: s.out, formats: ['zip'] }), 'INVALID_ARGS');
  const none = await s.call({ cuts: [CUTS[2]], source: SOURCE, dir: s.out });
  assert.equal(none.ok, false);
  assert.equal(none.code, 'NO_CUTS');
  assert.match(none.message, /Nenhum corte aprovado/);
  assert.deepEqual(fs.readdirSync(s.out), [], 'nada foi gravado');
});
