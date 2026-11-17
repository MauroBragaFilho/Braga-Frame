'use strict';

/** features/proxy.js: quando o proxy é preciso, o que acontece com o erro do player, o progresso, a troca para a cópia leve e a troca de vídeo. */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const CODE = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'features', 'proxy.js'), 'utf8');
const tick = () => new Promise((resolve) => setImmediate(resolve));
const plain = (v) => JSON.parse(JSON.stringify(v));

function load({ info = { videoCodec: 'h264', audioCodec: 'aac' }, canPlay = '', ensure = { ok: true, state: 'running', proxyPath: 'C:\\c\\p.mp4', url: 'file:///C:/c/p.mp4' } } = {}) {
  const calls = [];
  const toasts = [];
  const logs = [];
  const listeners = {};
  const busListeners = {};
  const loads = [];
  const emitted = [];
  const video = {
    paused: true, listeners: {}, played: 0,
    canPlayType: () => canPlay,
    addEventListener(type, fn) { this.listeners[type] = fn; },
    play() { this.played += 1; return Promise.resolve(); }
  };
  const project = { source: { path: 'D:\\Lives\\a.mkv' } };
  const BF = {
    state: { project, info },
    player: { video, time: () => 12.5, seek(t) { loads.push(['seek', t]); }, load(url) { loads.push(['load', url]); }, unplayableMessage: 'NÃO TOCA.' },
    ui: { toast: (m, k) => toasts.push([m, k]), log: (m, k) => logs.push([m, k]) },
    bus: { on: (e, fn) => { busListeners[e] = fn; }, emit: (e, d) => emitted.push([e, d]) },
    on: (channel, fn) => { listeners[channel] = fn; },
    api: async (channel, payload) => { calls.push([channel, plain(payload)]); return channel === 'proxy:ensure' ? ensure : { ok: true }; }
  };
  vm.runInContext(CODE, vm.createContext({ window: { BF } }), { filename: 'proxy.js' });
  return { BF, calls, toasts, logs, listeners, busListeners, loads, emitted, video, project };
}

test('needed: áudio AC-3/DTS sempre; HEVC só quando o Chromium não toca; H.264 com AAC nunca', () => {
  const { BF } = load();
  const needed = BF.proxy.needed;
  assert.equal(needed({ videoCodec: 'h264', audioCodec: 'aac' }), false);
  assert.equal(needed({ videoCodec: 'h264', audioCodec: 'ac3' }), true);
  assert.equal(needed({ videoCodec: 'h264', audioCodec: 'DTS' }), true);
  assert.equal(needed({ videoCodec: 'hevc', audioCodec: 'aac' }, () => ''), true, 'HEVC sem decodificador');
  assert.equal(needed({ videoCodec: 'hevc', audioCodec: 'aac' }, () => 'probably'), false, 'HEVC que a máquina toca');
  assert.equal(needed({ videoCodec: 'hevc', audioCodec: 'aac' }), false, 'sem como perguntar ao player, não decide por HEVC');
  assert.equal(needed(null), false);
  assert.equal(needed({}), false);
});

test('erro do player: pede a cópia, avisa o que está acontecendo e devolve true (app.js não mostra a mensagem seca)', async () => {
  const t = load();
  assert.equal(t.BF.player.onUnplayable(), true);
  await tick();
  assert.deepEqual(t.calls, [['proxy:ensure', { path: 'D:\\Lives\\a.mkv' }]]);
  assert.match(t.toasts[0][0], /não toca no player do app\. Estou criando uma cópia leve/);
  assert.match(t.toasts[0][0], /exportação continuam usando o original/);
  assert.equal(t.BF.player.onUnplayable(), true, 'já rodando: continua tratado, sem pedir de novo');
  await tick();
  assert.equal(t.calls.length, 1);
});

test('progresso: a barra de estado mostra a porcentagem e o tempo restante; de outro vídeo é ignorado', async () => {
  const t = load();
  t.BF.player.onUnplayable();
  await tick();
  t.listeners['proxy:progress']({ path: 'D:\\Lives\\a.mkv', p: 0.42, etaSec: 130 });
  assert.match(t.logs.at(-1)[0], /Criando a cópia leve do vídeo para o player… 42% · cerca de 2 min restantes/);
  const n = t.logs.length;
  t.listeners['proxy:progress']({ path: 'D:\\Outro\\b.mkv', p: 0.9 });
  assert.equal(t.logs.length, n);
});

