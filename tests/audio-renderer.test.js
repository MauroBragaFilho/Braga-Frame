'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createContext } = require('../src/ipc/context');

const ROOT = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');
const feature = read('renderer', 'features', 'audio.js');
const css = read('renderer', 'features', 'audio.css');
const coreFiles = ['audioFilter.js', 'audioHistory.js', 'measure.js'].map((f) => [`src/core/audio/${f}`, read('src', 'core', 'audio', f)]);
const handler = read('src', 'ipc', 'handlers', 'audio.js');

test('a aba registra id "audio", ordem 50 e título em português (arquitetura 1.4)', () => {
  assert.match(feature, /id: 'audio',/);
  assert.match(feature, /order: 50,/);
  assert.match(feature, /title: 'Áudio',/);
  assert.match(feature, /BF\.ui\.registerTab\(/);
});

test('respeita as regras do renderer: CSP, modais próprios, sem HTML solto, só BF.*', () => {
  assert.doesNotMatch(feature, /window\.confirm|\balert\(|window\.prompt/, 'modais só pelo BF.ui');
  assert.doesNotMatch(feature, /innerHTML|insertAdjacentHTML|document\.write/, 'texto sempre por textContent/el()');
  assert.doesNotMatch(feature, /setAttribute\(\s*['"]style|\.style\.|\bstyle:/, 'nada de estilo inline (CSP style-src self)');
  assert.doesNotMatch(css, /@import|url\(\s*['"]?https?:/, 'CSS local, sem recursos externos');
  assert.doesNotMatch(feature, /require\(|window\.bf\b|ipcRenderer/, 'só BF.*, nunca a ponte direta nem outra feature');
  assert.doesNotMatch(feature, /BF\.(cuts|export|queue|subtitles|analysis|sources|prefs\.set)\b/, 'não depende de outras features');
  assert.ok(css.length > 500, 'o CSS da aba existe');
});

test('usa a prévia real (Web Audio) e as regras do núcleo', () => {
  assert.match(feature, /createMediaElementSource\(BF\.player\.video\)/);
  assert.match(feature, /createGain\(\)/);
  assert.match(feature, /previewPlan\(/);
  assert.match(feature, /linearRampToValueAtTime|setValueAtTime/);
  assert.match(feature, /AF\.resolveAudio/);
  assert.match(feature, /BF\.project\.update\(/);
  assert.match(feature, /BF\.bus\.emit\('decision', \{ cutId: cut\.id, type: 'adjust'/);
  assert.match(feature, /BF\.bus\.on\('cut:selected'/);
  assert.match(feature, /BF\.api\('audio:measure'/);
});

test('todo canal IPC usado pela aba existe no handler (e o handler não registra outros)', () => {
  const used = [...feature.matchAll(/BF\.api\('([a-zA-Z]+:[a-zA-Z]+)'/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(used)], ['audio:measure']);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-audiorenderer-'));
  try {
    const handlers = new Map();
    const ctx = createContext({
      ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) },
      app: { getPath: () => dir, getVersion: () => '0' }, dialog: {}, shell: {}, getWindow: () => null,
      logger: { log() {}, info() {}, warn() {}, error() {} }, resolveTools: () => ({})
    });
    require('../src/ipc/handlers/audio').register(ctx);
    assert.deepEqual([...ctx.channels], ['audio:measure']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('escopo: só ajuste manual — nenhum filtro de tratamento automático em lugar nenhum do recurso', () => {
  const forbidden = /loudnorm|dynaudnorm|speechnorm|acompressor|compand|afftdn|anlmdn|arnndn|highpass|lowpass|equalizer|alimiter|agate|DynamicsCompressor|BiquadFilter|denois|noise ?reduc|melhoria de voz/i;
  const sources = [...coreFiles, ['renderer/features/audio.js', feature], ['src/ipc/handlers/audio.js', handler]];
  for (const [file, code] of sources) {
    // os comentários dizem o que NÃO existe; só o código conta
    const noComments = code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.doesNotMatch(noComments, forbidden, `${file} não pode tratar o áudio automaticamente`);
  }
  // o único filtro de exportação é volume/afade
  const { buildAudioFilter } = require('../src/core/audio/audioFilter');
  const all = buildAudioFilter({ gainDb: 3, fadeInSec: 1, fadeOutSec: 1, mute: false }, { duration: 10 });
  assert.deepEqual(all.split(',').map((f) => f.split('=')[0]), ['volume', 'afade', 'afade']);
});

test('nada do recurso escreve na fonte: o núcleo e o handler só leem (nenhuma escrita em disco)', () => {
  for (const [file, code] of [...coreFiles, ['src/ipc/handlers/audio.js', handler]]) {
    assert.doesNotMatch(code, /writeFile|appendFile|createWriteStream|renameSync|unlinkSync|rmSync|copyFile|truncate|\.rename\(|\.rm\(|\.unlink\(/, `${file} só lê`);
  }
  // o ffmpeg da medição não tem arquivo de saída
  assert.match(read('src', 'core', 'audio', 'measure.js'), /'-f', 'null', '-'/);
});

test('os arquivos universais funcionam como <script> comum (sem module/require) e expõem a mesma API', () => {
  const sandbox = { console };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  for (const file of ['audioFilter.js', 'audioHistory.js']) vm.runInContext(read('src', 'core', 'audio', file), sandbox, { filename: file });
  const cjsFilter = require('../src/core/audio/audioFilter');
  const cjsHistory = require('../src/core/audio/audioHistory');
  assert.deepEqual(Object.keys(sandbox.BFAudioFilter).sort(), Object.keys(cjsFilter).sort());
  assert.deepEqual(Object.keys(sandbox.BFAudioHistory).sort(), Object.keys(cjsHistory).sort());
  // e se comportam igual no navegador
  assert.equal(sandbox.BFAudioFilter.buildAudioFilter({ gainDb: 6, fadeOutSec: 1 }, { duration: 8 }), 'volume=6dB,afade=t=out:st=7:d=1');
  const r = sandbox.BFAudioHistory.applyChange({ gainDb: 0, mute: false, fadeInSec: 0, fadeOutSec: 0, history: [] }, { gainDb: 3 }, { now: 1 });
  assert.equal(r.audio.history.length, 1);
  assert.equal(sandbox.BFAudioHistory.undo(r.audio).audio.gainDb, 0);
});

test('o carregador da aba aponta para arquivos que existem', () => {
  const list = [...feature.matchAll(/'(\.\.\/src\/core\/audio\/[A-Za-z]+\.js)'/g)].map((m) => m[1]);
  assert.deepEqual(list, ['../src/core/audio/audioFilter.js', '../src/core/audio/audioHistory.js']);
  for (const rel of list) assert.ok(fs.existsSync(path.join(ROOT, 'renderer', rel)), `${rel} (relativo a renderer/index.html) não existe`);
});