test('cópia pronta: o player troca para ela no mesmo instante e volta a tocar se estava tocando; o aviso diz que a exportação usa o original', async () => {
  const t = load();
  t.video.paused = false;
  t.BF.player.onUnplayable();
  await tick();
  t.listeners['proxy:done']({ path: 'D:\\Lives\\a.mkv', url: 'file:///C:/c/p.mp4' });
  assert.deepEqual(t.loads, [['load', 'file:///C:/c/p.mp4']]);
  t.video.listeners.loadedmetadata();
  assert.deepEqual(t.loads.at(-1), ['seek', 12.5]);
  assert.equal(t.video.played, 1);
  assert.equal(t.BF.proxy.state.using, true);
  assert.ok(t.emitted.some(([e, d]) => e === 'player:proxy' && d.using === true));
  assert.match(t.toasts.at(-1)[0], /cópia leve do vídeo, só para visualizar/);
  assert.equal(t.BF.player.onUnplayable(), false, 'o erro vindo da própria cópia cai na mensagem de sempre');
});

test('cópia que já existe no cache: ensure devolve pronta e o player troca na hora, sem aviso de espera', async () => {
  const t = load({ ensure: { ok: true, state: 'ready', proxyPath: 'C:\\c\\p.mp4', url: 'file:///C:/c/p.mp4' } });
  t.BF.player.onUnplayable();
  await tick();
  assert.deepEqual(t.loads, [['load', 'file:///C:/c/p.mp4']]);
  assert.ok(!t.toasts.some(([m]) => /Estou criando/.test(m)));
});

test('falha ao criar (sem FFmpeg, disco cheio…): mostra a causa junto da mensagem de sempre e não tenta de novo para este vídeo', async () => {
  const t = load({ ensure: { ok: false, code: 'NO_FFMPEG', message: 'O FFmpeg não foi encontrado.' } });
  assert.equal(t.BF.player.onUnplayable(), true);
  await tick();
  assert.match(t.toasts.at(-1)[0], /O FFmpeg não foi encontrado\. NÃO TOCA\./);
  assert.equal(t.toasts.at(-1)[1], 'error');
  assert.equal(t.BF.player.onUnplayable(), false, 'já falhou: o app.js mostra só a mensagem do player');
  const t2 = load();
  t2.BF.player.onUnplayable();
  await tick();
  t2.listeners['proxy:failed']({ path: 'D:\\Lives\\a.mkv', code: 'PROXY_FAILED', message: 'Não deu.' });
  assert.match(t2.toasts.at(-1)[0], /Não deu\. NÃO TOCA\./);
  assert.equal(t2.BF.player.onUnplayable(), false);
});

test('ao abrir o vídeo: codec que o Chromium não toca já pede a cópia (sem esperar o erro); codec comum não faz nada; trocar de vídeo cancela a anterior', async () => {
  const ac3 = load({ info: { videoCodec: 'h264', audioCodec: 'ac3' } });
  ac3.busListeners['project:loaded']();
  await tick();
  assert.deepEqual(ac3.calls.map(([c]) => c), ['proxy:ensure']);
  assert.match(ac3.toasts[0][0], /formato que o player do app não toca direito/);

  const hevc = load({ info: { videoCodec: 'hevc', audioCodec: 'aac' }, canPlay: '' });
  hevc.busListeners['project:loaded']();
  await tick();
  assert.deepEqual(hevc.calls.map(([c]) => c), ['proxy:ensure']);

  const fine = load({ info: { videoCodec: 'h264', audioCodec: 'aac' } });
  fine.busListeners['project:loaded']();
  await tick();
  assert.deepEqual(fine.calls, []);

  // trocar de vídeo com a cópia do anterior ainda rodando: pede o cancelamento e zera o estado
  ac3.busListeners['project:loaded']();
  await tick();
  assert.equal(ac3.calls.filter(([c]) => c === 'proxy:cancel').length, 1);
  assert.equal(ac3.BF.proxy.state.using, false);
});
